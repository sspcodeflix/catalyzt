import { describe, expect, it } from 'vitest';

import { addedLinks, linkLabel, runSources } from './hexa';

describe('link undo (R08)', () => {
  it('undo of a criterion link removes exactly what that press added, story included, and nothing that was there', () => {
    const before = [
      { type: 'component', ref: 'IBGM/account-service' },
      { type: 'story', ref: 'IBGM-1002' },
    ];
    const after = [...before, { type: 'criterion', ref: 'IBGM-1005#AC1' }, { type: 'story', ref: 'IBGM-1005' }];
    expect(addedLinks(before, after).map(linkLabel)).toEqual(['IBGM-1005 AC1', 'IBGM-1005']);
    expect(addedLinks(after, after)).toEqual([]);
    expect(linkLabel({ type: 'component', ref: 'IBGM/account-service' })).toBe('account-service');
  });
});

describe('pipeline runs header (R11)', () => {
  it('names only the sources present, so pushed runs are not called GitHub Actions merges', () => {
    expect(runSources([{ source: 'webhook' }, { source: 'webhook' }])).toBe('2 runs: 2 pushed by CI');
    expect(runSources([{ source: 'webhook' }, { source: 'github_actions' }, { source: 'upload' }])).toBe(
      '3 runs: 1 pushed by CI, 1 collected from GitHub Actions (merge-commit runs on the default branch), 1 uploaded',
    );
    expect(runSources([])).toBe('No runs yet');
  });
});
