/**
 * Re-seeding follows the team file (R12): a workspace a team no longer lists is removed, and the
 * chats and components that pointed at it fall back to the application instead of leaking the old
 * name into scopes and answers.
 */
import { describe, expect, it } from 'vitest';

import { openDb, seedWorkspace } from './db';
import { FIXTURE, fixtureDb, seedRefundTests } from './fixture';

describe('workspaces follow the team file', () => {
  it('removes a dropped workspace and detaches its chats and components', () => {
    const db = fixtureDb();
    expect(db.getApp('ABCD')!.workspaces).toEqual(['storefront', 'payments']);
    db.upsertChat({ id: 'c-pay', title: 'Payments chat', agent: 'auto', workspace: 'payments', userId: 'u-sourav' }, 'ABCD');
    const chatWorkspace = () => (db.raw.prepare("SELECT workspace_id AS w FROM chats WHERE id = 'c-pay'").get() as { w: string | null }).w;
    expect(chatWorkspace()).toBe('ABCD-payments');
    expect(db.getApp('ABCD')!.components.find((c) => c.name === 'checkoutservice')?.workspace).toBe('payments');

    // The team drops "payments"; one component moves to storefront, the other still names the dropped workspace.
    const trimmed = {
      ...FIXTURE,
      teams: FIXTURE.teams.map((t) => (t.id === 'ABCD' ? { ...t, workspaces: ['storefront'], components: t.components.map((c) => (c.name === 'frontend' ? { ...c, workspace: 'storefront' } : c)) } : t)),
    };
    seedWorkspace(db, trimmed);

    expect(db.getApp('ABCD')!.workspaces).toEqual(['storefront']);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE application_id = 'ABCD'").get()).toEqual({ n: 1 });
    expect(chatWorkspace()).toBeNull();
    const comps = db.getApp('ABCD')!.components;
    expect(comps.find((c) => c.name === 'checkoutservice')?.workspace ?? null).toBeNull();
    expect(comps.find((c) => c.name === 'frontend')?.workspace).toBe('storefront');
    // Another team's workspaces are untouched, and seeding the original file brings the workspace back.
    expect(db.getApp('IBGM')!.workspaces).toEqual(['core-banking']);
    seedWorkspace(db, FIXTURE);
    expect(db.getApp('ABCD')!.workspaces).toEqual(['storefront', 'payments']);
  });
});

describe('requirement identity is scoped to the application (F23)', () => {
  it('the same requirement number in two applications stays two records, and foreign associations are refused', () => {
    const ws = { ...FIXTURE, teams: FIXTURE.teams.map((t) => (t.id === 'IBGM' ? { ...t, stories: [{ ...t.stories[0], requirements: ['FR-0231'] }] } : t)) };
    const db = openDb(':memory:');
    seedWorkspace(db, ws);
    expect(db.getStory('ABCD-1001')?.requirements).toEqual(['FR-0231']);
    expect(db.getStory('IBGM-1001')?.requirements).toEqual(['FR-0231']);
    expect(db.raw.prepare("SELECT application_id FROM requirements WHERE external_id = 'FR-0231' ORDER BY application_id").all()).toEqual([{ application_id: 'ABCD' }, { application_id: 'IBGM' }]);
    // Relationships that would join two applications are refused by the database itself.
    expect(() => db.raw.prepare("INSERT INTO story_requirements (story_key, requirement_uid) VALUES ('IBGM-1001', 'ABCD/FR-0231')").run()).toThrow(/another application/);
    expect(() => db.raw.prepare("INSERT INTO story_components (story_key, component_id) VALUES ('IBGM-1001', 'ABCD/frontend')").run()).toThrow(/another application/);
    expect(() => db.upsertChat({ id: 'c-x', title: 'x', agent: 'auto', workspace: 'payments', userId: 'u-nabih' }, 'IBGM')).not.toThrow(); // unknown workspace in IBGM: simply no workspace
    expect(() => db.raw.prepare("UPDATE chats SET workspace_id = 'ABCD-payments' WHERE id = 'c-x'").run()).toThrow(/another application/);
    seedRefundTests(db);
    const test = db.listTests('ABCD').rows[0];
    expect(() => db.linkTest(test.id, 'criterion', 'IBGM-1001#AC1', 'u-ram')).toThrow(/another application/);
    expect(() => db.linkTest(test.id, 'story', 'ABCD-1002', 'u-ram')).not.toThrow();
    db.raw.prepare("INSERT INTO test_runs (id, application_id, source, attempt, status, total, passed, failed, skipped, ingested_at) VALUES ('run-ibgm', 'IBGM', 'webhook', 1, 'passed', 0, 0, 0, 0, 't')").run();
    expect(() => db.raw.prepare("INSERT INTO test_results (run_id, test_case_id, status) VALUES ('run-ibgm', ?, 'passed')").run(test.id)).toThrow(/another application/);
  });
});
