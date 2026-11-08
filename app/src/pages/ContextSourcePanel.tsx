import * as Tabs from '@radix-ui/react-tabs';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import { Icon } from '../components/Icon';
import { fetchSourceDetail, reportConflict, statusLabel, syncSource, testQuestion, TRUST_RANK, useContextStore, type RankedChunk, type SourceDetail } from '../lib/contextData';
import { relTime } from './Tickets';

/** Side panel for one source (its passages, a test question, a conflict report), or the general "Test a question" at /context/source/test. */
export function ContextSourcePanel() {
  // Remount per source so the question and results never carry over.
  const { sourceId } = useParams();
  return <SourcePanel key={sourceId} sourceId={sourceId} />;
}

function SourcePanel({ sourceId }: { sourceId: string | undefined }) {
  const general = sourceId === 'test';
  const { sources } = useContextStore();
  const [detail, setDetail] = useState<SourceDetail | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const location = useLocation();
  const ref = useRef<HTMLElement>(null);
  const hashChunk = location.hash.startsWith('#chunk-') ? location.hash.slice(1) : null;

  useEffect(() => {
    if (general || !sourceId) return;
    fetchSourceDetail(sourceId).then(
      (d) => setDetail(d),
      (e: Error) => {
        setLoadError(e.message);
        setDetail(null);
      },
    );
  }, [sourceId, general, sources]);

  // A citation link lands on its passage.
  useEffect(() => {
    if (detail && hashChunk) document.getElementById(hashChunk)?.scrollIntoView({ block: 'center' });
  }, [detail, hashChunk]);

  // Below 900px the panel stacks under the list, so bring it into view when it opens.
  useEffect(() => {
    if (window.matchMedia('(max-width: 899px)').matches) ref.current?.scrollIntoView({ block: 'start' });
  }, [sourceId]);

  const close = (
    <Link to="/context" className="icon" aria-label="Close panel">
      <Icon name="close" />
    </Link>
  );

  if (general) {
    return (
      <section ref={ref} className="panel" aria-label="Test a question">
        <div className="phead">
          <div className="t">
            <b>Test a question</b>
            <span>See which passages Catalyzt would use for a question in this application</span>
          </div>
          {close}
        </div>
        <div className="pbody" style={{ gap: 16 }}>
          <TestQuestion />
        </div>
      </section>
    );
  }

  if (detail === undefined) {
    return (
      <section ref={ref} className="panel" aria-label="Loading source" aria-busy="true">
        <div className="phead">
          <div className="t">
            <b>Loading…</b>
          </div>
          {close}
        </div>
      </section>
    );
  }
  if (!detail) {
    return (
      <section ref={ref} className="panel" aria-label="Not found">
        <div className="phead">
          <div className="t">
            <b>{loadError ? 'Could not load this source' : 'Not found'}</b>
            <span>{loadError ?? "This source doesn't exist in this application."}</span>
          </div>
          {close}
        </div>
      </section>
    );
  }

  const { source, chunks, conflict } = detail;
  const st = statusLabel[source.status];
  const canSync = source.type === 'Repository' || source.type === 'Jira';
  const canReport = (source.status === 'ready' || source.status === 'indexed') && !source.conflictId && source.trust !== 'High';
  const higher = sources.filter((s) => s.id !== source.id && TRUST_RANK[s.trust] > TRUST_RANK[source.trust]);

  return (
    <section ref={ref} className="panel" aria-label={source.title}>
      <div className="phead">
        <div className="t">
          <b>{source.title}</b>
          <span>
            {source.type} · {source.trust} · v{source.version} · updated {relTime(source.updatedAt)} · {source.content}
          </span>
        </div>
        {canSync && (
          <button type="button" className="ghost" onClick={() => void syncSource(source.id)}>
            <Icon name="retry" small />
            Sync now
          </button>
        )}
        {close}
      </div>

      <Tabs.Root defaultValue={hashChunk ? 'passages' : 'test'} className="pbody" style={{ gap: 20 }}>
        <Tabs.List className="tabs" aria-label="Views">
          <Tabs.Trigger value="test">Test a question</Tabs.Trigger>
          <Tabs.Trigger value="passages">Passages {chunks.length}</Tabs.Trigger>
          <Tabs.Trigger value="details">Details</Tabs.Trigger>
          {canReport && higher.length > 0 && <Tabs.Trigger value="conflict">Report a conflict</Tabs.Trigger>}
        </Tabs.List>

        <Tabs.Content value="test" className="tabpane" style={{ gap: 16 }}>
          <TestQuestion />
        </Tabs.Content>

        <Tabs.Content value="passages" className="tabpane" style={{ gap: 12 }}>
          {chunks.length === 0 && (
            <p className="muted">
              {source.status === 'stored' ? (source.note ?? 'Catalyzt cannot read this file in this build.') : source.type === 'Jira' ? 'Stories come from the workspace backlog and are not split into passages; open a story from Jira Stories.' : 'No passages were found in this source.'}
            </p>
          )}
          {chunks.map((c) => (
            <div key={c.id} id={`chunk-${c.seq}`} className={`chunk${c.excludedReason ? ' excluded' : ''}${hashChunk === `chunk-${c.seq}` ? ' target' : ''}`}>
              <header>
                <span>{c.locator}</span>
                <span className="rel">v{source.version}</span>
              </header>
              <div>{c.text}</div>
              {c.excludedReason && (
                <div>
                  <span className="pill warn">Excluded: {c.excludedReason}</span>
                </div>
              )}
            </div>
          ))}
          {conflict && (
            <div className="callout">
              <Icon name="warn" small />
              <span>
                {conflict.status === 'open' ? 'Open conflict' : `Conflict decided: ${conflict.resolution === 'use_upload' ? 'this source is used' : 'the higher-trust source is kept'}`}: {conflict.title}.{' '}
                {conflict.huddleItemId && <Link to={`/huddle/${conflict.huddleItemId}`}>Open in Huddle</Link>}
              </span>
            </div>
          )}
        </Tabs.Content>

        <Tabs.Content value="details" className="tabpane">
          <dl className="details">
            <dt>Type</dt>
            <dd>{source.type}</dd>
            <dt>Location</dt>
            <dd className="mono">{source.sub}</dd>
            <dt>Scope</dt>
            <dd>{source.scope === 'App' ? 'Whole app' : source.scope}</dd>
            <dt>Trust</dt>
            <dd>{source.trust}</dd>
            <dt>Status</dt>
            <dd>
              <span className={`pill ${st.tone}`}>{st.label}</span>
              {source.note && <span className="failreason">{source.note}</span>}
            </dd>
            {source.excludedChunks > 0 && (
              <>
                <dt>Excluded</dt>
                <dd>{source.excludedChunks} passages{source.conflictId ? ', until the conflict is decided in Huddle' : ' (kept excluded by a decision)'}</dd>
              </>
            )}
            <dt>Content</dt>
            <dd>{source.content}</dd>
            <dt>Version</dt>
            <dd>v{source.version}</dd>
            <dt>Updated</dt>
            <dd>{relTime(source.updatedAt)}</dd>
            {source.syncedAt && (
              <>
                <dt>Last sync</dt>
                <dd>{relTime(source.syncedAt)}</dd>
              </>
            )}
            {source.addedBy && (
              <>
                <dt>Added by</dt>
                <dd>{source.addedBy}</dd>
              </>
            )}
            {source.size != null && (
              <>
                <dt>Size</dt>
                <dd>{source.size < 1024 * 1024 ? `${Math.max(1, Math.round(source.size / 1024))} KB` : `${(source.size / 1024 / 1024).toFixed(1)} MB`}</dd>
              </>
            )}
          </dl>
        </Tabs.Content>

        {canReport && higher.length > 0 && (
          <Tabs.Content value="conflict" className="tabpane">
            <ConflictForm sourceId={source.id} sourceTitle={source.title} higher={higher.map((s) => ({ id: s.id, title: s.title, trust: s.trust }))} />
          </Tabs.Content>
        )}
      </Tabs.Root>
    </section>
  );
}

