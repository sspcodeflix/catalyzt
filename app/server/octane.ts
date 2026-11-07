/**
 * Manual tests in the format of ALM Octane's Excel import template: one row per step, rows of
 * the same test share a unique_id, and the test's fields sit on its first row.
 *
 *   unique_id | type | name | step_type | step_description | test_type | product_areas |
 *   covered_content | designer | description | estimated_duration | owner | phase | user_tags |
 *   application_modules
 *
 * Column names are matched without regard to case, spaces or underscores; unknown columns are
 * ignored. Confirm the columns against your Octane version before relying on round trips.
 */
import ExcelJS from 'exceljs';

export const OCTANE_COLUMNS = [
  'unique_id',
  'type',
  'name',
  'step_type',
  'step_description',
  'test_type',
  'product_areas',
  'covered_content',
  'designer',
  'description',
  'estimated_duration',
  'owner',
  'phase',
  'user_tags',
  'application_modules',
] as const;

export type StepType = 'simple' | 'validation' | 'call';

export interface ManualTestInput {
  externalId: string;
  name: string;
  description: string;
  testType: string;
  purpose: 'uat' | 'regression' | null;
  phase: string;
  owner: string;
  designer: string;
  productAreas: string;
  applicationModules: string;
  userTags: string;
  estimatedMinutes: number | null;
  /** Story keys and requirement ids from covered_content. */
  covers: string[];
  steps: { type: StepType; description: string }[];
}

export interface ParseProblem {
  row: number;
  message: string;
}

const norm = (k: string) => k.toLowerCase().replace(/[\s_-]+/g, '');

/** A small RFC 4180 CSV reader: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

const cellText = (v: ExcelJS.CellValue): string => {
  if (v == null) return '';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return String(v.result ?? '');
    if (v instanceof Date) return v.toISOString();
  }
  return String(v);
};

/** Reads the first worksheet of an .xlsx file into rows of text. */
export async function parseXlsx(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const out: string[] = [];
    for (let c = 1; c <= r.cellCount; c++) out.push(cellText(r.getCell(c).value).trim());
    rows.push(out);
  });
  return rows;
}

/** UAT or regression, from Octane's test_type. */
export function purposeFrom(testType: string): 'uat' | 'regression' | null {
  const t = testType.toLowerCase();
  if (/\b(acceptance|uat)\b/.test(t)) return 'uat';
  if (/\bregression\b/.test(t)) return 'regression';
  return null;
}

const STEP: Record<string, StepType> = { simple: 'simple', validation: 'validation', call: 'call', s: 'simple', v: 'validation', c: 'call' };

