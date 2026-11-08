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

type Positioned = Candidate & { pos: number };

/** Lookup maps over the candidate inventory, built once per import so matching does not rescan it per result. */
export interface CandidateIndex {
  byCodeName: Map<string, Positioned[]>;
  byTitle: Map<string, Positioned[]>;
  bySuiteTitle: Map<string, Positioned[]>;
  byTitleLower: Map<string, Positioned[]>;
}

const push = <K>(m: Map<K, Positioned[]>, k: K, x: Positioned) => {
  const list = m.get(k);
  if (list) list.push(x);
  else m.set(k, [x]);
};

export function indexCandidates(cands: Candidate[]): CandidateIndex {
  const idx: CandidateIndex = { byCodeName: new Map(), byTitle: new Map(), bySuiteTitle: new Map(), byTitleLower: new Map() };
  cands.forEach((c, pos) => {
    const x = { ...c, pos };
    if (c.codeName) push(idx.byCodeName, c.codeName, x);
    push(idx.byTitle, c.title, x);
    if (c.suite) push(idx.bySuiteTitle, `${c.suite} ${c.title}`, x);
    push(idx.byTitleLower, c.title.toLowerCase(), x);
  });
  return idx;
}

export function matchCase(c: JUnitCase, cands: Candidate[], idx: CandidateIndex = indexCandidates(cands)): Candidate | undefined {
  const raw = rawName(c.name);
  const cls = lastPart(c.classname);
  const byName = idx.byCodeName.get(raw) ?? [];
  const agrees = (x: Candidate) =>
    (!!cls && (x.suite === cls || (!!x.suite && lastPart(x.suite) === cls) || (x.path?.includes(cls) ?? false))) || (!!c.file && !!x.path && (c.file.endsWith(x.path) || x.path.endsWith(c.file)));
  // Rule 3, in inventory order: the title alone, "<suite> <title>", or the classname plus title.
  const literal = [...(idx.byTitle.get(c.name) ?? []), ...(idx.bySuiteTitle.get(c.name) ?? [])].sort((a, b) => a.pos - b.pos).find((x) => x.title === c.name || (!!x.suite && `${x.suite} ${x.title}` === c.name) || (x.suite === c.classname && x.title === c.name));
  // Titles of scanned tests are the method name in words, so this also matches tests that were
  // recorded before code names were stored.
  const words = humanize(raw).toLowerCase();
  const byTitle = idx.byTitleLower.get(words) ?? [];
  const strip = (x: Positioned | undefined): Candidate | undefined => (x ? { id: x.id, suite: x.suite, codeName: x.codeName, title: x.title, path: x.path } : undefined);
  return strip(byName.find(agrees) ?? (byName.length === 1 ? byName[0] : undefined) ?? literal ?? byTitle.find(agrees) ?? (byTitle.length === 1 ? byTitle[0] : undefined));
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

/**
 * The suite of a test first seen in CI: the full class or package name as JUnit gives it
 * (com.piggymetrics.account.AccountControllerTest, github.com/moov-io/ach), so the test can be mapped to
 * a component by its package or directory. Only the short name was kept before, which lost that.
 */
export const ciSuite = (c: JUnitCase) => c.classname.trim() || null;
