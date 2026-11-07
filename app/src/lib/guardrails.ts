/**
 * Guardrails. Requests that break a policy are rejected before any agent or model runs.
 *
 * Two layers:
 *  1. Input guard (this file, rules only): instant, predictable, runs on the server for every
 *     request, so the browser cannot skip it.
 *  2. Model guard: the router agent also reports `in_scope` and a `policy`, which catches what
 *     rules cannot, such as off-topic requests. Its verdict maps onto the same policies, and the
 *     user sees the fixed message below, never text written by the model.
 *
 * The output guard (redactSecrets) masks anything that looks like a secret in answers.
 */

export type PolicyId =
  | 'credentials'
  | 'secret-in-input'
  | 'bypass-approval'
  | 'prompt-injection'
  | 'destructive'
  | 'suppress-findings'
  | 'personal-data'
  | 'off-topic'
  | 'too-long';

export interface Policy {
  id: PolicyId;
  title: string;
  /** Why it was rejected and what to do instead. Shown to the user. */
  message: string;
}

export const POLICIES: Record<PolicyId, Policy> = {
  credentials: {
    id: 'credentials',
    title: 'Credentials',
    message:
      'Horizon never reads, shows or shares passwords, keys or tokens. Credentials stay in the credential broker and never reach the model. Ask the secret owner, or use your vault.',
  },
  'secret-in-input': {
    id: 'secret-in-input',
    title: 'Secret in the message',
    message:
      'This message looks like it contains a password, key or token, so it was not sent to any model. Remove the secret, rotate it if it was real, and send again.',
  },
  'bypass-approval': {
    id: 'bypass-approval',
    title: 'Approval required',
    message:
      'Horizon does not merge, push, deploy or change anything without a person approving it. Ask for the change, and Horizon will prepare it as an approval card.',
  },
  'prompt-injection': {
    id: 'prompt-injection',
    title: 'Instruction override',
    message: "Horizon's rules can't be switched off from a chat. Ask your question directly.",
  },
  destructive: {
    id: 'destructive',
    title: 'Destructive action',
    message:
      'Horizon does not delete, drop or destroy environments, data or repositories. Changes to environments go through GitOps pull requests that a person approves.',
  },
  'suppress-findings': {
    id: 'suppress-findings',
    title: 'Security finding',
    message:
      'A security finding can only be suppressed with a recorded risk acceptance. Raise it in Huddle so the security champion can decide.',
  },
  'personal-data': {
    id: 'personal-data',
    title: 'Personal data',
    message:
      "Horizon does not export or list customers' personal data. Use masked test data, or ask the data owner.",
  },
  'off-topic': {
    id: 'off-topic',
    title: 'Outside Horizon',
    message:
      'Horizon helps with test analysis, test authoring, execution, CloudOps and security for your applications. This request is outside that.',
  },
  'too-long': {
    id: 'too-long',
    title: 'Too long',
    message: 'The message is over 8,000 characters. Attach long content as a file in App Context instead.',
  },
};

export const MAX_INPUT = 8000;

export type GuardResult = { allowed: true } | { allowed: false; policy: Policy; /** What matched, for the audit log only. */ match: string };

