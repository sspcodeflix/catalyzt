import { afterEach, describe, expect, it, vi } from 'vitest';

import { extractTests, fetchFile, humanize, isTestFile, listTestFiles, parseRepoRef } from './github';

afterEach(() => vi.unstubAllGlobals());

describe('parseRepoRef', () => {
  it.each([
    ['GoogleCloudPlatform/microservices-demo', { owner: 'GoogleCloudPlatform', repo: 'microservices-demo' }],
    ['juice-shop/juice-shop@develop', { owner: 'juice-shop', repo: 'juice-shop', ref: 'develop' }],
    ['https://github.com/argoproj/argocd-example-apps', { owner: 'argoproj', repo: 'argocd-example-apps' }],
    ['https://github.com/a/b/tree/release/1.2', { owner: 'a', repo: 'b', ref: 'release/1.2' }],
    ['https://github.com/a/b.git', { owner: 'a', repo: 'b' }],
  ])('%s', (input, out) => expect(parseRepoRef(input)).toEqual({ ref: undefined, ...out }));

  it.each(['not a repo', 'https://evil.example.com/a/b', 'a/b/c', '../x/y', 'a/b@x;rm'])('rejects %s', (input) => expect(parseRepoRef(input)).toBeNull());
});

describe('isTestFile', () => {
  it.each([
    ['src/refunds/PartialRefundTest.java', true],
    ['web/src/cart.test.tsx', true],
    ['e2e/checkout.spec.ts', true],
    ['tests/test_refunds.py', true],
    ['pkg/refund/refund_test.go', true],
    ['Refunds.Tests/RefundTests.cs', true],
    ['spec/refund_spec.rb', true],
    ['tests/conftest.py', false],
    ['node_modules/x/a.test.js', false],
    ['src/refund.ts', false],
  ])('%s -> %s', (path, yes) => expect(isTestFile(path)).toBe(yes));
});

describe('humanize', () => {
  it('turns code names into words', () => {
    expect(humanize('partialRefundAboveOriginalIsRejected')).toBe('Partial refund above original is rejected');
    expect(humanize('test_refund_needs_reason')).toBe('Refund needs reason');
    expect(humanize('TestHTTPRetryBackoff')).toBe('Http retry backoff');
  });
});

describe('extractTests', () => {
  it('JUnit, with @DisplayName', () => {
    const src = `class PartialRefundTest {\n  @Test\n  void partialRefundAboveOriginalIsRejected() {}\n  @Test @DisplayName("Card refund needs a reason")\n  void cardRefund() {}\n}`;
    expect(extractTests('a/PartialRefundTest.java', src)).toEqual([
      { title: 'Partial refund above original is rejected', name: 'partialRefundAboveOriginalIsRejected', suite: 'PartialRefundTest', framework: 'JUnit', line: 3 },
      { title: 'Card refund needs a reason', name: 'cardRefund', suite: 'PartialRefundTest', framework: 'JUnit', line: 5 },
    ]);
  });
  it('Jest and Playwright', () => {
    expect(extractTests('a.test.ts', `describe('cart', () => {\n  it('adds an item', () => {});\n  test.skip("removes it", () => {});\n});`)).toEqual([
      { title: 'adds an item', name: 'adds an item', suite: 'cart', framework: 'Jest/Mocha', line: 2 },
      { title: 'removes it', name: 'removes it', suite: 'cart', framework: 'Jest/Mocha', line: 3 },
    ]);
    expect(extractTests('e2e/a.spec.ts', `import { test } from '@playwright/test';\ntest('checkout works', async () => {});`)[0].framework).toBe('Playwright');
  });
  it('pytest, Go, .NET and RSpec', () => {
    expect(extractTests('t/test_a.py', 'class TestRefund:\n    def test_needs_reason(self):\n        pass\ndef test_top():\n    pass').map((t) => [t.title, t.suite])).toEqual([
      ['Needs reason', 'TestRefund'],
      ['Top', null],
    ]);
    expect(extractTests('a_test.go', 'func TestRetryBackoff(t *testing.T) {}')[0].title).toBe('Retry backoff');
    expect(extractTests('RefundTests.cs', 'public class RefundTests {\n  [Fact]\n  public void RejectsOverRefund() {}\n}')[0]).toMatchObject({ title: 'Rejects over refund', suite: 'RefundTests' });
    expect(extractTests('a_spec.rb', "describe 'refunds' do\n  it 'needs a reason' do\n  end\nend")[0]).toMatchObject({ title: 'needs a reason', suite: 'refunds' });
  });
});

describe('listTestFiles (F12)', () => {
  const COMMIT = 'c'.repeat(40);
  const TREE = 't'.repeat(40);

  it('pins the scan to the commit SHA (not the tree SHA) and reads files at that commit', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
        if (url.endsWith('/repos/acme/shop')) return j({ default_branch: 'main', html_url: 'https://github.com/acme/shop', private: false });
        if (url.endsWith('/repos/acme/shop/commits/main')) return j({ sha: COMMIT, commit: { tree: { sha: TREE } } });
        if (url.includes(`/git/trees/${TREE}?recursive=1`)) return j({ sha: TREE, truncated: false, tree: [{ path: 'a.test.ts', type: 'blob', size: 10 }, { path: 'src/x.ts', type: 'blob', size: 10 }, { path: 'tests', type: 'tree' }] });
        if (url === `https://raw.githubusercontent.com/acme/shop/${COMMIT}/a.test.ts`) return new Response("it('works', () => {})", { status: 200 });
        return new Response('nope', { status: 404 });
      }),
    );
    const l = await listTestFiles({ owner: 'acme', repo: 'shop' });
    expect(l).toMatchObject({ ref: 'main', sha: COMMIT, treeSha: TREE, truncated: false, htmlUrl: 'https://github.com/acme/shop' });
    expect(l.files.map((f) => f.path)).toEqual(['a.test.ts']);
    expect(calls.some((u) => u.includes('/git/trees/main'))).toBe(false);
    // Reading at the tree SHA would 404; at the commit it works.
    await expect(fetchFile({ owner: 'acme', repo: 'shop' }, TREE, 'a.test.ts')).rejects.toThrow(/Could not read/);
    expect(await fetchFile({ owner: 'acme', repo: 'shop' }, l.sha, 'a.test.ts')).toContain('works');
  });

  it('reports a listing GitHub cut short', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const j = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
        if (url.endsWith('/repos/acme/shop')) return j({ default_branch: 'main', html_url: 'https://github.com/acme/shop', private: false });
        if (url.includes('/commits/')) return j({ sha: COMMIT, commit: { tree: { sha: TREE } } });
        return j({ sha: TREE, truncated: true, tree: [{ path: 'a.test.ts', type: 'blob', size: 10 }] });
      }),
    );
    expect((await listTestFiles({ owner: 'acme', repo: 'shop' })).truncated).toBe(true);
  });
});
