/**
 * Test flows inside chat (docs/FLOWS.md). Chat is the convenient way in; the flow keeps the history.
 * So every card here loads the flow's current state from the server, never a copy saved with the
 * answer: an old chat shows today's progress, and acting in the card acts on the flow itself.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { flowsChanged, useActiveFlows, type FlowView } from '../../lib/flows';
import { api } from '../../lib/hexa';
import { sessionEpoch, useSession } from '../../lib/session';
import type { Block } from '../../lib/types';
import { Coverage, FlowCard, Stepper, StoryRow } from '../../pages/Flows';

const KIND = { uat: 'UAT', regression: 'Regression' } as const;

/** One flow, live: its steps, what waits on whom, and the stories waiting on you, with their actions. */
export function FlowChatCard({ flowId }: { flowId: string }) {
  const [flow, setFlow] = useState<FlowView | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const { me, loaded } = useSession();
  useEffect(() => {
    if (!loaded || !me?.app) return;
    const epoch = sessionEpoch();
    let live = true;
    const load = () =>
      api<{ flow: FlowView }>(`/api/flows/${flowId}`)
        .then((d) => live && epoch === sessionEpoch() && setFlow(d.flow))
        .catch((e) => live && setError((e as Error).message));
    void load();
    const timer = setInterval(load, 10_000);
    window.addEventListener('flows:changed', load);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('flows:changed', load);
    };
  }, [loaded, me?.app?.id, me?.user.id, flowId]);
  const post = async (path: string, body: unknown) => {
    setError('');
    try {
      const r = await api<{ flow: FlowView }>(`/api/flows/${flowId}/${path}`, { method: 'POST', body: JSON.stringify(body) });
      setFlow(r.flow);
      flowsChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!flow)
    return (
      <section className="card flowchat" aria-label="Test flow">
        <p className={error ? 'errtext' : 'muted'} role={error ? 'alert' : undefined}>
          {error || 'Loading the flow…'}
        </p>
      </section>
    );
  const mineKeys = new Set(flow.waiting.filter((w) => w.you).flatMap((w) => w.stories));
  const mine = flow.items.filter((s) => mineKeys.has(s.key)).slice(0, 5);
  const others = flow.waiting.filter((w) => !w.you).slice(0, 3);
  return (
    <section className="card flowchat" aria-label={`Test flow ${flow.title}`}>
      <div className="flowtitle">
        <span className="flowkind">{KIND[flow.kind]}</span>
        <Link to={`/flows/${flow.id}`}>
          <b>{flow.title}</b>
        </Link>
        <span className={`pill ${flow.status === 'done' ? 'pass' : flow.status === 'active' ? 'info' : 'warn'}`}>{flow.status === 'active' && flow.current ? `Step: ${flow.current.label}` : flow.status}</span>
      </div>
      <Stepper flow={flow} />
      <Coverage c={flow.coverage} kind={flow.kind} />
      {error && (
        <p className="errtext" role="alert">
          {error}
        </p>
      )}
      {mine.length > 0 && (
        <div className="flowchatmine">
          <b>Waiting on you</b>
          {mine.map((s) => (
            <StoryRow key={s.key} flow={flow} story={s} open={open === s.key} onToggle={() => setOpen(open === s.key ? null : s.key)} post={post} />
          ))}
          {mineKeys.size > mine.length && <span className="muted">and {mineKeys.size - mine.length} more on the flow page.</span>}
        </div>
      )}
      {others.length > 0 && (
        <ul className="flowchatothers">
          {others.map((w, i) => (
            <li key={i}>
              <b>{w.person?.name ?? (w.action.startsWith('The UAT analyst') ? 'Agent' : 'Pipeline')}</b>: {w.action.toLowerCase()} · {w.stories.slice(0, 4).join(', ')}
              {w.stories.length > 4 ? ` and ${w.stories.length - 4} more` : ''}
            </li>
          ))}
        </ul>
      )}
      <Link to={`/flows/${flow.id}`} className="btn small">
        Open the full flow · {flow.stories} {flow.stories === 1 ? 'story' : 'stories'}, timeline
      </Link>
    </section>
  );
}

/** A proposed flow: the stories found, to untick, and Start. Once started, the card is the live flow. */
export function FlowStartCard({ block, revisionId }: { block: Extract<Block, { kind: 'flow_start' }>; revisionId: string | null | undefined }) {
  const [started, setStarted] = useState<string | null | undefined>(revisionId ? undefined : null);
  const [picked, setPicked] = useState(() => new Set(block.stories.map((s) => s.key)));
  const [title, setTitle] = useState(block.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const roles = useSession().me?.app?.roles ?? [];
  const allowed = roles.includes('app_owner') || roles.includes('component_manager');
  useEffect(() => {
    if (!revisionId) return;
    api<{ flowId: string | null }>(`/api/flows?origin=${encodeURIComponent(revisionId)}`)
      .then((d) => setStarted(d.flowId))
      .catch(() => setStarted(null));
  }, [revisionId]);
  if (started) return <FlowChatCard flowId={started} />;
  const toggle = (k: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ flow: FlowView }>('/api/flows', { method: 'POST', body: JSON.stringify({ kind: block.flowKind, title, stories: [...picked], origin: revisionId }) });
      flowsChanged();
      setStarted(r.flow.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const lock = !revisionId ? 'Waiting for the answer to be saved' : !allowed ? 'Only an app owner or a component manager can start a flow' : picked.size === 0 ? 'Choose at least one story' : null;
  return (
    <section className="card flowchat flowstartcard" aria-label={`Start a ${KIND[block.flowKind]} flow`}>
      <div className="flowtitle">
        <span className="flowkind">{KIND[block.flowKind]}</span>
        <b>New flow</b>
      </div>
      <label className="flowtitlefield">
        <span>Name</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      </label>
      <ul className="flowstartlist">
        {block.stories.map((s) => (
          <li key={s.key}>
            <label>
              <input type="checkbox" checked={picked.has(s.key)} onChange={() => toggle(s.key)} />
              <span className="mono">{s.key}</span>
              <span className="grow">{s.summary}</span>
              {s.note && <small className="muted">{s.note}</small>}
            </label>
          </li>
        ))}
      </ul>
      <div className="flowstartbar">
        <button type="button" className="btn ink" disabled={busy || !!lock || started === undefined} onClick={() => void start()}>
          {busy ? 'Starting…' : `Start with ${picked.size} ${picked.size === 1 ? 'story' : 'stories'}`}
        </button>
        {lock && <span className="muted">{lock}</span>}
        {error && (
          <span className="errtext" role="alert">
            {error}
          </span>
        )}
      </div>
    </section>
  );
}

/** What waits on the person across the active flows, live. */
export function FlowsWaitingCard() {
  const flows = useActiveFlows();
  if (!flows) return <p className="muted">Loading the flows…</p>;
  if (!flows.length) return <p className="muted">No test flow is running.</p>;
  return (
    <div className="flowchatlist">
      {flows.map((f) => (
        <FlowCard key={f.id} flow={f} compact />
      ))}
    </div>
  );
}
