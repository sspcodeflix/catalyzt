/**
 * Test flows inside chat (docs/FLOWS.md). Chat is the convenient way in; the flow keeps the history.
 * So every card here loads the flow's current state from the server, never a copy saved with the
 * answer: an old chat shows today's progress, and acting in the card acts on the flow itself.
 */
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { flowsChanged, useActiveFlows, type FlowSummary, type FlowView } from '../../lib/flows';
import { api } from '../../lib/hexa';
import { sessionEpoch, useSession } from '../../lib/session';
import type { Block } from '../../lib/types';
import { CaseReview, Coverage, FlowCard, Stepper, StoryRow } from '../../pages/Flows';

const KIND = { uat: 'UAT', regression: 'Regression' } as const;

/** One flow, live: its steps, what waits on whom, and the stories waiting on you, with their actions. */
export function FlowChatCard({ flowId }: { flowId: string }) {
  const [flow, setFlow] = useState<FlowView | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const { me, loaded } = useSession();
  const here = useLocation().pathname;
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
      <div className="flowchatlinks">
        <Link to={`/flows/${flow.id}`} className="btn small">
          Open the full flow · {flow.stories} {flow.stories === 1 ? 'story' : 'stories'}, timeline
        </Link>
        {!here.startsWith(`/chat/${flow.threadId}`) && (
          <Link to={`/chat/${flow.threadId}`} className="btn small plain">
            Team thread
          </Link>
        )}
      </div>
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

/** The active flows holding any of these stories, refreshed while shown and after any flow change. */
export function useStoryFlows(stories: string[]): FlowSummary[] | null {
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const { me, loaded } = useSession();
  const key = [...new Set(stories)].sort().join(',');
  useEffect(() => {
    if (!loaded || !me?.app || !key) return;
    const epoch = sessionEpoch();
    let live = true;
    const load = () =>
      api<{ flows: FlowSummary[] }>(`/api/flows?stories=${encodeURIComponent(key)}`)
        .then((d) => live && epoch === sessionEpoch() && setFlows(d.flows))
        .catch(() => undefined);
    void load();
    const timer = setInterval(load, 15_000);
    window.addEventListener('flows:changed', load);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('flows:changed', load);
    };
  }, [loaded, me?.app?.id, me?.user.id, key]);
  return key ? flows : [];
}

/**
 * Above the reply box of a chat about stories that are in a test flow: where the flow stands and who it
 * waits on. Reviewing drafted cases is the flow's own step, so "Review cases" opens it there.
 */
export function StoryFlowBar({ stories }: { stories: string[] }) {
  const flows = useStoryFlows(stories) ?? [];
  if (!flows.length) return null;
  return (
    <div className="storyflowbar" role="status" aria-label="Test flows this chat is part of">
      {flows.slice(0, 2).map((f) => {
        const mine = f.waiting.filter((w) => w.you);
        const other = f.waiting.find((w) => !w.you);
        const review = mine.find((w) => w.action === 'Review cases');
        const reviewKey = review ? (review.stories.find((k) => stories.includes(k)) ?? review.stories[0]) : null;
        return (
          <div key={f.id} className="sfrow">
            <span className="flowkind">{KIND[f.kind]}</span>
            <Link to={`/flows/${f.id}`} className="sftitle">
              {f.title}
            </Link>
            <span className="pill info">{f.current ? `Step: ${f.current.label}` : f.status}</span>
            <span className="sfwait">
              {reviewKey
                ? `Waiting on you: review the drafted cases for ${reviewKey}`
                : mine.length
                  ? `Waiting on you: ${mine.map((w) => w.action.toLowerCase()).join(', ')}`
                  : other
                    ? `Waiting on ${other.person?.name ?? (other.action.startsWith('The UAT analyst') ? 'the agent' : 'the pipeline')}: ${other.action.toLowerCase()}`
                    : 'Nothing waiting'}
            </span>
            {reviewKey ? (
              <Link
                to={`/flows/${f.id}?review=${encodeURIComponent(reviewKey)}`}
                className="btn small ink"
                onClick={(e) => {
                  // The review is in this chat: go to it rather than leave.
                  const here = document.querySelector<HTMLElement>(`.flowhandoff #review-${CSS.escape(reviewKey)}`);
                  if (!here) return;
                  e.preventDefault();
                  here.scrollIntoView({ block: 'center', behavior: 'smooth' });
                }}
              >
                Review cases
              </Link>
            ) : (
              <Link to={`/flows/${f.id}`} className="btn small plain">
                Open flow
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * In a chat, the approval card for drafted cases of a story that is in a test flow becomes the flow's own
 * review, right here: each requirement with its cases, Approve or Request changes, no rating asked. It acts
 * on the flow, so the flow page, its cards and the team see the decision. A story in no flow, or a decided
 * approval, keeps the usual card.
 */
export function FlowReviewHandoff({ storyKey, pending, children }: { storyKey: string | null; pending: boolean; children: React.ReactNode }) {
  const flows = useStoryFlows(storyKey && pending ? [storyKey] : []);
  const flowId = flows?.[0]?.id ?? null;
  const [view, setView] = useState<FlowView | null>(null);
  useEffect(() => {
    if (!flowId) return;
    const epoch = sessionEpoch();
    let live = true;
    const load = () =>
      api<{ flow: FlowView }>(`/api/flows/${flowId}`)
        .then((d) => live && epoch === sessionEpoch() && setView(d.flow))
        .catch(() => undefined);
    void load();
    window.addEventListener('flows:changed', load);
    return () => {
      live = false;
      window.removeEventListener('flows:changed', load);
    };
  }, [flowId]);
  const story = view && view.id === flowId ? view.items.find((s) => s.key === storyKey) : undefined;
  if (!storyKey || !pending || !flowId || !story?.review || story.review.status !== 'pending') return <>{children}</>;
  return (
    <div className="card approve flowhandoff">
      <p className="muted small">
        {storyKey} is in the test flow <Link to={`/flows/${flowId}`}>{view!.title}</Link>. Reviewing here moves the flow on for everyone.
      </p>
      <CaseReview flow={view!} story={story} />
    </div>
  );
}
