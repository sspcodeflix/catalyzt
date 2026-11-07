// Static reference data. Everything about people, applications, components and stories comes
// from the server (see session.ts and the stores); nothing here is placeholder content.
import type { Agent, CapabilityInfo, Scope } from './types';

export const capabilities: CapabilityInfo[] = [
  { id: 'analysis', name: 'Test analysis', icon: 'target', summary: 'Coverage, gaps and evidence for every requirement.', example: 'Which stories are ready for UAT?' },
  { id: 'authoring', name: 'Test authoring', icon: 'pen', summary: 'Test cases and automation scripts, as pull requests.', example: 'Write tests for a story' },
  { id: 'execution', name: 'Execution', icon: 'play', summary: 'Runs, failures and triage from the CI pipeline.', example: 'Why did last night fail?' },
  { id: 'cloudops', name: 'CloudOps', icon: 'cloud', summary: 'Pods, deploys and config across environments.', example: 'Why is a service restarting?' },
  { id: 'security', name: 'Security', icon: 'shield', summary: 'Vulnerabilities, fixes and security tests.', example: 'Fix the critical vulnerabilities' },
];

export const agentLabel = (a: Agent) => (a === 'auto' ? 'Auto' : capabilities.find((c) => c.id === a)!.name);

export const scopeLabel = (s: Scope) => `${s.appName} · ${s.workspace}`;
