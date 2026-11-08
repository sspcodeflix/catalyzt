/** Test flow shapes, shared by server/flows.ts and the pages (no browser code here). See docs/FLOWS.md. */
export type FlowKind = 'uat' | 'regression';
export type StepKey = 'analyse' | 'review' | 'run' | 'signoff' | 'automate' | 'verify';
export type StepState = 'done' | 'skipped' | 'working' | 'waiting' | 'blocked' | 'todo';

export const STEPS: Record<FlowKind, { key: StepKey; label: string }[]> = {
  uat: [
    { key: 'analyse', label: 'Analyse' },
    { key: 'review', label: 'Review cases' },
    { key: 'run', label: 'Run tests' },
    { key: 'signoff', label: 'Sign off' },
  ],
  regression: [
    { key: 'analyse', label: 'Analyse' },
    { key: 'review', label: 'Review cases' },
    { key: 'automate', label: 'Automate' },
    { key: 'verify', label: 'Verify in CI' },
  ],
};


/** What one person (or the pipeline) has to do for a story, and how. */
export interface FlowAction {
  /** analyse | review | link | execute | fix | signoff | automate | wait */
  kind: string;
  label: string;
  /** Where to go to do it; absent when the action happens on the flow page itself. */
  href?: string;
}
export interface StoryStep {
  key: StepKey;
  state: StepState;
  /** One plain sentence: what has happened, or what is missing. */
  detail: string;
  /** People who can move it on; empty for agent work and the pipeline. */
  waitingOn: { id: string; name: string }[];
  action?: FlowAction;
  since?: string;
}
export interface ManualCase {
  id: string;
  title: string;
  criterion: string;
  last: { status: string; by: string; at: string; note: string | null } | null;
}
export interface FlowStory {
  key: string;
  summary: string;
  status: string;
  components: string[];
  criteria: { id: string; text: string; status: string; verified: boolean }[];
  steps: StoryStep[];
  /** The first step that is not finished, or null when the story is through the flow. */
  current: StepKey | null;
  chatId: string | null;
  manual: ManualCase[];
  signoff: { decision: string; by: string; at: string; note: string | null; stale: boolean } | null;
  /** Drafted cases waiting for review (or sent back with a note), for the flow's own review step. */
  review: { approvalId: string; status: string; cases: { id: string; title: string; criterion: string; steps: string[] }[]; note: string | null; decidedBy: string | null; chatId: string } | null;
  removed?: boolean;
}
export interface FlowSummary {
  id: string;
  kind: FlowKind;
  title: string;
  status: string;
  owner: { id: string; name: string };
  createdAt: string;
  stories: number;
  /** Per step: how many stories are past it. */
  steps: { key: StepKey; label: string; done: number }[];
  current: { key: StepKey; label: string } | null;
  waiting: { person: { id: string; name: string } | null; action: string; stories: string[]; since: string | null; you: boolean }[];
  coverage: { baseline: number; now: number; target: number; criteria: number };
}
export interface FlowView extends FlowSummary {
  items: FlowStory[];
  events: { at: string; who: string | null; story: string | null; text: string }[];
  canManage: boolean;
  canSignOff: boolean;
  canExecute: boolean;
  /** The flow's team thread: a chat every member of the application can add to. */
  threadId: string;
}


