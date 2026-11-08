/**
 * Test flows, shared by the server (server/flows.ts derives them) and the pages that show them.
 * See docs/FLOWS.md.
 */
import { useEffect, useState } from 'react';

import { http, sessionEpoch, useSession } from './session';

import type { FlowSummary } from './flowTypes';

export * from './flowTypes';

/** Tells every flow view to reload (after an action on a flow, a sign-off or a recorded result). */
export const flowsChanged = () => window.dispatchEvent(new Event('flows:changed'));

/** The application's active flows, refreshed every 20 seconds and after any change, for the nav and Home. */
export function useActiveFlows(): FlowSummary[] | null {
  const { me, loaded } = useSession();
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  useEffect(() => {
    if (!loaded || !me?.app) return;
    const epoch = sessionEpoch();
    let live = true;
    const load = () =>
      http('/api/flows')
        .then((r) => (r.ok ? (r.json() as Promise<{ flows: FlowSummary[] }>) : null))
        .then((d) => {
          if (d && live && epoch === sessionEpoch()) setFlows(d.flows);
        })
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 20_000);
    window.addEventListener('flows:changed', load);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('flows:changed', load);
    };
  }, [loaded, me?.app?.id, me?.user.id]);
  return flows;
}

/** How many stories across the active flows wait on the signed-in person. */
export const waitingOnMe = (flows: FlowSummary[] | null) => (flows ?? []).reduce((n, f) => n + f.waiting.filter((w) => w.you).reduce((m, w) => m + w.stories.length, 0), 0);
