import { describe, expect, it } from 'vitest';

import { runSources } from './hexa';

describe('pipeline runs header (R11)', () => {
  it('names only the sources present, so pushed runs are not called GitHub Actions merges', () => {
    expect(runSources([{ source: 'webhook' }, { source: 'webhook' }])).toBe('2 runs: 2 pushed by CI');
    expect(runSources([{ source: 'webhook' }, { source: 'github_actions' }, { source: 'upload' }])).toBe(
      '3 runs: 1 pushed by CI, 1 collected from GitHub Actions (merge-commit runs on the default branch), 1 uploaded',
    );
    expect(runSources([])).toBe('No runs yet');
  });
});
