/**
 * Re-seeding follows the team file (R12): a workspace a team no longer lists is removed, and the
 * chats and components that pointed at it fall back to the application instead of leaking the old
 * name into scopes and answers.
 */
import { describe, expect, it } from 'vitest';

import { seedWorkspace } from './db';
import { FIXTURE, fixtureDb } from './fixture';

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
