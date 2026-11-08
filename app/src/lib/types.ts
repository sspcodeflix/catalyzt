import type { Intent } from './intent';
import type { IconName } from '../components/icons';

/** The five capabilities. `auto` lets Catalyzt route the request by rules. */
export type Capability = 'analysis' | 'authoring' | 'execution' | 'cloudops' | 'security';
export type Agent = 'auto' | Capability;

export interface CapabilityInfo {
  id: Capability;
  name: string;
  icon: IconName;
  summary: string;
  example: string;
}

/** The application and workspace every answer is scoped to. */
export interface Scope {
  appName: string;
  appId: string;
  workspace: string;
}

/* ---------- Chat ---------- */

export interface Citation {
  n: number;
  title: string;
  /** e.g. "App Context · README.md ¶3 · v2" or "Jira · Ready for UAT" */
  detail: string;
  /** Where the exact passage or record opens in Catalyzt, when it has a place. */
  href?: string;
}

export interface RunStep {
  label: string;
  detail?: string;
  /** Steps that used no model are labelled, per DESIGN.md "Show the work". */
  noModel?: boolean;
  seconds: number;
  /** Live state while an answer is being produced. Absent means done. */
  state?: 'running' | 'done' | 'failed';
  /** The agent in the workflow that ran this step. */
  agent?: string;
  id?: string;
}

/** One agent in a workflow run, as shown in the answer: who spawned it, its task, and its steps. */
export interface AgentView {
  id: string;
  parentId: string | null;
  agent: string;
  kind: string;
  task: string;
  state: 'running' | 'done' | 'failed' | 'rejected' | 'stopped';
  model?: string;
  result?: string;
  tokens?: number;
  seconds: number;
  steps: { id: string; kind: 'rule' | 'model' | 'tool'; label: string; detail?: string; state: 'running' | 'done' | 'failed'; seconds: number }[];
}

export interface Approval {
  title: string;
  /** Rows shown in the card: repository, branch or environment, changes, what happens next. */
  facts: { label: string; value: string; mono?: boolean }[];
  credentialNote: string;
  actionLabel: string;
  /** `expired`: a newer revision of the answer superseded this approval. */
  status: 'pending' | 'approved' | 'declined' | 'expired';
  /** Set once the server has stored the approval; decisions go through it. */
  id?: string;
  decidedAt?: string;
  decidedBy?: string;
  /** What approving does, when Catalyzt carries it out itself (others are only recorded). */
  action?: 'add_uat_cases';
  /** The UAT report the cases come from, for add_uat_cases. */
  artifactId?: string;
  /** What happened after approval, shown on the card. */
  outcome?: { ok: boolean; text: string };
  /** What the reviewer asked to change, when drafted cases were sent back in a test flow. */
  note?: string;
}

/**
 * An answer is a list of blocks, rendered in order. Prose text supports `code` spans and
 * [n] citation markers.
 */
export type Block =
  | { kind: 'run'; summary: string; steps: RunStep[]; agents?: AgentView[] }
  | { kind: 'prose'; text: string }
  | { kind: 'artifact'; artifactId: string }
  | { kind: 'approval'; approval: Approval }
  | { kind: 'followups'; items: string[] }
  /** A test flow, shown live: the card always loads the flow's current state, never a copy (docs/FLOWS.md). */
  | { kind: 'flow'; flowId: string }
  /** A proposed flow: the stories found for the request; nothing starts until a person presses Start. */
  | { kind: 'flow_start'; flowKind: 'uat' | 'regression'; title: string; stories: { key: string; summary: string; note?: string }[] }
  /** What waits on the person across the application's active flows, live. */
  | { kind: 'flows_waiting' }
  /** A guardrail rejected the request. */
  | { kind: 'rejected'; title: string; text: string; by: string };

/** A file attached to a message. `stored` means kept but not readable by Catalyzt in this build. */
export interface AttachmentRef {
  id: string;
  filename: string;
  status?: 'ready' | 'stored' | 'failed';
}

export interface UserMessage {
  id: string;
  role: 'user';
  text: string;
  /** How the request was classified, shown above the message so the user can see it. */
  testType?: TestType | null;
  tickets?: string[];
  components?: string[];
  attachments?: AttachmentRef[];
  /** Who wrote it: shown in a flow's team thread, where several people write. */
  author?: { id: string; name: string };
  /** When it was sent (from the server). */
  at?: string;
}

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  capability: Capability | null;
  revision: number;
  blocks: Block[];
  citations: Citation[];
  /** 1 to 5, or null when not rated yet. Approvals in this answer stay locked until it is rated. */
  rating: number | null;
  /** Absent means done (seeded answers). Rating and approvals wait until the answer is done. */
  status?: 'working' | 'streaming' | 'done' | 'error' | 'stopped';
  /** The stored revision; ratings and approvals refer to it. */
  revisionId?: string;
  error?: string;
  /** What Catalyzt understood the user wants, and whether a model or the rules decided it. */
  intent?: Intent;
  /** When it was answered (from the server). */
  at?: string;
}

