/**
 * Intent: what the user wants Horizon to do. Shared by the browser and the server-side API layer.
 * The model proposes it; the server validates it (validateIntent); the user's explicit choices
 * in the composer always win over the model.
 */
import { findTickets } from './testType';
import type { Capability, TestType } from './types';

export const CAPABILITIES: Capability[] = ['analysis', 'authoring', 'execution', 'cloudops', 'security'];

export interface Intent {
  capability: Capability;
  testType: TestType | null;
  /** Short plain-language description, e.g. "Check whether PAY-1482 is ready for UAT". */
  action: string;
  tickets: string[];
  components: string[];
  /** 0 to 1. Below the clarify threshold Horizon asks instead of guessing. */
  confidence: number;
  /** Set when Horizon should ask before doing anything. */
  question: string | null;
  options: string[];
  /** Where the intent came from: the model, or the rules when the model is unavailable. */
  source: 'model' | 'rules';
}

/** What the composer knows before the model runs. `fixed*` values are user choices and are never overridden. */
export interface IntentRequest {
  text: string;
  tickets: string[];
  components: string[];
  fixedCapability: Capability | null;
  fixedTestType: TestType | null;
  /** The rules' guess, given to the model as a hint. */
  rulesTestType: TestType | null;
  /** Earlier turns, newest last, for context. Text only. */
  history: { role: 'user' | 'assistant'; text: string }[];
}

export const CLARIFY_BELOW = 0.5;

const TICKET = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
const NOT_TICKETS = new Set(['FR', 'TC', 'CVE', 'SEC', 'S', 'NFR']);

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strList = (v: unknown, max: number) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, max) : [];

/**
 * Turns whatever the model returned into a safe Intent, or null if it is unusable.
 * Never trusts the model for anything the user fixed, and only accepts known components.
 */
export function validateIntent(raw: unknown, req: IntentRequest, knownComponents: string[]): Intent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const cap = r.capability;
  const capability = req.fixedCapability ?? (CAPABILITIES.includes(cap as Capability) ? (cap as Capability) : null);
  if (!capability) return null;

  const tt = r.test_type ?? r.testType;
  const modelTestType = tt === 'uat' || tt === 'regression' ? tt : null;

  const tickets = [
    ...new Set([
      ...req.tickets,
      // Keys written in the message are facts; the model can add tickets but never drop these.
      ...findTickets(req.text),
      ...strList(r.tickets, 10)
        .map((t) => t.toUpperCase())
        .filter((t) => TICKET.test(t) && !NOT_TICKETS.has(t.split('-')[0])),
    ]),
  ];
  const known = new Set(knownComponents);
  const components = [...new Set([...req.components, ...strList(r.components, 10).filter((c) => known.has(c))])];

  const c = typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? r.confidence : 0.5;
  const confidence = Math.min(1, Math.max(0, c));

  const question = str(r.question, 300) || null;
  const wantsClarify = r.needs_clarification === true || confidence < CLARIFY_BELOW;

  return {
    capability,
    testType: req.fixedTestType ?? modelTestType,
    action: str(r.action, 120) || 'Answer the question',
    tickets,
    components,
    confidence,
    // Only ask when the model says so and actually wrote a question.
    question: wantsClarify && question ? question : null,
    options: wantsClarify && question ? strList(r.options, 3).map((o) => o.slice(0, 80)) : [],
    source: 'model',
  };
}
