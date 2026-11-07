/**
 * Detects whether a request is about UAT or regression. Rules only, no model, so the result is
 * predictable and explainable; the user can always override it in the composer.
 *
 *   1. An explicit word wins: "regression" (or nightly, smoke, suite) means regression;
 *      "UAT" (or acceptance, sign-off) means UAT. Both at once is ambiguous.
 *   2. Otherwise, a Jira ticket (key or link) means UAT, and a component means regression.
 *      A ticket and a component together is ambiguous.
 *   3. Nothing to go on: no detection, and nothing is shown.
 */
import type { TestType } from './types';

export interface Detection {
  /** null with `ambiguous: false` means there was nothing to go on. */
  type: TestType | null;
  ambiguous: boolean;
  /** Short reason shown to the user, e.g. "from APP-123". */
  reason: string;
  tickets: string[];
}

/** ID prefixes that look like Jira keys but are requirements, test cases, CVEs or scans. */
const NOT_TICKETS = new Set(['FR', 'TC', 'CVE', 'SEC', 'S', 'NFR']);

const JIRA_URL = /https?:\/\/[^\s]+?\/browse\/([A-Z][A-Z0-9]+-\d+)/g;
const JIRA_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;

const REGRESSION_WORDS = /\b(regression|regressions|nightly|smoke|suite|re-?run the suite)\b/i;
const UAT_WORDS = /\b(uat|user acceptance|acceptance (?:criteria|test(?:s|ing)?)|sign[- ]?off)\b/i;

export function findTickets(text: string): string[] {
  const keys = new Set<string>();
  for (const m of text.matchAll(JIRA_URL)) keys.add(m[1]);
  for (const m of text.matchAll(JIRA_KEY)) {
    const prefix = m[1].split('-')[0];
    if (!NOT_TICKETS.has(prefix)) keys.add(m[1]);
  }
  return [...keys];
}

export function detectTestType(text: string, attached: { tickets?: string[]; components?: string[] } = {}): Detection {
  const tickets = [...new Set([...(attached.tickets ?? []), ...findTickets(text)])];
  const components = attached.components ?? [];
  const saysRegression = REGRESSION_WORDS.test(text);
  const saysUat = UAT_WORDS.test(text);

  if (saysRegression && saysUat) return { type: null, ambiguous: true, reason: 'mentions both', tickets };
  if (saysRegression) return { type: 'regression', ambiguous: false, reason: 'you said regression', tickets };
  if (saysUat) {
    return { type: 'uat', ambiguous: false, reason: tickets.length ? `from ${list(tickets)}` : 'you said UAT', tickets };
  }

  if (tickets.length && components.length) {
    return { type: null, ambiguous: true, reason: 'a ticket and a component', tickets };
  }
  if (tickets.length) return { type: 'uat', ambiguous: false, reason: `from ${list(tickets)}`, tickets };
  if (components.length) return { type: 'regression', ambiguous: false, reason: `for ${list(components)}`, tickets };

  return { type: null, ambiguous: false, reason: '', tickets };
}

const list = (xs: string[]) => (xs.length <= 2 ? xs.join(' and ') : `${xs[0]} and ${xs.length - 1} more`);

export const testTypeLabel = (t: TestType) => (t === 'uat' ? 'UAT' : 'Regression');