export type Message = UserMessage | AssistantMessage;

export interface CodeLine {
  n: number;
  text: string;
  change?: 'add' | 'del';
}

export interface CodeArtifact {
  id: string;
  kind: 'code';
  title: string;
  subtitle: string;
  /** Shown on the card in the chat. */
  cardLabel: string;
  path: string;
  changeLabel: string;
  lines: CodeLine[];
  testCases: { id: string; title: string; requirement: string }[];
  note: string;
}

/** How well one acceptance criterion is covered by tests. Status always has a text label. */
export type CriterionStatus = 'passing' | 'failing' | 'not-run' | 'no-test';

/** An automated test of the story's components that looks like it covers a criterion: offered for a person to link, never counted by itself. */
export interface TestSuggestion {
  id: string;
  title: string;
  /** Its result in the target build of its repository, if it ran. */
  result: string | null;
  /** Why it was suggested: the criterion names it, or the words they share. */
  why: string;
}

export interface UatArtifact {
  id: string;
  kind: 'uat';
  title: string;
  subtitle: string;
  cardLabel: string;
  ticketKey: string;
  criteria: { id: string; text: string; status: CriterionStatus; evidence: string; suggestions?: TestSuggestion[] }[];
  proposedCases: { id: string; title: string; criterion: string; steps: string[] }[];
  note: string;
}

export type Artifact = CodeArtifact | UatArtifact;

/* ---------- Test type ---------- */

/**
 * UAT checks a specific change (a Jira ticket) against its acceptance criteria.
 * Regression checks that existing components still behave as before.
 */
export type TestType = 'uat' | 'regression';

/* ---------- Jira tickets ---------- */

export type UatState = 'not-analysed' | 'gaps' | 'ready' | 'signed-off';

export interface Ticket {
  key: string;
  summary: string;
  type: 'Story' | 'Bug' | 'Task';
  status: string;
  fixVersion: string;
  components: string[];
  assignee: string;
  /** ISO time of the last change in Jira. */
  updated: string;
  description: string;
  acceptanceCriteria: string[];
  requirements: string[];
  /** The latest UAT analysis: from the server's saved reports, or from this session when fresher. */
  uat: { state: UatState; covered: number; total: number; chatId?: string; analysedAt?: string; by?: string | null; signedOff?: { by: string; at: string; flowId: string } };
  /** 'horizon' when created in Catalyzt's dummy Jira. */
  source?: 'jira_sync' | 'horizon';
  applicationId?: string;
  purpose?: 'uat' | 'regression' | null;
  /** What the author first wrote, when the saved text was refined. */
  original?: { summary: string; description: string; acceptanceCriteria: string } | null;
  refinementId?: number | null;
}

export const STORY_STATUSES = ['To Do', 'In Progress', 'Ready for UAT', 'Done'] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];

export interface JiraSync {
  project: string;
  /** The filter as JQL, for display. */
  filter: string;
  statuses: StoryStatus[];
  everyMinutes: number;
  lastSync: string;
  syncing: boolean;
  loaded: boolean;
  error: string | null;
}

/** Fields of a story created in the dummy Jira. Acceptance criteria are written one per line. */
export interface StoryDraft {
  summary: string;
  description: string;
  type: Ticket['type'];
  status: StoryStatus;
  fixVersion: string;
  components: string[];
  acceptanceCriteria: string;
}

export interface Refined {
  refinementId: number;
  refined: { summary: string; description: string; acceptanceCriteria: string[]; questions: string[] };
  source: 'model' | 'rules';
  model: string | null;
  note: string | null;
}

export interface Chat {
  id: string;
  title: string;
  agent: Agent;
  scope: Scope;
  testType: TestType | null;
  messages: Message[];
  artifacts: Record<string, Artifact>;
  /** Who started the chat (from the server). Only they can add to it; teammates can read it. */
  createdBy?: string;
  /** Loaded from the server a page at a time: the cursor of the next older page, or null at the first message. */
  olderCursor?: number | null;
  /** Set on a flow's team thread: every member of the application can add to it. */
  flowId?: string | null;
}
