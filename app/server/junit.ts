/**
 * Reads JUnit XML, the results format most test frameworks can write (JUnit, pytest --junitxml,
 * go-junit-report, jest-junit, Playwright, .NET loggers). Handles <testsuites> and a bare
 * <testsuite>, nested suites, and failure, error and skipped elements.
 */
import { XMLParser } from 'fast-xml-parser';

export interface JUnitCase {
  classname: string;
  name: string;
  file: string | null;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number | null;
  message: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  isArray: (name) => ['testsuite', 'testcase', 'failure', 'error', 'skipped'].includes(name),
  // Never expand entities beyond the XML built-ins (no XXE, no entity expansion attacks).
  processEntities: true,
  htmlEntities: false,
});

type Node = Record<string, unknown>;

const text = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  const n = v as Node;
  return [n.message, n['#text']].filter((x) => x != null && x !== '').map(String).join('\n');
};

export class JUnitError extends Error {}

export function parseJUnit(xml: string): JUnitCase[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new JUnitError('JUnit files with DOCTYPE or ENTITY declarations are not accepted.');
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch (e) {
    throw new JUnitError(`Not valid XML: ${(e as Error).message}`);
  }
  const roots: Node[] = [];
  const top = (doc.testsuites ?? doc.testsuite) as Node | Node[] | undefined;
  if (!top) throw new JUnitError('No <testsuites> or <testsuite> element: is this a JUnit XML file?');
  if (doc.testsuites) roots.push(...(((doc.testsuites as Node).testsuite as Node[]) ?? []));
  else roots.push(...(Array.isArray(top) ? top : [top]));

  const out: JUnitCase[] = [];
  const walk = (suite: Node) => {
    for (const c of (suite.testcase as Node[]) ?? []) {
      const failure = (c.failure as unknown[])?.[0] ?? (c.error as unknown[])?.[0];
      const skipped = (c.skipped as unknown[])?.length;
      const t = Number(c.time);
      out.push({
        classname: String(c.classname ?? suite.name ?? ''),
        name: String(c.name ?? ''),
        file: c.file ? String(c.file) : suite.file ? String(suite.file) : null,
        status: failure !== undefined ? 'failed' : skipped ? 'skipped' : 'passed',
        durationMs: Number.isFinite(t) ? Math.round(t * 1000) : null,
        message: failure !== undefined ? text(failure).slice(0, 2000) || 'Failed' : null,
      });
    }
    for (const s of (suite.testsuite as Node[]) ?? []) walk(s);
  };
  roots.forEach(walk);
  return out.filter((c) => c.name);
}