function TestQuestion() {
  const { sources } = useContextStore();
  const [question, setQuestion] = useState('');
  const [results, setResults] = useState<{ results: RankedChunk[]; considered: { passages: number; stories: number; tests: number }; how?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qId = useId();

  const run = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResults(await testQuestion(question));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form onSubmit={run} className="field-row">
        <div className="field" style={{ height: 44 }}>
          <Icon name="search" small />
          <label htmlFor={qId} className="sr">
            Question
          </label>
          <input id={qId} type="search" placeholder="Type a question to see which passages Catalyzt would use" value={question} onChange={(e) => setQuestion(e.target.value)} />
        </div>
        <button type="submit" className="btn ink" style={{ height: 44 }} disabled={!question.trim() || busy} aria-busy={busy}>
          {busy ? 'Testing…' : 'Test'}
        </button>
      </form>
      {error && (
        <p className="errtext" role="alert">
          {error}
        </p>
      )}
      {results && (
        <div aria-live="polite" className="tabpane" style={{ gap: 12 }}>
          <div className="sechead" style={{ margin: 0 }}>
            <h3>What Catalyzt would use</h3>
            <span>
              Top {results.results.length} of {results.considered.passages} passages, {results.considered.stories} stories and {results.considered.tests} tests across {sources.length} sources · {results.how ?? 'keyword match'} · relevance, not correctness
            </span>
          </div>
          {results.results.length === 0 && <p className="muted">Nothing in this application's context matches that question.</p>}
          {results.results.map((c) => (
            <div key={c.where} className="chunk">
              <header>
                <span>{c.href ? <Link to={c.href}>{c.where}</Link> : c.where}</span>
                <span className="rel">relevance {c.relevance.toFixed(2)}</span>
              </header>
              <div>{c.text}</div>
              <div>
                <span className={`pill ${c.used ? 'pass' : 'warn'}`}>{c.used ? 'Used' : c.reason}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function ConflictForm({ sourceId, sourceTitle, higher }: { sourceId: string; sourceTitle: string; higher: { id: string; title: string; trust: string }[] }) {
  const navigate = useNavigate();
  const [otherId, setOtherId] = useState(higher[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [mine, setMine] = useState({ value: '', where: '' });
  const [theirs, setTheirs] = useState({ value: '', where: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const other = higher.find((h) => h.id === otherId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await reportConflict({ sourceId, otherSourceId: otherId, title, detail, compare: [mine, theirs] });
      navigate(`/huddle/${r.huddleItemId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="decideform" onSubmit={submit} aria-label="Report a conflict">
      <p className="muted" style={{ margin: 0 }}>
        When {sourceTitle} disagrees with a higher-trust source, Catalyzt stops using its passages until an app owner decides in Huddle.
      </p>
      <label htmlFor={`${id}-other`} className="blockhead">
        Disagrees with
      </label>
      <select id={`${id}-other`} value={otherId} onChange={(e) => setOtherId(e.target.value)}>
        {higher.map((h) => (
          <option key={h.id} value={h.id}>
            {h.title} · {h.trust}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-title`} className="blockhead">
        What is the conflict about?
      </label>
      <input id={`${id}-title`} className="text" type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Refund window: 60 or 45 days?" required maxLength={200} />
      <label htmlFor={`${id}-mine`} className="blockhead">
        {sourceTitle} says
      </label>
      <input id={`${id}-mine`} className="text" type="text" value={mine.value} onChange={(e) => setMine({ ...mine, value: e.target.value })} placeholder="60 days" required maxLength={300} />
      <input className="text" type="text" value={mine.where} onChange={(e) => setMine({ ...mine, where: e.target.value })} placeholder={`Where in ${sourceTitle} (optional)`} maxLength={200} aria-label={`Where in ${sourceTitle}`} />
      <label htmlFor={`${id}-theirs`} className="blockhead">
        {other?.title ?? 'The other source'} says
      </label>
      <input id={`${id}-theirs`} className="text" type="text" value={theirs.value} onChange={(e) => setTheirs({ ...theirs, value: e.target.value })} placeholder="45 days" required maxLength={300} />
      <input className="text" type="text" value={theirs.where} onChange={(e) => setTheirs({ ...theirs, where: e.target.value })} placeholder={`Where in ${other?.title ?? 'the other source'} (optional)`} maxLength={200} aria-label={`Where in ${other?.title ?? 'the other source'}`} />
      <label htmlFor={`${id}-detail`} className="blockhead">
        Detail <span className="muted">(optional)</span>
      </label>
      <textarea id={`${id}-detail`} rows={2} value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={2000} />
      {error && (
        <p className="errtext" role="alert">
          {error}
        </p>
      )}
      <div className="acts">
        <button type="submit" className="btn ink" disabled={busy || !title.trim() || !mine.value.trim() || !theirs.value.trim() || !otherId} aria-busy={busy}>
          {busy ? 'Sending to Huddle…' : 'Send to Huddle'}
        </button>
      </div>
    </form>
  );
}
