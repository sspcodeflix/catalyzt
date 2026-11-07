/**
 * Rules-only routing, used when the model is not configured or fails. Mirrors the composer's
 * test type rules (testType.ts) and adds a keyword guess for the capability.
 */
import type { Intent } from './intent';
import { detectTestType } from './testType';
import type { Agent, Capability, TestType } from './types';

const RULES: [Capability, RegExp][] = [
  ['security', /\b(cve|cves|vulnerab\w*|security|sast|dast|scanner|dependency scan)\b/i],
  ['cloudops', /\b(pods?|deploy\w*|restart\w*|cluster|kubernetes|k8s|helm|argo|config ?map|environment|crashloop\w*)\b/i],
  ['execution', /\b(run|runs|ran|fail|fails|failed|failing|failure|failures|pipeline|nightly|flaky|triage|re-?run)\b/i],
  ['authoring', /\b(write|author|generate|create|draft)\b.*\b(tests?|cases?|automation|scripts?)\b/i],
];

export function routeByRules(text: string): Capability {
  return RULES.find(([, re]) => re.test(text))?.[0] ?? 'analysis';
}

export function rulesIntent(msg: {
  text: string;
  agent: Agent;
  testType: TestType | null;
  tickets: string[];
  components: string[];
}): Intent {
  const d = detectTestType(msg.text, { tickets: msg.tickets, components: msg.components });
  const capability = msg.agent === 'auto' ? routeByRules(msg.text) : msg.agent;
  const testType = msg.testType ?? d.type;
  return {
    capability,
    testType,
    action: testType === 'uat' && d.tickets.length ? `Check whether ${d.tickets[0]} is ready for UAT` : 'Answer the question',
    tickets: d.tickets,
    components: msg.components,
    confidence: msg.agent === 'auto' ? 0.6 : 1,
    question: null,
    options: [],
    source: 'rules',
  };
}
