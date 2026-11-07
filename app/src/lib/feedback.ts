/**
 * Low-rating feedback (DESIGN.md "Feedback"): below 4 stars the person picks at least one reason,
 * specific to the capability, and says what they expected. Rules, not a model, nudge vague
 * comments; the server enforces the minimum (a reason and 10+ characters).
 */
import type { Capability } from './types';

export const MIN_COMMENT = 10;
export const MAX_COMMENT = 280;

const REASONS: Record<Capability, string[]> = {
  analysis: ['Wrong coverage', 'Missed a criterion', 'Wrong requirement', 'Stale evidence', 'Hard to read', 'Something else'],
  authoring: ['Wrong expected result', 'Missing a case', 'Wrong requirement', 'Ignores our conventions', 'Reuses the wrong page object', 'Hard to read', 'Something else'],
  execution: ['Wrong root cause', 'Missed a failure', 'Wrong grouping', 'Stale run', 'Hard to read', 'Something else'],
  cloudops: ['Wrong diagnosis', 'Unsafe suggestion', 'Wrong environment', 'Missing evidence', 'Hard to read', 'Something else'],
  security: ['Wrong severity', 'False positive', 'Missed a finding', 'Wrong fix', 'Hard to read', 'Something else'],
};
const GENERAL = ['Not what I asked', 'Wrong facts', 'Missing sources', 'Hard to read', 'Something else'];

export const reasonsFor = (capability: Capability | null | undefined) => (capability ? REASONS[capability] : GENERAL);

const GENERIC = /^(bad|wrong|not good|useless|no|nope|meh|poor|terrible|incorrect|rubbish|not helpful|doesn'?t work)[.! ]*$/i;

/** What is still missing before the feedback can be sent, or hints that it could be more specific. */
export function checkFeedback(reasons: string[], comment: string): { blocking: string[]; hints: string[] } {
  const blocking: string[] = [];
  const hints: string[] = [];
  const text = comment.trim();
  if (reasons.length === 0) blocking.push('Pick at least one reason.');
  if (text.length < MIN_COMMENT) blocking.push(`Say what you expected, in at least ${MIN_COMMENT} characters.`);
  if (text.length > MAX_COMMENT) blocking.push(`Keep it under ${MAX_COMMENT} characters.`);
  if (text && GENERIC.test(text)) hints.push('What should the answer have said instead?');
  if (reasons.some((r) => /requirement|criterion|case|finding|failure/i.test(r)) && text && !/[A-Z][A-Z0-9]+-\d+|AC\d|\bFR-|\bTC-|\bCVE-/i.test(text)) hints.push('Naming the ticket, criterion or test it is about makes this actionable.');
  if (reasons.includes('Something else') && reasons.length === 1 && text.length < 40) hints.push('A sentence or two more helps whoever reads this.');
  return { blocking, hints };
}
