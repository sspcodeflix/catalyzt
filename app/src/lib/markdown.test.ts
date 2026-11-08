import { describe, expect, it } from 'vitest';

import { cleanFlatTable, isPlainFile, parseInline, parseMarkdown } from './markdown';

// The account-service table from the piggymetrics README, as indexed with its line breaks.
const PASSAGE = [
  '#### Account service',
  'Contains general input logic and validation: incomes/expenses items, savings and account settings.',
  '',
  'Method | Path | Description | User authenticated | Available from UI',
  '------------- | ------------------------- | ------------- |:-------------:|:----------------:|',
  'GET | /accounts/{account} | Get specified account data | |',
  'GET | /accounts/current | Get current account data | × | ×',
  'POST | /accounts/ | Register new account | | ×',
].join('\n');

describe('passage Markdown (R20)', () => {
  it('reads a GitHub table with its header, alignment and rows', () => {
    const blocks = parseMarkdown(PASSAGE);
    expect(blocks.map((b) => b.kind)).toEqual(['h', 'p', 'table']);
    const t = blocks[2];
    if (t.kind !== 'table') throw new Error('no table');
    expect(t.header).toEqual(['Method', 'Path', 'Description', 'User authenticated', 'Available from UI']);
    expect(t.align).toEqual([null, null, null, 'center', 'center']);
    expect(t.rows).toEqual([
      ['GET', '/accounts/{account}', 'Get specified account data', '', ''],
      ['GET', '/accounts/current', 'Get current account data', '×', '×'],
      ['POST', '/accounts/', 'Register new account', '', '×'],
    ]);
  });

  it('keeps lists, code and inline marks, and never turns HTML or script links into markup', () => {
    const blocks = parseMarkdown('- one **bold** item\n- two\n\n```\nmvn test\n```\n\n<img src=x onerror=alert(1)> see [docs](https://example.com) and [x](javascript:alert(1))');
    expect(blocks.map((b) => b.kind)).toEqual(['ul', 'code', 'p']);
    expect(parseInline('one **bold** item')).toEqual([
      { kind: 'text', text: 'one ' },
      { kind: 'b', text: 'bold' },
      { kind: 'text', text: ' item' },
    ]);
    const p = blocks[2];
    if (p.kind !== 'p') throw new Error('no paragraph');
    const marks = parseInline(p.text);
    expect(marks[0]).toEqual({ kind: 'text', text: '<img src=x onerror=alert(1)> see ' });
    expect(marks).toContainEqual({ kind: 'link', text: 'docs', href: 'https://example.com' });
    expect(marks).toContainEqual({ kind: 'text', text: 'x' });
    expect(marks.some((m) => m.kind === 'link' && m.href.startsWith('javascript'))).toBe(false);
  });

  it('cleans a table in a passage indexed as one long line, and keeps build files as written', () => {
    const flat = 'Method | Path | Description ------------- | ------------- |:-------------:| GET | /accounts/current | Get data';
    expect(cleanFlatTable(flat)).toBe('Method · Path · Description · GET · /accounts/current · Get data');
    expect(cleanFlatTable(PASSAGE)).toBe(PASSAGE);
    expect(isPlainFile('pom.xml ¶1')).toBe(true);
    expect(isPlainFile('.github/workflows/ci.yml ¶2')).toBe(true);
    expect(isPlainFile('account-service/Dockerfile ¶1')).toBe(true);
    expect(isPlainFile('README.md ¶3')).toBe(false);
  });
});
