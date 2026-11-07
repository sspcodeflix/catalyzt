import { describe, expect, it } from 'vitest';

import { octaneTemplate, parseCsv, parseXlsx, purposeFrom, readOctaneRows, toOctaneCsv } from './octane';

const CSV = `unique_id,type,name,step_type,step_description,test_type,covered_content,phase,owner
UAT-1,test_manual,Refund above paid amount is rejected,simple,"Open a settled payment, choose Refund",Acceptance,"PAY-1482, FR-0231",Ready,Priya N.
UAT-1,,,validation,"Refunding 501 shows ""exceeds the original amount""",,,,
REG-7,test_manual,Refund list paginates,simple,Open refunds,Regression,PAY-1490,New,Omar K.
,,,validation,Page 2 shows the next 20 refunds,,,,
X-1,test_automated,Not manual,simple,ignored,,,,
`;

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, commas and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
  });
});

describe('readOctaneRows', () => {
  it('groups rows into tests with ordered steps, purpose and coverage', () => {
    const { tests, problems } = readOctaneRows(parseCsv(CSV));
    expect(tests.map((t) => [t.externalId, t.name, t.purpose, t.steps.map((s) => s.type)])).toEqual([
      ['UAT-1', 'Refund above paid amount is rejected', 'uat', ['simple', 'validation']],
      ['REG-7', 'Refund list paginates', 'regression', ['simple', 'validation']],
    ]);
    expect(tests[0].steps[1].description).toBe('Refunding 501 shows "exceeds the original amount"');
    expect(tests[0].covers).toEqual(['PAY-1482', 'FR-0231']);
    expect(problems).toEqual([{ row: 6, message: 'Type "test_automated" is not a manual test; skipped.' }]);
  });

  it('explains a file that is not in the template format', () => {
    expect(readOctaneRows(parseCsv('foo,bar\n1,2')).problems[0].message).toMatch(/Octane import template/);
  });

  it('maps test_type to purpose', () => {
    expect(purposeFrom('User Acceptance')).toBe('uat');
    expect(purposeFrom('UAT')).toBe('uat');
    expect(purposeFrom('Regression')).toBe('regression');
    expect(purposeFrom('End to End')).toBeNull();
  });
});

describe('export and template', () => {
  it('round-trips through the Octane CSV', () => {
    const { tests } = readOctaneRows(parseCsv(CSV));
    const csv = toOctaneCsv(tests.map((t) => ({ ...t, id: t.externalId, title: t.name, estimatedMinutes: t.estimatedMinutes })));
    const again = readOctaneRows(parseCsv(csv)).tests;
    expect(again.map((t) => [t.externalId, t.name, t.steps])).toEqual(tests.map((t) => [t.externalId, t.name, t.steps]));
  });

  it('the .xlsx template reads back as one valid test', async () => {
    const rows = await parseXlsx(await octaneTemplate());
    const { tests, problems } = readOctaneRows(rows);
    expect(problems).toEqual([]);
    expect(tests).toHaveLength(1);
    expect(tests[0]).toMatchObject({ externalId: 'UAT-1', purpose: 'uat', covers: ['PAY-1482'] });
    expect(tests[0].steps.map((s) => s.type)).toEqual(['simple', 'simple', 'validation']);
  });
});
