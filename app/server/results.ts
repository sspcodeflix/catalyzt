/**
 * Matches JUnit results to tests Hexa already knows (from repo scans), so a result lands on the
 * right test. Rules, in order:
 *   1. same method or function name, and the class, file or package agrees
 *   2. same method or function name, and it is unique in the repository
 *   3. same title (for frameworks that name tests in words, such as Jest or RSpec)
 *   4. the method name in words equals the title, and the class agrees (or it is unique)
 * Anything unmatched becomes a new automated test (origin ci_results), so no result is lost.
 */
import { createHash } from 'node:crypto';

import { humanize } from './github';
import type { JUnitCase } from './junit';

export interface Candidate {
  id: string;
  suite: string | null;
  codeName: string | null;
  title: string;
  path: string | null;
}

export const rawName = (n: string) => n.replace(/\(.*\)\s*$/, '').trim();
const lastPart = (cls: string) => cls.split(/[./\\:]/).filter(Boolean).pop() ?? '';

export function matchCase(c: JUnitCase, cands: Candidate[]): Candidate | undefined {
  const raw = rawName(c.name);
  const cls = lastPart(c.classname);
  const byName = cands.filter((x) => x.codeName && x.codeName === raw);
  const agrees = (x: Candidate) =>
    (!!cls && (x.suite === cls || (x.path?.includes(cls) ?? false))) || (!!c.file && !!x.path && (c.file.endsWith(x.path) || x.path.endsWith(c.file)));
  // Titles of scanned tests are the method name in words, so this also matches tests that were
  // recorded before code names were stored.
  const words = humanize(raw).toLowerCase();
  const byTitle = cands.filter((x) => x.title.toLowerCase() === words);
  return (
    byName.find(agrees) ??
    (byName.length === 1 ? byName[0] : undefined) ??
    cands.find((x) => x.title === c.name || (x.suite && `${x.suite} ${x.title}` === c.name) || (x.suite === c.classname && x.title === c.name)) ??
    byTitle.find(agrees) ??
    (byTitle.length === 1 ? byTitle[0] : undefined)
  );
}

/** A stable id for a test first seen in CI results, so later runs land on it. */
export function ciTestId(app: string, repo: string | null, c: JUnitCase) {
  return `TC-${createHash('sha1').update(`ci|${app}|${repo ?? ''}|${c.classname}|${rawName(c.name)}`).digest('hex').slice(0, 10).toUpperCase()}`;
}

/** Title for a test first seen in CI: words stay as they are, code names become words. */
export function ciTitle(c: JUnitCase) {
  const raw = rawName(c.name);
  return /\s/.test(raw) ? raw : humanize(raw);
}

export const ciSuite = (c: JUnitCase) => lastPart(c.classname) || null;
