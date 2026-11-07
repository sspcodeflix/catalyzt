/**
 * Turns the agent workflow's events into an answer, step by step. Pure functions, shared by the
 * browser (which renders the answer as it streams) and the server (which saves the final answer
 * as a revision). Keeping one reducer means what the user saw and what was stored never differ.
 */
import type { Intent } from './intent';
import type { AgentView, Artifact, Block, Citation, RunStep } from './types';
import type { WorkflowEvent } from './workflow';

export interface AnswerState {
  steps: RunStep[];
  agents: AgentView[];
  summary: string;
  /** Prose text, from a structured answer or streamed. */
  text: string;
  streamed: boolean;
  /** Blocks after the prose: cards, approvals, follow-ups, rejections. */
  rest: Block[];
  citations: Citation[];
  intent?: Intent;
  artifact?: Artifact;
  uatTicket?: string;
  status: 'working' | 'streaming' | 'done' | 'error' | 'stopped';
  error?: string;
  tokens: number;
  /** Set once the server has saved the revision. */
  revisionId?: string;
  /** The revision number the server gave the saved answer. */
  revision?: number;
}

export const initialAnswer = (): AnswerState => ({
  steps: [],
  agents: [],
  summary: 'Working',
  text: '',
  streamed: false,
  rest: [],
  citations: [],
  status: 'working',
  tokens: 0,
});

/** A flat list of the agents' outcomes, for the collapsed summary and older views. */
const stepsFromAgents = (agents: AgentView[]): RunStep[] =>
  agents
    .filter((a) => a.parentId)
    .map((a) => ({
      id: a.id,
      agent: a.agent,
      label: a.result ?? a.task,
      seconds: a.seconds,
      state: a.state === 'running' ? 'running' : a.state === 'done' ? 'done' : 'failed',
      noModel: !a.model,
    }));

export function applyEvent(s: AnswerState, ev: WorkflowEvent): AnswerState {
  switch (ev.type) {
    case 'agent': {
      const prev = s.agents.find((a) => a.id === ev.id);
      const a: AgentView = { id: ev.id, parentId: ev.parentId, agent: ev.agent, kind: ev.kind, task: ev.task, state: ev.state, model: ev.model, result: ev.result, tokens: ev.tokens, seconds: ev.seconds, steps: prev?.steps ?? [] };
      const agents = prev ? s.agents.map((x) => (x.id === ev.id ? a : x)) : [...s.agents, a];
      return { ...s, agents, steps: stepsFromAgents(agents) };
    }
    case 'step': {
      const st = { id: ev.id, kind: ev.kind, label: ev.label, detail: ev.detail, state: ev.state, seconds: ev.seconds };
      return {
        ...s,
        agents: s.agents.map((a) => (a.id !== ev.agentId ? a : { ...a, steps: a.steps.some((x) => x.id === ev.id) ? a.steps.map((x) => (x.id === ev.id ? st : x)) : [...a.steps, st] })),
      };
    }
    case 'intent':
      return { ...s, intent: ev.intent };
    case 'rejected':
      return { ...s, rest: [{ kind: 'rejected', title: ev.policy.title, text: ev.policy.message, by: ev.by }] };
    case 'answer':
      return {
        ...s,
        text: ev.blocks.flatMap((b) => (b.kind === 'prose' ? [b.text] : [])).join('\n\n'),
        rest: ev.blocks.filter((b) => b.kind !== 'prose'),
        citations: ev.citations,
        artifact: ev.artifact,
        uatTicket: ev.uatTicket,
      };
    case 'text':
      return { ...s, streamed: true, status: s.status === 'working' ? 'streaming' : s.status, text: s.text + ev.text };
    case 'done':
      return { ...s, status: 'done', tokens: ev.tokens, summary: ev.tokens > 0 ? `${ev.summary} · ${ev.tokens.toLocaleString()} tokens` : ev.summary };
    case 'error':
      return finishAnswer(s, false, ev.message);
    case 'saved':
      return {
        ...s,
        revisionId: ev.revisionId,
        revision: ev.revision ?? s.revision,
        rest: s.rest.map((b, i) => {
          if (b.kind !== 'approval') return b;
          const id = ev.approvals.find((a) => a.index === i)?.id;
          return id ? { ...b, approval: { ...b.approval, id } } : b;
        }),
      };
    default:
      return s;
  }
}

/** The answer's blocks in display order: the run, the prose, then everything else. */
export function answerBlocks(s: AnswerState): Block[] {
  return [{ kind: 'run', summary: s.summary, steps: s.steps, agents: s.agents }, ...(s.streamed || s.text ? [{ kind: 'prose' as const, text: s.text }] : []), ...s.rest];
}

/** Closes an answer that did not finish: the user stopped it, or something failed. */
export function finishAnswer(s: AnswerState, stopped: boolean, error?: string): AnswerState {
  if (s.status === 'done') return s;
  return {
    ...s,
    status: stopped ? 'stopped' : 'error',
    error: stopped ? undefined : (error ?? 'The answer failed.'),
    summary: stopped ? 'Stopped' : 'Failed',
    steps: s.steps.map((x) => (x.state === 'running' ? { ...x, state: stopped ? 'done' : 'failed', label: stopped ? `${x.label} (stopped)` : x.label } : x)),
    agents: s.agents.map((a) => (a.state === 'running' ? { ...a, state: stopped ? 'stopped' : 'failed', steps: a.steps.map((x) => (x.state === 'running' ? { ...x, state: 'failed' } : x)) } : a)),
  };
}
