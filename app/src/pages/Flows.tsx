/**
 * Test flows (docs/FLOWS.md): where a UAT or regression effort stands, the same for everyone on the
 * team. Three screens: the list, starting a flow, and one flow with its steps, who it waits on, and
 * the actions that move it on. Every state comes from the server, derived from the records.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { Icon } from '../components/Icon';
import { api } from '../lib/hexa';
import { flowsChanged, STEPS, type FlowKind, type FlowStory, type FlowSummary, type FlowView, type StoryStep } from '../lib/flows';
import { sessionEpoch, useSession } from '../lib/session';
import { useTickets } from '../lib/ticketStore';

const KIND_LABEL: Record<FlowKind, string> = { uat: 'UAT', regression: 'Regression' };
const STATUS_TONE: Record<string, string> = { active: 'info', paused: 'warn', done: 'pass', cancelled: '' };
const STATE_TONE: Record<string, string> = { done: 'pass', skipped: '', working: 'info', waiting: 'warn', blocked: 'crit', todo: '' };
const STATE_LABEL: Record<string, string> = { done: 'Done', skipped: 'Not needed', working: 'Agent working', waiting: 'Waiting', blocked: 'Blocked', todo: 'Not started' };

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const ago = (iso: string | null | undefined) => {
  if (!iso) return '';
  const h = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  return h < 1 ? 'just now' : h < 24 ? `${h} h` : `${Math.round(h / 24)} d`;
};
const names = (list: { name: string }[], me?: string) => list.map((p) => (p.name === me ? 'you' : p.name)).join(' or ');

function Head({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="pagehead withaction">
      <div>
        <span className="appname">
          <Icon name="layers" small />
          {useSession().me?.app?.name ?? 'Loading…'}
        </span>
        <h1>{title}</h1>
      </div>
      {children}
    </div>
  );
}

/** The steps as a row: what is done across the flow's stories, and where the flow is. */
export function Stepper({ flow }: { flow: FlowSummary }) {
  return (
    <ol className="flowsteps" aria-label="Steps">
      {flow.steps.map((s, i) => {
        const all = flow.stories > 0 && s.done === flow.stories;
        const here = flow.current?.key === s.key;
        return (
          <li key={s.key} className={all ? 'done' : here ? 'here' : ''} aria-current={here ? 'step' : undefined}>
            <span className="dot" aria-hidden="true">
              {all ? <Icon name="check" small /> : i + 1}
            </span>
            <span className="lbl">
              <b>{s.label}</b>
              <small>
                {s.done} of {flow.stories}
              </small>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function Coverage({ c, kind }: { c: FlowSummary['coverage']; kind: FlowKind }) {
  return (
    <p className="flowcov">
      <span>
        <b>{c.baseline}%</b> at the start
      </span>
      <Icon name="right" small />
      <span>
        <b>{c.now}%</b> now
      </span>
      <span className="muted">
        of {c.criteria} acceptance criteria {kind === 'uat' ? 'verified by a passing test or a tester' : 'covered by an automated test that passed in CI'}
      </span>
    </p>
  );
}

/* ---------- List ---------- */

export function Flows() {
  const [flows, setFlows] = useState<FlowSummary[] | null>(null);
  const [error, setError] = useState('');
  const { me, loaded } = useSession();
  // Another application's flows never stay on screen after a switch.
  useEffect(() => setFlows(null), [me?.app?.id]);
  useEffect(() => {
    if (!loaded || !me?.app) return;
    const epoch = sessionEpoch();
    let live = true;
    // A failed load keeps the flows already on screen and tries again: a server restart or a dropped
    // connection must never look like the flows are gone.
    const load = () =>
      api<{ flows: FlowSummary[] }>('/api/flows?all=1')
        .then((d) => {
          if (!live || epoch !== sessionEpoch()) return;
          setFlows(d.flows);
          setError('');
        })
        .catch((e) => live && setError(`Could not load the flows right now (${(e as Error).message}). Trying again…`));
    void load();
    const timer = setInterval(load, 15_000);
    window.addEventListener('flows:changed', load);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('flows:changed', load);
    };
  }, [loaded, me?.app?.id, me?.user.id]);
  const active = (flows ?? []).filter((f) => f.status === 'active' || f.status === 'paused');
  const past = (flows ?? []).filter((f) => f.status === 'done' || f.status === 'cancelled');
  return (
    <div className="body panelpage">
      <div className="chatcol listcol">
        <div className="page">
          <Head title="Test flows">
            <Link to="/flows/new" className="btn ink">
              <Icon name="plus" small /> Start a test flow
            </Link>
          </Head>
          <p className="muted lead">A flow takes a set of stories through UAT or regression. Everyone on the team sees the same steps and who each one waits on.</p>
          {error && (
            <p className="errtext" role="alert">
              {error}
            </p>
          )}
          {!flows && !error && <p className="muted">Loading the flows…</p>}
          {flows && active.length === 0 && (
            <section className="card flowempty">
              <b>No flow is running.</b>
              <span className="muted">Start one from a set of Jira stories (UAT), or from the coverage gaps of the whole application (regression).</span>
            </section>
          )}
          {active.map((f) => (
            <FlowCard key={f.id} flow={f} />
          ))}
          {past.length > 0 && (
            <details className="flowpast">
              <summary>Finished and cancelled ({past.length})</summary>
              {past.map((f) => (
                <FlowCard key={f.id} flow={f} />
              ))}
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

/** One flow in a list, Home or chat: its title, step, and what waits on whom. */
export function FlowCard({ flow, compact }: { flow: FlowSummary; compact?: boolean }) {
  const me = useSession().me?.user.name;
  const mine = flow.waiting.filter((w) => w.you);
  const others = flow.waiting.filter((w) => !w.you);
  return (
    <Link to={`/flows/${flow.id}`} className={`card flowcard${compact ? ' compact' : ''}`}>
      <span className="flowtitle">
        <span className="flowkind">{KIND_LABEL[flow.kind]}</span>
        <b>{flow.title}</b>
        <span className={`pill ${STATUS_TONE[flow.status] ?? ''}`}>{flow.status === 'active' ? (flow.current ? `Step: ${flow.current.label}` : 'Active') : flow.status[0].toUpperCase() + flow.status.slice(1)}</span>
      </span>
      {!compact && <Stepper flow={flow} />}
      <span className="flowwait">
        {mine.length > 0 && (
          <span className="pill info">
            Waiting on you: {mine.map((w) => `${w.action.toLowerCase()} (${w.stories.length})`).join(', ')}
          </span>
        )}
        {others.slice(0, compact ? 1 : 3).map((w, i) => (
          <span key={i} className="muted">
            {w.person ? `${w.person.name === me ? 'You' : w.person.name}: ` : ''}
            {w.action.toLowerCase()} · {w.stories.length} {w.stories.length === 1 ? 'story' : 'stories'}
            {w.since ? ` · ${ago(w.since)}` : ''}
          </span>
        ))}
        {flow.status === 'active' && flow.waiting.length === 0 && <span className="muted">Nothing waiting.</span>}
      </span>
      <span className="muted small">
        {flow.stories} {flow.stories === 1 ? 'story' : 'stories'} · {flow.coverage.baseline}% → {flow.coverage.now}% · started by {flow.owner.name} on {day(flow.createdAt)}
      </span>
    </Link>
  );
}

/* ---------- Start ---------- */

interface AppCoverage {
  criteria: number;
  covered: number;
  stories: number;
  components: { name: string; repo: string | null; manager: string | null; criteria: number; covered: number; automatedTests: number; lastBuild: { label: string; at: string } | null }[];
  gaps: { key: string; summary: string; purpose: string | null; status: string; components: string[]; uncovered: string[]; criteria: number }[];
  lastScan: { at: string | null; repo: string } | null;
}

/** "In <flow>" next to a story already in a flow of this kind. */
function InFlow({ k, taken }: { k: string; taken: Map<string, { flowId: string; title: string }> }) {
  const f = taken.get(k);
  return f ? (
    <small className="pill info">
      In <Link to={`/flows/${f.flowId}`}>{f.title}</Link>
    </small>
  ) : null;
}

export function FlowStart() {
  const navigate = useNavigate();
  const [kind, setKind] = useState<FlowKind>('uat');
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('Ready for UAT');
  const [cov, setCov] = useState<AppCoverage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Stories already in a flow of this kind: shown with that flow, not pickable (one flow per story and kind).
  const [taken, setTaken] = useState<Map<string, { flowId: string; title: string }>>(new Map());
  const tickets = useTickets();
  const appName = useSession().me?.app?.name ?? '';
  const statuses = useMemo(() => [...new Set(tickets.map((t) => t.status))], [tickets]);
  const shown = kind === 'uat' ? tickets.filter((t) => !status || t.status === status) : [];

  useEffect(() => {
    let live = true;
    api<{ taken: { key: string; flowId: string; title: string }[] }>(`/api/flows/taken?kind=${kind}`)
      .then((d) => {
        if (!live) return;
        const m = new Map(d.taken.map((t) => [t.key, { flowId: t.flowId, title: t.title }]));
        setTaken(m);
        setPicked((p) => new Set([...p].filter((k) => !m.has(k))));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [kind]);
  useEffect(() => {
    if (kind !== 'regression' || cov) return;
    api<AppCoverage>('/api/flows/coverage')
      .then((c) => {
        setCov(c);
        setPicked(new Set(c.gaps.map((g) => g.key).filter((k) => !taken.has(k))));
      })
      .catch((e) => setError((e as Error).message));
  }, [kind, cov]);
  const switchKind = (k: FlowKind) => {
    setKind(k);
    setPicked(k === 'regression' && cov ? new Set(cov.gaps.map((g) => g.key).filter((x) => !taken.has(x))) : new Set());
    setError('');
  };
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
      const r = await api<{ flow: FlowView }>('/api/flows', { method: 'POST', body: JSON.stringify({ kind, title, stories: [...picked] }) });
      flowsChanged();
      navigate(`/flows/${r.flow.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

  return (
    <div className="body panelpage">
      <div className="chatcol listcol">
        <div className="page">
          <Head title="Start a test flow" />
          <div className="segctl" role="group" aria-label="Kind of flow">
            <button type="button" className={kind === 'uat' ? 'on' : undefined} aria-pressed={kind === 'uat'} onClick={() => switchKind('uat')}>
              UAT
            </button>
            <button type="button" className={kind === 'regression' ? 'on' : undefined} aria-pressed={kind === 'regression'} onClick={() => switchKind('regression')}>
              Regression
            </button>
          </div>
          <p className="muted lead">
            {kind === 'uat'
              ? 'Choose the stories to take to UAT. Each one is analysed against its tests, gaps get drafted cases for the component manager to review, testers record results, and the product owner signs off.'
              : 'Regression starts from what the application covers today. Choose the gaps to close: each one is analysed, cases are reviewed, automation is written and merged, and CI must pass it.'}
          </p>

          {kind === 'regression' && cov && (
            <section className="card flowbase" aria-label="Coverage today">
              <p className="flowcov">
                <span>
                  <b>{pct(cov.covered, cov.criteria)}%</b> covered today
                </span>
                <span className="muted">
                  {cov.covered} of {cov.criteria} acceptance criteria across {cov.stories} stories have an automated test that passed in CI
                </span>
              </p>
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Component</th>
                      <th scope="col">Covered</th>
                      <th scope="col">Automated tests</th>
                      <th scope="col">Latest build</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cov.components.map((c) => (
                      <tr key={c.name}>
                        <td>
                          <b>{c.name}</b>
                          <small className="muted"> {c.manager ?? ''}</small>
                        </td>
                        <td>{c.criteria ? `${pct(c.covered, c.criteria)}% (${c.covered} of ${c.criteria})` : 'no criteria'}</td>
                        <td>{c.automatedTests}</td>
                        <td>{c.lastBuild ? `${c.lastBuild.label}` : <span className="pill warn">No CI results</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {kind === 'uat' && (
            <div className="chips" role="group" aria-label="Jira status">
              {statuses.map((s) => (
                <button key={s} type="button" className={`chip${status === s ? ' on' : ''}`} aria-pressed={status === s} onClick={() => setStatus(status === s ? '' : s)}>
                  {s}
                </button>
              ))}
            </div>
          )}

          <section className="card flowpick" aria-label={kind === 'uat' ? 'Stories' : 'Gaps'}>
            <div className="flowpickhead">
              <b>{kind === 'uat' ? `${shown.length} stories` : `${cov?.gaps.length ?? 0} stories with gaps`}</b>
              <button
                type="button"
                className="btn plain small"
                onClick={() => setPicked(new Set((kind === 'uat' ? shown.map((t) => t.key) : (cov?.gaps ?? []).map((g) => g.key)).filter((k) => !taken.has(k))))}
              >
                Select all
              </button>
              <button type="button" className="btn plain small" onClick={() => setPicked(new Set())}>
                Clear
              </button>
            </div>
            <ul>
              {kind === 'uat' &&
                shown.map((t) => (
                  <li key={t.key} className={taken.has(t.key) ? 'taken' : undefined}>
                    <label>
                      <input type="checkbox" checked={picked.has(t.key)} disabled={taken.has(t.key)} onChange={() => toggle(t.key)} />
                      <span className="mono">{t.key}</span>
                      <span className="grow">{t.summary}</span>
                      <InFlow k={t.key} taken={taken} />
                      <small className="muted">
                        {t.acceptanceCriteria.length} criteria · {t.components.join(', ') || 'no component'}
                      </small>
                    </label>
                  </li>
                ))}
              {kind === 'regression' &&
                (cov?.gaps ?? []).map((g) => (
                  <li key={g.key} className={taken.has(g.key) ? 'taken' : undefined}>
                    <label>
                      <input type="checkbox" checked={picked.has(g.key)} disabled={taken.has(g.key)} onChange={() => toggle(g.key)} />
                      <span className="mono">{g.key}</span>
                      <span className="grow">{g.summary}</span>
                      <InFlow k={g.key} taken={taken} />
                      <small className="muted">
                        {g.uncovered.length} of {g.criteria} uncovered ({g.uncovered.join(', ')}) · {g.components.join(', ') || 'no component'}
                      </small>
                    </label>
                  </li>
                ))}
              {kind === 'regression' && !cov && !error && <li className="muted">Measuring coverage…</li>}
            </ul>
          </section>

          <label className="flowtitlefield">
            <span>Name (optional)</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={kind === 'uat' ? 'UAT · release 24.11' : `Regression · ${appName}`} maxLength={120} />
          </label>
          <div className="flowstartbar">
            <button type="button" className="btn ink" disabled={busy || picked.size === 0} onClick={() => void start()}>
              {busy ? 'Starting…' : `Start with ${picked.size} ${picked.size === 1 ? 'story' : 'stories'}`}
            </button>
            {error && (
              <span className="errtext" role="alert">
                {error}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- One flow ---------- */

export function FlowDetail() {
  const { flowId } = useParams();
  const [flow, setFlow] = useState<FlowView | null>(null);
  const [error, setError] = useState('');
  // ?review=KEY (from a chat card or a story chat) opens that story at its review.
  const [params] = useSearchParams();
  const reviewKey = params.get('review');
  const [open, setOpen] = useState<string | null>(reviewKey);
  const { me, loaded } = useSession();
  const hasFlow = !!flow;
  useEffect(() => {
    if (!reviewKey || !hasFlow) return;
    setOpen(reviewKey);
    const t = setTimeout(() => document.getElementById(`review-${reviewKey}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 150);
    return () => clearTimeout(t);
  }, [reviewKey, hasFlow]);

  useEffect(() => {
    if (!loaded || !me?.app || !flowId) return;
    const epoch = sessionEpoch();
    let live = true;
    const load = () =>
      api<{ flow: FlowView }>(`/api/flows/${flowId}`)
        .then((d) => live && epoch === sessionEpoch() && setFlow(d.flow))
        .catch((e) => live && setError((e as Error).message));
    void load();
    // Agent steps and other people's actions arrive while the page is open.
    const timer = setInterval(load, 8_000);
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
      <div className="body panelpage">
        <div className="chatcol listcol">
          <div className="page">
            <Head title="Test flow" />
            <p className={error ? 'errtext' : 'muted'} role={error ? 'alert' : undefined}>
              {error || 'Loading…'}
            </p>
          </div>
        </div>
      </div>
    );

  const mine = flow.waiting.filter((w) => w.you);
  return (
    <div className="body panelpage">
      <div className="chatcol listcol">
        <div className="page">
          <Head title={flow.title}>
            {flow.canManage && (flow.status === 'active' || flow.status === 'paused') && (
              <div className="flowmanage">
                <button type="button" className="btn" onClick={() => void post('status', { status: flow.status === 'active' ? 'paused' : 'active' })}>
                  {flow.status === 'active' ? 'Pause' : 'Resume'}
                </button>
                <button type="button" className="btn plain" onClick={() => window.confirm('Cancel this flow? Its history is kept.') && void post('status', { status: 'cancelled' })}>
                  Cancel flow
                </button>
              </div>
            )}
          </Head>
          <p className="muted lead">
            <span className="flowkind">{KIND_LABEL[flow.kind]}</span> {flow.stories} {flow.stories === 1 ? 'story' : 'stories'} · started by {flow.owner.name} on {day(flow.createdAt)} ·{' '}
            <span className={`pill ${STATUS_TONE[flow.status] ?? ''}`}>{flow.status}</span>
          </p>
          {error && (
            <p className="errtext" role="alert">
              {error}
            </p>
          )}

          <p className="flowthreadlink">
            <Link to={`/chat/${flow.threadId}`} className="btn small">
              <Icon name="people" small /> Team thread
            </Link>
            <span className="muted">Ask about this flow and discuss it with the team; its steps show up there as they happen.</span>
          </p>
          <section className="card flowhead" aria-label="Where the flow stands">
            <Stepper flow={flow} />
            <Coverage c={flow.coverage} kind={flow.kind} />
          </section>

          {flow.status === 'active' && (
            <section className="card flowwaiting" aria-labelledby="waiting-h">
              <h2 id="waiting-h">{mine.length ? 'Waiting on you' : flow.waiting.length ? 'Waiting on' : 'Nothing is waiting'}</h2>
              <ul>
                {flow.waiting.map((w, i) => (
                  <li key={i} className={w.you ? 'you' : ''}>
                    <span className="who">{w.person ? (w.you ? 'You' : w.person.name) : w.action.startsWith('The UAT analyst') ? 'Agent' : 'Pipeline'}</span>
                    <span className="what">
                      {w.action}
                      <span className="muted">
                        {' '}
                        · {w.stories.slice(0, 6).join(', ')}
                        {w.stories.length > 6 ? ` and ${w.stories.length - 6} more` : ''}
                        {w.since ? ` · waiting ${ago(w.since)}` : ''}
                      </span>
                    </span>
                    {w.you && (
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => {
                          setOpen(w.stories[0]);
                          requestAnimationFrame(() => document.getElementById(`story-${w.stories[0]}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
                        }}
                      >
                        Start
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {flow.status === 'paused' && <p className="pill warn">Paused: nothing new is started until it is resumed.</p>}

          <section className="flowstories" aria-label="Stories">
            {flow.items.map((s) => (
              <StoryRow key={s.key} flow={flow} story={s} open={open === s.key} onToggle={() => setOpen(open === s.key ? null : s.key)} post={post} />
            ))}
          </section>

          <details className="flowtimeline">
            <summary>Timeline ({flow.events.length})</summary>
            <ol>
              {flow.events.map((e, i) => (
                <li key={i}>
                  <time dateTime={e.at}>{new Date(e.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time>
                  <span>
                    {e.who ? <b>{e.who}: </b> : <b>Catalyzt: </b>}
                    {e.text}
                  </span>
                </li>
              ))}
            </ol>
          </details>
        </div>
      </div>
    </div>
  );
}

export function StoryRow({ flow, story, open, onToggle, post }: { flow: FlowView; story: FlowStory; open: boolean; onToggle: () => void; post: (path: string, body: unknown) => Promise<void> }) {
  const me = useSession().me?.user.name;
  const step = story.steps.find((s) => s.key === story.current);
  const labels = STEPS[flow.kind];
  return (
    <article className={`card flowstory${open ? ' open' : ''}`} id={`story-${story.key}`}>
      <button type="button" className="flowstoryhead" aria-expanded={open} onClick={onToggle}>
        <span className="mono">{story.key}</span>
        <span className="grow">{story.summary}</span>
        <span className="ministeps" aria-label={`Step ${step ? labels.find((l) => l.key === step.key)?.label : 'all done'}`}>
          {story.steps.map((s) => (
            <span key={s.key} className={`ms ${s.state}`} title={`${labels.find((l) => l.key === s.key)?.label}: ${STATE_LABEL[s.state]}`} />
          ))}
        </span>
        <span className={`pill ${step ? STATE_TONE[step.state] : 'pass'}`}>{step ? `${labels.find((l) => l.key === step.key)?.label}: ${STATE_LABEL[step.state]}` : 'Through the flow'}</span>
      </button>
      {step && (
        <p className="flownext">
          {step.detail}
          {step.waitingOn.length > 0 && <span className="muted"> Waiting on {names(step.waitingOn, me)}.</span>} <ActionButton flow={flow} story={story} step={step} post={post} onOpen={onToggle} open={open} />
        </p>
      )}
      {open && <StoryDetail flow={flow} story={story} post={post} />}
    </article>
  );
}

function ActionButton({ flow, story, step, post, onOpen, open }: { flow: FlowView; story: FlowStory; step: StoryStep; post: (path: string, body: unknown) => Promise<void>; onOpen: () => void; open: boolean }) {
  const a = step.action;
  if (!a || a.kind === 'wait' || flow.status !== 'active') return null;
  if (a.href) {
    return (
      <Link to={a.href} className="btn small">
        {a.label}
      </Link>
    );
  }
  if (a.kind === 'analyse')
    return (
      <button type="button" className="btn small" onClick={() => void post('analyse', { storyKey: story.key })}>
        {a.label}
      </button>
    );
  // Recording results and signing off happen in the story's own section below.
  return open ? null : (
    <button type="button" className="btn small" onClick={onOpen}>
      {a.label}
    </button>
  );
}

function StoryDetail({ flow, story, post }: { flow: FlowView; story: FlowStory; post: (path: string, body: unknown) => Promise<void> }) {
  const labels = STEPS[flow.kind];
  const [note, setNote] = useState('');
  const signStep = story.steps.find((s) => s.key === 'signoff');
  // Results are recorded once the cases are reviewed: from the Run tests step on.
  const runnable = ['run', 'signoff', null].includes(story.current) && story.steps.find((s) => s.key === 'review')?.state !== 'waiting';
  return (
    <div className="flowdetail">
      {story.review?.status === 'pending' && <CaseReview flow={flow} story={story} />}
      <ol className="flowstorysteps">
        {story.steps.map((s) => (
          <li key={s.key} className={s.state}>
            <b>{labels.find((l) => l.key === s.key)?.label}</b> <span className={`pill ${STATE_TONE[s.state]}`}>{STATE_LABEL[s.state]}</span>
            <span className="muted"> {s.detail}</span>
            {s.action?.href && s.state === 'done' && (
              <>
                {' '}
                <Link to={s.action.href}>{s.action.label}</Link>
              </>
            )}
          </li>
        ))}
      </ol>
      <h3>Acceptance criteria</h3>
      <ul className="flowcriteria">
        {story.criteria.map((c) => {
          const cases = story.manual.filter((m) => m.criterion === c.id);
          return (
            <li key={c.id}>
              <span className={`pill ${c.verified ? 'pass' : c.status === 'failing' ? 'crit' : ''}`}>{c.verified ? 'Verified' : c.status === 'failing' ? 'Failing' : c.status === 'no-test' ? 'No test' : 'Not verified'}</span>
              <span>
                <b>{c.id}</b> {c.text}
              </span>
              {flow.kind === 'uat' && cases.map((m) => <ManualRow key={m.id} m={m} canExecute={runnable && flow.canExecute && flow.status === 'active'} />)}
            </li>
          );
        })}
      </ul>
      <p className="muted small">
        <Link to={`/tickets/${story.key}`}>Open the story</Link>
        {story.chatId && (
          <>
            {' · '}
            <Link to={`/chat/${story.chatId}`}>Open the analysis chat</Link>
          </>
        )}
      </p>
      {flow.kind === 'uat' && signStep && (signStep.state === 'waiting' || story.signoff) && (
        <div className="flowsign">
          <h3>UAT sign-off</h3>
          {story.signoff && (
            <p className="muted">
              {story.signoff.decision === 'signed_off' ? 'Signed off' : 'Not signed off'} by {story.signoff.by} on {day(story.signoff.at)}
              {story.signoff.note ? `: "${story.signoff.note}"` : ''}
              {story.signoff.stale ? ' · the evidence has changed since' : ''}
            </p>
          )}
          {signStep.state === 'waiting' && flow.canSignOff && flow.status === 'active' && (
            <>
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (needed when you do not sign off)" aria-label={`Sign-off note for ${story.key}`} />
              <div className="row">
                <button type="button" className="btn ink" onClick={() => void post('signoff', { storyKey: story.key, decision: 'signed_off', note })}>
                  Sign off {story.key}
                </button>
                <button type="button" className="btn" disabled={!note.trim()} onClick={() => void post('signoff', { storyKey: story.key, decision: 'rejected', note })}>
                  Do not sign off
                </button>
              </div>
            </>
          )}
          {signStep.state === 'waiting' && !flow.canSignOff && <p className="muted">A product owner or the app owner signs off.</p>}
        </div>
      )}
    </div>
  );
}

/**
 * The flow's own review step: each requirement of the story with the cases drafted for it, then Approve or
 * Request changes. It decides the approval from the analysis; no rating of the answer is asked for here.
 */
export function CaseReview({ flow, story }: { flow: FlowView; story: FlowStory }) {
  const me = useSession().me?.user;
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const review = story.review!;
  const step = story.steps.find((s) => s.key === 'review');
  const canDecide = flow.status === 'active' && !!me && !!step?.waitingOn.some((p) => p.id === me.id);
  const decide = async (decision: 'approved' | 'declined') => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/approvals/${review.approvalId}/decision`, { method: 'POST', body: JSON.stringify({ decision, note: decision === 'declined' ? note : undefined }) });
      flowsChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const n = review.cases.length;
  return (
    <section className="flowreview" id={`review-${story.key}`} aria-label={`Review the drafted cases for ${story.key}`}>
      <h3>Review the drafted cases</h3>
      <p className="muted small">
        Check each requirement and the cases drafted for it. Approving adds {n === 1 ? 'the case to Hexa as a manual UAT test' : `the ${n} cases to Hexa as manual UAT tests`} and moves {story.key} to Run tests.
      </p>
      <ol className="reviewreqs">
        {story.criteria.map((c) => {
          const cases = review.cases.filter((x) => x.criterion === c.id);
          return (
            <li key={c.id}>
              <p className="req">
                <b>{c.id}</b> {c.text}
              </p>
              {cases.length ? (
                cases.map((x) => (
                  <div key={x.id} className="reviewcase">
                    <b>{x.title}</b>
                    {x.steps.length > 0 && (
                      <ol>
                        {x.steps.map((st, i) => (
                          <li key={i}>{st}</li>
                        ))}
                      </ol>
                    )}
                  </div>
                ))
              ) : (
                <p className="muted small">{c.verified || c.status === 'passing' ? 'No new case: already covered by a test.' : 'No case drafted for this requirement.'}</p>
              )}
            </li>
          );
        })}
      </ol>
      {canDecide ? (
        <>
          {asking && (
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change: a missing requirement, a wrong step, a case to drop…" aria-label={`What should change for ${story.key}`} autoFocus />
          )}
          <div className="row">
            <button type="button" className="btn ink" disabled={busy} onClick={() => void decide('approved')}>
              Approve {n === 1 ? 'the case' : `${n} cases`}
            </button>
            {asking ? (
              <button type="button" className="btn" disabled={busy || note.trim().length < 3} onClick={() => void decide('declined')}>
                Send back for changes
              </button>
            ) : (
              <button type="button" className="btn" disabled={busy} onClick={() => setAsking(true)}>
                Request changes
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="muted small">{step?.waitingOn.length ? `${step.waitingOn.map((p) => p.name).join(' or ')} reviews these cases.` : 'A component manager reviews these cases.'}</p>
      )}
      {error && (
        <p className="errtext" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** A manual case under its criterion, with the tester's latest result and buttons to record a new one. */
function ManualRow({ m, canExecute }: { m: FlowStory['manual'][number]; canExecute: boolean }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const record = async (status: 'passed' | 'failed' | 'blocked') => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/hexa/tests/${m.id}/executions`, { method: 'POST', body: JSON.stringify({ status, note }) });
      setNote('');
      flowsChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flowcase">
      <Link to={`/hexa/test/${m.id}?tab=manual`}>{m.title}</Link>
      {m.last ? (
        <span className={`pill ${m.last.status === 'passed' ? 'pass' : 'crit'}`}>
          {m.last.status} by {m.last.by}, {day(m.last.at)}
        </span>
      ) : (
        <span className="pill">no result yet</span>
      )}
      {m.last?.note && <small className="muted">"{m.last.note}"</small>}
      {canExecute && (
        <span className="flowexec">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you saw (needed for fail or blocked)" aria-label={`Result note for ${m.title}`} />
          <button type="button" className="btn small" disabled={busy} onClick={() => void record('passed')}>
            Passed
          </button>
          <button type="button" className="btn small" disabled={busy || !note.trim()} onClick={() => void record('failed')}>
            Failed
          </button>
          <button type="button" className="btn small plain" disabled={busy || !note.trim()} onClick={() => void record('blocked')}>
            Blocked
          </button>
        </span>
      )}
      {error && (
        <span className="errtext" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