/** Groups template rows into tests. Rows it cannot use are reported, not silently dropped. */
export function readOctaneRows(rows: string[][]): { tests: ManualTestInput[]; problems: ParseProblem[] } {
  const problems: ParseProblem[] = [];
  if (rows.length < 2) return { tests: [], problems: [{ row: 1, message: 'The file has no test rows.' }] };
  const header = rows[0].map(norm);
  const col = (name: string) => header.indexOf(norm(name));
  if (col('name') < 0 && col('unique_id') < 0) {
    return { tests: [], problems: [{ row: 1, message: 'No "name" or "unique_id" column. Use the Octane import template (download it from Hexa).' }] };
  }
  const get = (r: string[], name: string) => {
    const i = col(name);
    return i >= 0 ? (r[i] ?? '').trim() : '';
  };

  const byId = new Map<string, ManualTestInput>();
  let current: ManualTestInput | null = null;
  rows.slice(1).forEach((r, idx) => {
    const rowNo = idx + 2;
    const type = get(r, 'type').toLowerCase();
    if (type && !/^test_?manual$|^manual/.test(type)) {
      problems.push({ row: rowNo, message: `Type "${get(r, 'type')}" is not a manual test; skipped.` });
      return;
    }
    const id = get(r, 'unique_id');
    const name = get(r, 'name');
    let test = id ? byId.get(id) : undefined;
    if (!test && (name || id)) {
      if (!name) {
        problems.push({ row: rowNo, message: `Test "${id}" has no name on its first row; skipped.` });
        return;
      }
      const testType = get(r, 'test_type');
      const minutes = Number(get(r, 'estimated_duration'));
      test = {
        externalId: id || `row-${rowNo}`,
        name: name.slice(0, 300),
        description: get(r, 'description').slice(0, 4000),
        testType,
        purpose: purposeFrom(testType),
        phase: get(r, 'phase'),
        owner: get(r, 'owner'),
        designer: get(r, 'designer'),
        productAreas: get(r, 'product_areas'),
        applicationModules: get(r, 'application_modules'),
        userTags: get(r, 'user_tags'),
        estimatedMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : null,
        covers: get(r, 'covered_content')
          .split(/[,;|\n]+/)
          .map((x) => x.trim())
          .filter(Boolean),
        steps: [],
      };
      byId.set(test.externalId, test);
    } else if (!test && !id) {
      // A step row without unique_id belongs to the test above it.
      test = current ?? undefined;
    }
    if (!test) {
      problems.push({ row: rowNo, message: 'Step row with no test above it; skipped.' });
      return;
    }
    current = test;
    const desc = get(r, 'step_description');
    if (desc) {
      const st = STEP[get(r, 'step_type').toLowerCase()];
      if (!st && get(r, 'step_type')) problems.push({ row: rowNo, message: `Step type "${get(r, 'step_type')}" is not simple, validation or call; used simple.` });
      test.steps.push({ type: st ?? 'simple', description: desc.slice(0, 2000) });
    }
  });
  const tests = [...byId.values()];
  for (const t of tests) if (t.steps.length === 0) problems.push({ row: 0, message: `"${t.name}" has no steps.` });
  return { tests, problems };
}

/** Writes tests in the template's layout, so they can be imported into Octane. */
export function toOctaneCsv(
  tests: {
    externalId: string | null;
    id: string;
    title: string;
    description: string | null;
    testType: string | null;
    phase: string | null;
    owner: string | null;
    designer: string | null;
    productAreas: string | null;
    applicationModules: string | null;
    userTags: string | null;
    estimatedMinutes: number | null;
    covers: string[];
    steps: { type: StepType; description: string }[];
  }[],
): string {
  const q = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [OCTANE_COLUMNS.join(',')];
  for (const t of tests) {
    const steps = t.steps.length ? t.steps : [{ type: 'simple' as StepType, description: '' }];
    steps.forEach((s, i) => {
      const first = i === 0;
      lines.push(
        [
          t.externalId ?? t.id,
          first ? 'test_manual' : '',
          first ? t.title : '',
          s.type,
          s.description,
          first ? t.testType : '',
          first ? t.productAreas : '',
          first ? t.covers.join(', ') : '',
          first ? t.designer : '',
          first ? t.description : '',
          first ? t.estimatedMinutes : '',
          first ? t.owner : '',
          first ? t.phase : '',
          first ? t.userTags : '',
          first ? t.applicationModules : '',
        ]
          .map(q)
          .join(','),
      );
    });
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** An .xlsx template with the columns and one example test, covering `storyKey` when one is given. */
export async function octaneTemplate(storyKey = 'STORY-1'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('manual tests');
  ws.addRow([...OCTANE_COLUMNS]);
  ws.addRow(['UAT-1', 'test_manual', 'Example: the feature rejects an invalid input with a clear message', 'simple', 'Sign in to the test environment as a test user', 'Acceptance', '', `${storyKey}#AC1`, '', `Checks AC1 of ${storyKey}. Replace with your own test; one row per step.`, 10, '', 'New', 'uat', '']);
  ws.addRow(['UAT-1', '', '', 'simple', 'Open the feature and enter an invalid value']);
  ws.addRow(['UAT-1', '', '', 'validation', 'An error message is shown and nothing is saved']);
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((c) => (c.width = 22));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
