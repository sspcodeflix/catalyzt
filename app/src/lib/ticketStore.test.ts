import { describe, expect, it } from 'vitest';

import { applyStories, getTickets, recordUatAnalysis, uatBadge } from './ticketStore';
import type { Ticket } from './types';

const story = (key: string, uat?: Ticket['uat']) => ({
  key,
  summary: key,
  type: 'Story' as const,
  status: 'Ready for UAT',
  fixVersion: '1.0',
  components: [],
  assignee: '',
  updated: '2026-11-08T00:00:00Z',
  description: '',
  acceptanceCriteria: ['AC1', 'AC2'],
  requirements: [],
  ...(uat ? { uat } : {}),
});
const filter = { project: 'IBGM', statuses: ['Ready for UAT' as const], everyMinutes: 15, lastSyncAt: '2026-11-08T00:00:00Z' };

describe('Jira Stories badge (R14)', () => {
  it('opening a saved chat does not move the count or replace a newer saved analysis', () => {
    applyStories({ stories: [story('A-1', { state: 'ready', covered: 2, total: 2, chatId: 'new' }), story('A-2'), story('A-3')], filter });
    expect(uatBadge(getTickets())).toEqual({ count: 2, label: '2 of 3 stories in the Jira filter not analysed for UAT yet' });
    // An older chat of A-1 with gaps is opened: the newer saved state stays.
    recordUatAnalysis('A-1', 'old', ['passing', 'no-test'], { saved: true });
    expect(getTickets().find((t) => t.key === 'A-1')!.uat).toMatchObject({ state: 'ready', chatId: 'new' });
    expect(uatBadge(getTickets()).count).toBe(2);
    // A saved chat for a story the list has nothing for fills it in.
    recordUatAnalysis('A-2', 'c2', ['passing', 'not-run'], { saved: true });
    expect(uatBadge(getTickets()).count).toBe(1);
    // An analysis that just ran replaces what the story showed.
    recordUatAnalysis('A-1', 'live', ['failing', 'passing']);
    expect(getTickets().find((t) => t.key === 'A-1')!.uat).toMatchObject({ state: 'gaps', chatId: 'live' });
  });
});
