// Placeholder data until the API exists. All names here are placeholders, as in the mock-ups.
import type { Agent, CapabilityInfo, Scope } from './types';

export const capabilities: CapabilityInfo[] = [
  { id: 'analysis', name: 'Test analysis', icon: 'target', summary: 'Coverage, gaps and evidence for every requirement.', example: 'Is PAY-1482 ready for UAT?' },
  { id: 'authoring', name: 'Test authoring', icon: 'pen', summary: 'Test cases and automation scripts, as pull requests.', example: 'Write tests for PAY-1482' },
  { id: 'execution', name: 'Execution', icon: 'play', summary: 'Runs, failures and triage from the CI pipeline.', example: 'Why did last night fail?' },
  { id: 'cloudops', name: 'CloudOps', icon: 'cloud', summary: 'Pods, deploys and config across environments.', example: 'Why is payments-api restarting?' },
  { id: 'security', name: 'Security', icon: 'shield', summary: 'Vulnerabilities, fixes and security tests.', example: 'Fix critical CVEs in ABCD' },
];

export const agentLabel = (a: Agent) => (a === 'auto' ? 'Auto' : capabilities.find((c) => c.id === a)!.name);

export const scopes: Scope[] = [
  { appName: 'Payments Hub', appId: 'App-abcd', workspace: 'web-ui' },
  { appName: 'Payments Hub', appId: 'App-abcd', workspace: 'api' },
  { appName: 'Merchant Portal', appId: 'App-mrch', workspace: 'all' },
];

export const scopeLabel = (s: Scope) => `${s.appName} · ${s.appId}-${s.workspace}`;

export const recents = [
  { id: 'payments-coverage', title: 'Payments Hub coverage' },
  { id: 'refund-tests', title: 'Refund tests for FR-0231' },
  { id: 'nightly-failure', title: 'Why did nightly regression fail?' },
  { id: 'api-restarts', title: 'payments-api restarts in SIT-2' },
  { id: 'critical-cves', title: 'Critical vulnerabilities in ABCD' },
];

/** Components discovered from GitHub for the selected app. Adding one to a request means regression. */
export const components = ['refund-service', 'payments-api', 'merchant-portal-ui', 'card-gateway'];

export const currentUser = { name: 'Priya N.', initials: 'PN', team: 'Payments Hub team' };
