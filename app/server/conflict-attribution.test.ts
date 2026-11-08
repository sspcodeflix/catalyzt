/**
 * R16: a conflict names the sources that actually disagree. Each compare row is labelled with its own
 * source, options are "Keep <source> (what it says)", and text entered for one source that names
 * another source of the application is called out in the item instead of being silently attributed.
 */
import { describe, expect, it } from 'vitest';

import { addUploads, listSources, raiseConflict } from './context';
import { fixtureWithDocs } from './fixture';
import { getItem } from './huddle';
import { MemoryBlobStore } from './storage';

const setup = async () => {
  const { db } = fixtureWithDocs();
  const up = await addUploads(db, new MemoryBlobStore(), db.getApp('ABCD')!, db.getUser('u-sourav')!, [{ filename: 'team-notes-0303.md', data: Buffer.from('For UAT sign-off every acceptance criterion needs at least one linked test.') }], 'app', undefined);
  const sources = listSources(db, 'ABCD');
  return { db, upload: up.sources[0], jira: sources.find((s) => s.type === 'Jira')!, repo: sources.find((s) => s.type === 'Repository')! };
};

describe('R16: conflict attribution', () => {
  it('flags text given for Jira that is about the README, naming the repository source', async () => {
    const { db, upload, jira, repo } = await setup();
    const r = raiseConflict(db, db.getApp('ABCD')!, db.getUser('u-sourav')!, {
      sourceId: upload.id,
      otherSourceId: jira.id,
      title: 'Sign-off rule: one linked test or two?',
      detail: '',
      compare: [{ value: 'at least one linked test per criterion', where: '' }, { value: 'the README does not state a rule', where: '' }],
    });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain(`refers to ${repo.title} (Repository), not to ${jira.title}`);
    const item = getItem(db, 'ABCD', r.huddleItemId)!;
    expect(item.aiSummary).toContain(`refers to ${repo.title} (Repository)`);
    // Options name the source, and quote what was reported for it.
    expect(item.options.map((o) => o.title)).toEqual([`Keep ${jira.title} ("the README does not state a rule")`, `Use ${upload.title} ("at least one linked test per criterion")`]);
    expect(item.citations.map((c) => c.title)).toEqual([upload.title, jira.title]);
  });

  it('says nothing when each row is about its own source, and a browser label never replaces the source name', async () => {
    const { db, upload, repo } = await setup();
    const r = raiseConflict(db, db.getApp('ABCD')!, db.getUser('u-sourav')!, {
      sourceId: upload.id,
      otherSourceId: repo.id,
      title: 'Sign-off rule',
      detail: '',
      compare: [
        { label: 'Jira', value: 'one linked test', where: '' },
        { value: 'two linked tests', where: 'README.md ¶1' },
      ],
    });
    expect(r.warnings).toEqual([]);
    expect(getItem(db, 'ABCD', r.huddleItemId)!.citations.map((c) => c.title)).toEqual([`${upload.title} · Jira`, repo.title]);
  });
});
