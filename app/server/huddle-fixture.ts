/**
 * Huddle test data: the fixture workspace plus an SRE lead and a security champion (given by team.json
 * "roles" and personas "roles", the way a workspace assigns them), and a few realistic items per
 * portfolio across testing, reliability and security. Server tests only; never seeded into the live
 * workspace.
 */
import { openDb, seedWorkspace, type HorizonDb } from './db';
import { FIXTURE } from './fixture';
import { addAction, createItem } from './huddle';
import type { Workspace } from './workspace';

export const HUDDLE_FIXTURE: Workspace = {
  ...FIXTURE,
  people: [
    ...FIXTURE.people,
    // A further role on the person (personas.json "roles").
    { id: 'u-omar', name: 'Omar', initials: 'OM', email: 'omar@example.com', app: 'ABCD', role: 'member', roles: ['sre_lead'] },
    { id: 'u-lena', name: 'Lena', initials: 'LN', email: 'lena@example.com', app: 'ABCD', role: 'member' },
  ],
  // A role given by the team (team.json "roles").
  teams: FIXTURE.teams.map((t) => (t.id === 'ABCD' ? { ...t, roles: [{ user: 'u-lena', role: 'security_champion' as const }] } : t)),
};

export function huddleFixtureDb(): HorizonDb {
  const db = openDb(':memory:');
  seedWorkspace(db, HUDDLE_FIXTURE);
  return db;
}

/** A few realistic items per portfolio, one per domain that portfolio has people for. */
export function seedHuddleExamples(db: HorizonDb) {
  const abcd = db.getApp('ABCD')!;
  const ibgm = db.getApp('IBGM')!;
  const base = { scope: "Ram's Portfolio", aiSummary: '', citations: [], affects: [] };
  const flaky = createItem(db, abcd, { type: 'user', ref: 'u-devi' }, {
    ...base,
    kind: 'concern',
    title: 'Is the flaky refund test hiding a real bug?',
    summary: 'PartialRefundsTest failed twice this week on the same assertion, then passed on retry.',
    options: [],
    links: [
      { type: 'story', ref: 'ABCD-1001', label: 'ABCD-1001', href: '/tickets/ABCD-1001' },
      { type: 'component', ref: 'checkoutservice', label: 'checkoutservice' },
    ],
  });
  const restart = createItem(db, abcd, { type: 'agent', ref: 'Catalyzt' }, {
    ...base,
    kind: 'capacity_warning',
    title: 'cartservice memory reaches its limit in about 3 h at this rate',
    summary: 'Memory grew 40 MB an hour since the 09:00 deploy; the limit is 512 MB.',
    options: [
      { title: 'Scale to 3 replicas now', detail: 'Through the approval card; no restart.' },
      { title: 'Restart during the quiet hour', detail: 'Clears the growth; does not fix it.' },
      { title: 'Investigate first', detail: 'Profile the heap before changing anything.' },
    ],
    links: [{ type: 'deployment', ref: 'cartservice@2026-11-08T09:00', label: 'cartservice 09:00 deploy' }],
  });
  const cve = createItem(db, abcd, { type: 'agent', ref: 'Catalyzt' }, {
    ...base,
    kind: 'vulnerability',
    severity: 'high',
    title: 'CVE-2026-1234 in golang.org/x/net used by frontend',
    summary: 'The HTTP/2 handler can be made to allocate without bound; a fixed version exists.',
    options: [
      { title: 'Upgrade now', detail: 'Bump golang.org/x/net to the fixed version.' },
      { title: 'Accept until the next release', detail: 'The frontend sits behind the load balancer that limits streams.' },
    ],
    links: [
      { type: 'cve', ref: 'CVE-2026-1234', label: 'CVE-2026-1234' },
      { type: 'component', ref: 'frontend', label: 'frontend' },
    ],
  });
  const followup = createItem(db, ibgm, { type: 'user', ref: 'u-nabih' }, {
    ...base,
    scope: "Nabih's Portfolio",
    kind: 'incident_followup',
    title: 'Statement export timed out for an hour',
    summary: 'Exports queued behind a long-running report; customers saw a spinner.',
    options: [
      { title: 'Split the report queue', detail: 'Exports never wait behind reports.' },
      { title: 'Raise the export timeout', detail: 'Quicker, but hides the queueing.' },
    ],
  });
  addAction(db, 'IBGM', followup.id, 'u-nabih', { title: 'Write the post-incident review', ownerId: 'u-nabih', dueAt: '2026-11-12' });
  return { flaky, restart, cve, followup };
}