/** Secrets pasted into a message: common key formats, private key blocks and "password = …" pairs. */
const SECRET_IN =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bxox[abpr]-[A-Za-z0-9-]{10,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\b(password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*\S{6,})/i;

/** True when the text contains something that looks like a secret. Nothing containing one may be stored or sent to a model. */
export const containsSecret = (text: string) => SECRET_IN.test(text);

const RULES: [PolicyId, RegExp][] = [
  // Asking Horizon to reveal or hand over credentials.
  [
    'credentials',
    /\b(show|give|tell|print|reveal|share|send|dump|list|export|expose|leak|what(?:'s| is| are))\b[^.?!\n]{0,40}\b(passwords?|passwd|api[ -]?keys?|secrets?|tokens?|private keys?|credentials?|ssh keys?)\b/i,
  ],
  // Skipping the person in the loop.
  [
    'bypass-approval',
    /\b(without|skip(?:ping)?|bypass(?:ing)?|no)\s+(an?\s+)?(approvals?|reviews?|sign-?off|asking)\b|\bforce[- ]push\b|\b(merge|push|deploy|apply|release)\b[^.?!\n]{0,40}\b(directly|straight)\b[^.?!\n]{0,20}\b(main|master|prod|production)\b|\bauto-?(merge|approve)\b/i,
  ],
  // Attempts to override Horizon's rules.
  [
    'prompt-injection',
    /\b(ignore|disregard|forget|override)\b[^.?!\n]{0,30}\b(previous|prior|above|all|your|system)\b[^.?!\n]{0,20}\b(instructions?|rules?|prompts?|guardrails?|policies)\b|\b(jailbreak|developer mode|dan mode)\b|\b(reveal|show|print)\b[^.?!\n]{0,20}\bsystem prompt\b/i,
  ],
  // Destroying environments, data or repositories.
  [
    'destructive',
    /\b(delete|drop|wipe|destroy|terminate|truncate|purge|nuke)\b[^.?!\n]{0,30}\b(cluster|clusters|database|databases|db|namespace|prod|production|bucket|buckets|tables?|repo|repository|environment)\b/i,
  ],
  // Hiding security findings without a decision.
  [
    'suppress-findings',
    /\b(suppress|hide|silence|dismiss|ignore|whitelist|allowlist)\b[^.?!\n]{0,30}\b(cves?|findings?|vulnerabilit(?:y|ies)|alerts?)\b|\bmark\b[^.?!\n]{0,30}\bas (a )?false positives?\b/i,
  ],
  // Bulk personal data.
  [
    'personal-data',
    /\b(export|list|dump|download|give|show|extract)\b[^.?!\n]{0,40}\b(customers?|users?|cardholders?|merchants?)\b[^.?!\n]{0,30}\b(emails?|phone numbers?|addresses|card numbers?|pans?|ssns?|personal data|pii|dates? of birth)\b/i,
  ],
];

/**
 * Input guard: rules only, no model. `only` limits it to some policies, e.g. for story text,
 * where a feature can legitimately mention exporting or deleting data.
 */
export function checkInput(text: string, only?: PolicyId[]): GuardResult {
  // A secret is checked first, before the length: an overlong message that also carries a secret
  // must be treated as a secret, so that nothing of it is kept.
  if (!only || only.includes('secret-in-input')) {
    const m = SECRET_IN.exec(text);
    if (m) return { allowed: false, policy: POLICIES['secret-in-input'], match: m[0].slice(0, 80) };
  }
  if (text.length > MAX_INPUT) return { allowed: false, policy: POLICIES['too-long'], match: `${text.length} chars` };
  for (const [id, re] of RULES) {
    if (only && !only.includes(id)) continue;
    const m = re.exec(text);
    if (m) return { allowed: false, policy: POLICIES[id], match: m[0].slice(0, 80) };
  }
  return { allowed: true };
}

/** Maps the router agent's verdict onto a policy. Unknown values fall back to off-topic. */
export function policyFromModel(inScope: unknown, policy: unknown): Policy | null {
  if (inScope !== false) return null;
  return typeof policy === 'string' && policy in POLICIES ? POLICIES[policy as PolicyId] : POLICIES['off-topic'];
}

const SECRET_OUT =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bxox[abpr]-[A-Za-z0-9-]{10,}\b|\bsk-[A-Za-z0-9_-]{20,}\b)/g;

/** Output guard: masks anything that looks like a secret in an answer. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_OUT, '[secret removed]');
}

/**
 * While streaming, how much of the (already redacted) text is safe to send. Secrets contain no
 * whitespace, so only the word still being written is held back, plus any private key block
 * that has started but not ended.
 */
export function streamSafeLength(text: string): number {
  const pem = text.lastIndexOf('-----BEGIN');
  if (pem >= 0 && text.indexOf('-----END', pem) < 0) return pem;
  const m = /\s(?=\S*$)/.exec(text);
  return m ? m.index + 1 : 0;
}
