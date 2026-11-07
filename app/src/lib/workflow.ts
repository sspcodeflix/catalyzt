/**
 * The agent workflow every request goes through, run on the server (server/workflow.ts) and
 * streamed to the browser as events. Shared types only.
 *
 *   Input guard  ->  Router  ->  one sub-agent  ->  Output guard
 *   (rules)          (intent,     Clarifier | UAT analyst | capability specialist
 *                     model guard)
 */
import type { Policy } from './guardrails';
import type { Intent } from './intent';
import type { Agent, Artifact, Block, Citation, Scope, TestType, Ticket } from './types';

export type AgentName =
  | 'Input guard'
  | 'Router'
  | 'Clarifier'
  | 'UAT analyst'
  | 'Analysis agent'
  | 'Authoring agent'
  | 'Execution agent'
  | 'CloudOps agent'
  | 'Security agent'
  | 'Output guard';

export interface RunRequest {
  /** Ids that link the run to the chat, the user's message and the answer revision. */
  chatId?: string;
  chatTitle?: string;
  messageId?: string;
  revision?: number;
  text: string;
  agent: Agent;
  scope: Scope;
  testType: TestType | null;
  testTypeSource: 'user' | 'rules' | null;
  tickets: string[];
  components: string[];
  history: { role: 'user' | 'assistant'; text: string }[];
  /**
   * Tickets synced from Jira, sent as context because this preview keeps them in the browser.
   * In production the server reads them from its own Jira sync.
   */
  syncedTickets: Ticket[];
}

export type AgentKind = 'orchestrator' | 'guard' | 'router' | 'specialist' | 'tool_agent' | 'refiner';
export type AgentState = 'running' | 'done' | 'failed' | 'rejected' | 'stopped';

export type WorkflowEvent =
  /** An agent was spawned (state running) or finished. The Orchestrator is the root. */
  | {
      type: 'agent';
      id: string;
      parentId: string | null;
      agent: AgentName | 'Orchestrator';
      kind: AgentKind;
      /** What the agent was asked to do, by whoever spawned it. */
      task: string;
      state: AgentState;
      model?: string;
      result?: string;
      /** Tokens this agent used, when it called a model. */
      tokens?: number;
      seconds: number;
    }
  /** One rule check, model call or tool call inside an agent. */
  | {
      type: 'step';
      id: string;
      agentId: string;
      kind: 'rule' | 'model' | 'tool';
      label: string;
      detail?: string;
      state: 'running' | 'done' | 'failed';
      seconds: number;
    }
  | { type: 'intent'; intent: Intent }
  | { type: 'rejected'; policy: Policy; by: 'Input guard' | 'Router' }
  /** A structured answer from a sub-agent: blocks after the run summary. */
  | { type: 'answer'; blocks: Block[]; citations: Citation[]; artifact?: Artifact; uatTicket?: string }
  /** Streamed answer text, already checked by the output guard. */
  | { type: 'text'; text: string }
  | { type: 'done'; summary: string; tokens: number }
  | { type: 'error'; message: string };
