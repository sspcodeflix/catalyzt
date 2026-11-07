/**
 * Stories in the dummy Jira: validation, and the Story refiner agent.
 * The refiner makes acceptance criteria clear and testable without adding requirements;
 * it uses DeepSeek when configured and simple rules otherwise.
 */
import { checkInput, type Policy } from '../src/lib/guardrails';
import { components as knownComponents } from '../src/lib/data';
import { completeJson, type DeepSeekConfig, type Usage } from './deepseek';
import { STATUSES, STORY_TYPES, type NewStory, type RefinementOutput } from './db';

export class StoryError extends Error {
  constructor(
    message: string,
    readonly policy?: Policy,
  ) {
    super(message);
  }
}

/** Story text goes to a model when refined, so it gets the guards that matter for that. */
const STORY_POLICIES = ['secret-in-input', 'prompt-injection', 'too-long'] as const;

function guard(...texts: string[]) {
  const g = checkInput(texts.join('\n'), [...STORY_POLICIES]);
  if (!g.allowed) throw new StoryError(g.policy.message, g.policy);
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "write as it is": one criterion per line, bullets and numbering optional. */
export function splitCriteria(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(/\r?\n/)
    .map((l) => clean(l.replace(/^\s*(?:[-*•]|\d+[.)]|ac\s*\d+\s*[:.)-]?)\s*/i, '')))
    .filter(Boolean)
    .filter((l) => {
      const k = l.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

export interface StoryInput {
  summary: string;
  description: string;
  acceptanceCriteria: string;
}

export function parseStoryInput(b: unknown, createdBy: string): NewStory {
  const r = (b ?? {}) as Record<string, unknown>;
  const summary = clean(String(r.summary ?? '')).slice(0, 200);
  const description = String(r.description ?? '').trim().slice(0, 4000);
  const acText = Array.isArray(r.acceptanceCriteria) ? (r.acceptanceCriteria as unknown[]).map(String).join('\n') : String(r.acceptanceCriteria ?? '');
  const acceptanceCriteria = splitCriteria(acText).slice(0, 30).map((c) => c.slice(0, 400));
  if (!summary) throw new StoryError('Add a summary.');
  if (acceptanceCriteria.length === 0) throw new StoryError('Add at least one acceptance criterion.');
  guard(summary, description, acceptanceCriteria.join('\n'));

  const type = STORY_TYPES.includes(r.type as never) ? (r.type as NewStory['type']) : 'Story';
  const status = STATUSES.includes(r.status as never) ? (r.status as NewStory['status']) : 'Ready for UAT';
  const components = (Array.isArray(r.components) ? r.components : []).filter((c): c is string => knownComponents.includes(c as string));
  const o = r.original as Record<string, unknown> | null | undefined;
  return {
    summary,
    description,
    type,
    status,
    fixVersion: clean(String(r.fixVersion ?? '')).slice(0, 20),
    components,
    acceptanceCriteria,
    original: o ? { summary: String(o.summary ?? '').slice(0, 200), description: String(o.description ?? '').slice(0, 4000), acceptanceCriteria: String(o.acceptanceCriteria ?? '').slice(0, 8000) } : null,
    refinementId: Number.isInteger(r.refinementId) ? (r.refinementId as number) : null,
    createdBy,
  };
}

const VAGUE: [RegExp, string][] = [
  [/\b(fast|quick(ly)?|slow|responsive|performant)\b/i, 'how fast, measured how?'],
  [/\b(user-?friendly|intuitive|easy|simple|nice|clean)\b/i, 'what would a tester check to call it that?'],
  [/\b(etc\.?|and so on|and more)\b/i, 'list the remaining cases explicitly.'],
  [/\b(properly|correctly|appropriate(ly)?|as expected|should work)\b/i, 'what is the expected result?'],
  [/\b(some|several|many|a few|most)\b/i, 'how many exactly?'],
];

/** Rules-only refinement: tidy, split, de-duplicate and flag vague wording. Never adds content. */
export function refineByRules(input: StoryInput): RefinementOutput {
  const criteria = splitCriteria(input.acceptanceCriteria).map((c) => cap(c).replace(/[.;]+$/, ''));
  const questions: string[] = [];
  criteria.forEach((c, i) => {
    for (const [re, q] of VAGUE) {
      const m = re.exec(c);
      if (m) {
        questions.push(`AC${i + 1} says "${m[0]}": ${q}`);
        break;
      }
    }
  });
  if (criteria.length === 0) questions.push('Add at least one acceptance criterion.');
  return {
    summary: cap(clean(input.summary).replace(/[.]+$/, '')),
    description: clean(input.description),
    acceptanceCriteria: criteria,
    questions,
  };
}

function refineMessages(input: StoryInput) {
  const system = `You refine Jira stories for a QA team. Reply with json only.
Rules:
- Keep the author's meaning. Never add requirements, numbers, limits or behaviour they did not write.
- Summary: one short line, user-facing, no trailing full stop.
- Description: one to three plain sentences, or empty if the author gave none.
- Acceptance criteria: each one a single testable behaviour with an observable result, in plain language. Split criteria that check two things. Remove duplicates.
- Where something is vague or missing (a number, a limit, an error message), do not guess: add a short question to "questions" instead.
Return exactly this json shape:
{"summary":"Partial refunds for card payments","description":"Merchants can refund part of a settled card payment.","acceptance_criteria":["A merchant can refund part of a settled card payment","A refund above the original amount is rejected with an error message"],"questions":["What error message should a refund above the original amount show?"]}`;
  const user = `Summary:\n${input.summary}\n\nDescription:\n${input.description || '(none)'}\n\nAcceptance criteria as written:\n${input.acceptanceCriteria}`;
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

const strs = (v: unknown, n: number, len: number) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(clean).filter(Boolean).slice(0, n).map((x) => x.slice(0, len)) : [];

/** Story refiner agent. Returns the refinement and where it came from; the caller stores it. */
export async function refineStory(
  b: unknown,
  cfg: DeepSeekConfig | null,
  signal?: AbortSignal,
): Promise<{
  input: StoryInput;
  output: RefinementOutput;
  source: 'model' | 'rules';
  model: string | null;
  note?: string;
  /** Set when the model was called, for the token ledger. */
  call?: { status: 'ok' | 'error' | 'stopped'; usage: Usage | null; latencyMs: number };
}> {
  const r = (b ?? {}) as Record<string, unknown>;
  const input: StoryInput = {
    summary: String(r.summary ?? '').slice(0, 200),
    description: String(r.description ?? '').slice(0, 4000),
    acceptanceCriteria: String(r.acceptanceCriteria ?? '').slice(0, 8000),
  };
  if (!clean(input.summary) && !clean(input.acceptanceCriteria)) throw new StoryError('Write a summary or some acceptance criteria to refine.');
  guard(input.summary, input.description, input.acceptanceCriteria);

  if (cfg) {
    const t0 = performance.now();
    let usage: Usage | null = null;
    const call = (status: 'ok' | 'error' | 'stopped') => ({ status, usage: usage as Usage | null, latencyMs: performance.now() - t0 });
    try {
      const raw = (await completeJson(cfg, refineMessages(input), signal, (u) => (usage = u))) as Record<string, unknown> | null;
      const ac = strs(raw?.acceptance_criteria, 30, 400);
      const summary = clean(String(raw?.summary ?? '')).slice(0, 200);
      if (raw && summary && ac.length > 0) {
        return {
          input,
          source: 'model',
          model: cfg.intentModel,
          call: call('ok'),
          output: { summary, description: clean(String(raw.description ?? '')).slice(0, 4000), acceptanceCriteria: ac, questions: strs(raw.questions, 8, 300) },
        };
      }
      return { input, output: refineByRules(input), source: 'rules', model: null, call: call('ok'), note: "DeepSeek's answer was unusable, so Horizon tidied it with rules." };
    } catch (e) {
      if (signal?.aborted) throw e;
      return { input, output: refineByRules(input), source: 'rules', model: null, call: call('error'), note: `DeepSeek failed (${(e as Error).message}), so Horizon tidied it with rules.` };
    }
  }
  return { input, output: refineByRules(input), source: 'rules', model: null, note: 'DeepSeek is not configured, so Horizon tidied it with rules.' };
}
