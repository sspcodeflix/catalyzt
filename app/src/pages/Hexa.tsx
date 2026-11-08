import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, Outlet, useLocation, useSearchParams } from 'react-router-dom';

import { Icon } from '../components/Icon';
import { api, hexaChanged, ORIGIN, PURPOSE, RESULT, runSources, type RunRow, type ScanRow, type TestRow, type TestsResponse } from '../lib/hexa';
import { StaleScopeError, withSession } from '../lib/session';
import { relTime } from './Tickets';

type Tab = 'manual' | 'automated' | 'runs';
const PAGE = 50;

/**
 * Hexa: the test inventory. Manual tests in Octane format, automated tests with their results
 * from CI, and the pipeline runs those results came from. Route /hexa; panels at /hexa/upload
 * and /hexa/test/:testId.
 */
export function Hexa() {
  const [params, setParams] = useSearchParams();
  const tab = (['manual', 'automated', 'runs'].includes(params.get('tab') ?? '') ? params.get('tab') : 'manual') as Tab;
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true });
  const panelOpen = useLocation().pathname.split('/').filter(Boolean).length > 1;
  const [stats, setStats] = useState<TestsResponse['stats'] | null>(null);

  // Totals for the tiles, refreshed after uploads and syncs.
  const loadStats = useCallback(() => {
    void api<TestsResponse>('/api/hexa/tests?limit=1').then((r) => setStats(r.stats), () => undefined);
  }, []);
  useEffect(() => {
    loadStats();
    window.addEventListener('hexa:changed', loadStats);
    window.addEventListener('hz:session', loadStats);
    return () => {
      window.removeEventListener('hexa:changed', loadStats);
      window.removeEventListener('hz:session', loadStats);
    };
  }, [loadStats]);

  const n = (k: string) => stats?.byKind.find((x) => x.key === k)?.n ?? 0;
  const failing = stats?.byResult.find((x) => x.key === 'failed')?.n ?? 0;

  return (
    <div className={`body${panelOpen ? ' split' : ''}`}>
      <div className="chatcol listcol">
        <div className="page">
          <div className="pagehead withaction">
            <div>
              <h1 className="pagetitle hexatitle">
                <Icon name="hex" />
                Hexa
              </h1>
              <p className="muted">
                Every test for this application: manual tests in Octane format, and automated tests with their results from
                pipeline runs. Search across both, upload what you write, and see results after each merge.
              </p>
            </div>
            <Link to={`/hexa/upload?tab=${tab}`} className="btn ink">
              <Icon name="upload" small />
              Upload
            </Link>
          </div>

          {stats && (
            <div className="usetiles">
              <button type="button" className={`kpi tilebtn${tab === 'manual' ? ' on' : ''}`} onClick={() => setTab('manual')}>
                <b>{n('manual').toLocaleString()}</b>
                <span>Manual tests{n('proposed') ? ` · ${n('proposed')} proposed` : ''}</span>
              </button>
              <button type="button" className={`kpi tilebtn${tab === 'automated' ? ' on' : ''}`} onClick={() => setTab('automated')}>
                <b>{n('automated').toLocaleString()}</b>
                <span>Automated tests</span>
              </button>
              <button type="button" className="kpi tilebtn" onClick={() => (setTab('automated'), setParams({ tab: 'automated', result: 'failed' }, { replace: true }))}>
                <b className={failing ? 'failnum' : undefined}>{failing}</b>
                <span>Failing now</span>
              </button>
              <button type="button" className={`kpi tilebtn${tab === 'runs' ? ' on' : ''}`} onClick={() => setTab('runs')}>
                <b>{stats.runs}</b>
                <span>Pipeline runs</span>
              </button>
            </div>
          )}

          <div className="tabs" role="tablist" aria-label="Hexa">
            {(
              [
                ['manual', 'Manual tests'],
                ['automated', 'Automated tests'],
                ['runs', 'Pipeline runs'],
              ] as const
            ).map(([t, l]) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} data-state={tab === t ? 'active' : 'inactive'} onClick={() => setTab(t)}>
                {l}
              </button>
            ))}
          </div>

          {tab === 'runs' ? (
            <Runs />
          ) : (
            // Keyed on the result and search filters too, so the Failing now tile and a citation's ?q= apply even on this tab.
            <TestList key={`${tab}-${params.get('result') ?? ''}-${params.get('q') ?? ''}`} tab={tab} compact={panelOpen} initialResult={params.get('result') ?? ''} initialQuery={params.get('q') ?? ''} />
          )}
        </div>
      </div>
      <Outlet />
    </div>
  );
}

function TestList({ tab, compact, initialResult, initialQuery }: { tab: 'manual' | 'automated'; compact: boolean; initialResult: string; initialQuery: string }) {
  const [data, setData] = useState<TestsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A citation lands here with ?q=<component>; the search box starts with it and the list is filtered (R09).
  const [q, setQ] = useState(initialQuery);
  const [purpose, setPurpose] = useState('');
  const [proposed, setProposed] = useState(false);
  const [result, setResult] = useState(initialResult);
  const [repo, setRepo] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const searchId = useId();

  const load = useCallback(async () => {
    const p = new URLSearchParams({ limit: String(limit), kind: tab === 'manual' ? (proposed ? 'proposed' : 'manual') : 'automated' });
    if (q.trim()) p.set('q', q.trim());
    if (purpose) p.set('purpose', purpose);
    if (tab === 'automated' && result) p.set('result', result);
    if (repo) p.set('repo', repo);
    try {
      setData(await api<TestsResponse>(`/api/hexa/tests?${p}`));
      setError(null);
    } catch (e) {
      if (e instanceof StaleScopeError) return;
      setError((e as Error).message);
    }
  }, [q, purpose, proposed, result, repo, limit, tab]);

  useEffect(() => {
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);
  useEffect(() => {
    window.addEventListener('hexa:changed', load);
    window.addEventListener('hz:session', load);
    return () => {
      window.removeEventListener('hexa:changed', load);
      window.removeEventListener('hz:session', load);
    };
  }, [load]);

  const scanning = data?.scans.some((s) => s.status === 'running') ?? false;
  useEffect(() => {
    if (!scanning) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [scanning, load]);

  const reset = () => setLimit(PAGE);

  return (
    <>
      {tab === 'automated' && <ScanBox scans={data?.scans ?? []} onStarted={load} onShowRepo={(r) => (setRepo(r), reset())} />}
      {tab === 'manual' && data && data.uploads.filter((u) => u.kind === 'manual_tests').length > 0 && (
        <UploadsNote uploads={data.uploads.filter((u) => u.kind === 'manual_tests')} />
      )}

      <section className="card dt" aria-label={tab === 'manual' ? 'Manual tests' : 'Automated tests'}>
        <div className="toolbar">
          <label className="search" htmlFor={searchId}>
            <Icon name="search" small />
            <input
              id={searchId}
              type="search"
              placeholder={tab === 'manual' ? 'Search name, step, Octane id, story or requirement' : 'Search name, method, file, story or requirement'}
              value={q}
              onChange={(e) => (setQ(e.target.value), reset())}
            />
          </label>
          {tab === 'manual' && (
            <span className="segctl" role="radiogroup" aria-label="Show">
              <button type="button" role="radio" aria-checked={!proposed} className={!proposed ? 'on' : undefined} onClick={() => (setProposed(false), reset())}>
                Manual
              </button>
              <button type="button" role="radio" aria-checked={proposed} className={proposed ? 'on' : undefined} onClick={() => (setProposed(true), reset())}>
                Proposed by agents
              </button>
            </span>
          )}
          <span className="segctl" role="radiogroup" aria-label="Purpose">
            {[
              ['', 'All'],
              ['uat', 'UAT'],
              ['regression', 'Regression'],
            ].map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={purpose === v} className={purpose === v ? 'on' : undefined} onClick={() => (setPurpose(v), reset())}>
                {l}
              </button>
            ))}
          </span>
          {tab === 'automated' && (
            <label className="selectwrap">
              <span className="sr">Last result</span>
              <select value={result} onChange={(e) => (setResult(e.target.value), reset())}>
                <option value="">Any result</option>
                <option value="failed">Failed</option>
                <option value="passed">Passed</option>
                <option value="skipped">Skipped</option>
                <option value="none">No runs yet</option>
              </select>
            </label>
          )}
          {tab === 'manual' && !proposed && (
            <a className="btn plain" href={withSession('/api/hexa/manual/export')} download>
              <Icon name="dl" small />
              Export for Octane
            </a>
          )}
          {repo && (
            <span className="itemchip">
              <Icon name="branch" small />
              {repo}
              <button type="button" className="chipx" aria-label={`Show all repositories, not only ${repo}`} onClick={() => setRepo(null)}>
                <Icon name="close" small />
              </button>
            </span>
          )}
        </div>
        {error && (
          <p className="errtext" role="alert" style={{ padding: '10px 14px' }}>
            Could not load tests: {error}
          </p>
        )}
        <div className="tablewrap">
          <table className="hexatable">
            <thead>
              <tr>
                <th>{tab === 'manual' ? 'Manual test' : 'Automated test'}</th>
                <th>{tab === 'manual' ? 'Purpose' : 'Last result'}</th>
                {!compact && <th className="hidem">{tab === 'manual' ? 'Steps' : 'Where'}</th>}
                {!compact && <th className="hidem">Covers</th>}
              </tr>
            </thead>
            <tbody>
              {data?.rows.map((t) => (
                <Row key={t.id} t={t} tab={tab} compact={compact} />
              ))}
              {data && data.rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    {q || purpose || result || repo
                      ? 'No tests match.'
                      : tab === 'manual'
                        ? proposed
                          ? 'No proposed cases. The UAT analyst proposes cases for gaps when it analyses a story.'
                          : 'No manual tests yet. Upload an Octane template, or approve UAT cases in a UAT analysis.'
                        : 'No automated tests yet. Scan a repository or upload results.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="pager">
          <span className="muted">{data ? `Showing ${data.rows.length} of ${data.total.toLocaleString()}` : 'Loading…'}</span>
          {data && data.rows.length < data.total && (
            <button type="button" className="btn" onClick={() => setLimit(limit + PAGE)}>
              Show more
            </button>
          )}
        </div>
      </section>
    </>
  );
}

function Covers({ links }: { links: TestRow['links'] }) {
  const shown = links.filter((l) => l.type !== 'component');
  if (shown.length === 0) return <span className="muted">Not linked</span>;
  return (
    <span className="covers">
      {shown.map((l) =>
        l.type === 'story' ? (
          <Link key={l.type + l.ref} to={`/tickets/${l.ref}`} className="pill mono">
            {l.ref}
          </Link>
        ) : (
          <span key={l.type + l.ref} className="pill mono" title={l.ref}>
            {l.type === 'criterion' ? l.ref.split('#')[1] : l.ref}
          </span>
        ),
      )}
    </span>
  );
}

function Row({ t, tab, compact }: { t: TestRow; tab: 'manual' | 'automated'; compact: boolean }) {
  return (
    <tr>
      <td>
        <Link to={`/hexa/test/${t.id}?tab=${tab}`} className="tctitle">
          {t.title}
        </Link>
        <small className="muted">
          <span className="mono">{t.externalId ?? t.id}</span>
          {t.suite ? ` · ${t.suite}` : ''}
          {t.phase ? ` · ${t.phase}` : ''}
          {t.owner ? ` · ${t.owner}` : ''} · {ORIGIN[t.origin] ?? t.origin}
        </small>
      </td>
      <td>
        {tab === 'manual' ? (
          t.purpose ? <span className={`pill ${t.purpose === 'uat' ? 'info' : ''}`}>{PURPOSE[t.purpose]}</span> : <span className="muted">Not set</span>
        ) : t.lastResult ? (
          <>
            <span className={`pill ${RESULT[t.lastResult].cls}`}>{RESULT[t.lastResult].label}</span>
            {t.lastRunAt && <small className="muted">{relTime(t.lastRunAt)}</small>}
          </>
        ) : (
          <span className="muted">No runs</span>
        )}
      </td>
      {!compact && (
        <td className="hidem">
          {tab === 'manual' ? (
            <span className="muted">
              {t.steps} step{t.steps === 1 ? '' : 's'}
            </span>
          ) : t.path ? (
            t.url ? (
              <a className="mono loc" href={t.url} target="_blank" rel="noreferrer">
                {t.repo}/{t.path}
                {t.line ? `:${t.line}` : ''}
              </a>
            ) : (
              <span className="mono loc">
                {t.repo ? `${t.repo}/` : ''}
                {t.path}
                {t.line ? `:${t.line}` : ''}
              </span>
            )
          ) : (
            <span className="muted">{t.repo ?? 'Unknown file'}</span>
          )}
          {tab === 'automated' && t.framework && <small className="muted fw">{t.framework}</small>}
        </td>
      )}
      {!compact && (
        <td className="hidem">
          <Covers links={t.links} />
        </td>
      )}
    </tr>
  );
}

function UploadsNote({ uploads }: { uploads: TestsResponse['uploads'] }) {
  const u = uploads[0];
  return (
    <p className="callout" role="status">
      <Icon name="upload" small />
      <span>
        Last upload: <b>{u.filename}</b> by {u.by}, {relTime(u.at)}: {u.created} new, {u.updated} updated
        {u.problems.length ? `, ${u.problems.length} row${u.problems.length > 1 ? 's' : ''} need attention` : ''}.
      </span>
    </p>
  );
}

function ScanBox({ scans, onStarted, onShowRepo }: { scans: ScanRow[]; onStarted: () => void; onShowRepo: (repo: string) => void }) {
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const input = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!repo.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/hexa/scans', { method: 'POST', body: JSON.stringify({ repo }) });
      setRepo('');
      onStarted();
    } catch (err) {
      setError((err as Error).message);
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="card scanbox" open={scans.length === 0 || scans.some((s) => s.status === 'running')}>
      <summary>
        <b>Find automated tests in a GitHub repository</b>
        <span className="muted">Read only: Catalyzt reads test files and never runs code</span>
      </summary>
      <form className="field-row" onSubmit={submit}>
        <div className="field">
          <Icon name="branch" small />
          <label htmlFor={id} className="sr">
            Repository
          </label>
          <input
            ref={input}
            id={id}
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="owner/repo, owner/repo@branch or a github.com link"
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-err` : undefined}
          />
        </div>
        <button type="submit" className="btn ink" disabled={!repo.trim() || busy}>
          {busy ? 'Starting…' : 'Scan'}
        </button>
      </form>
      {error && (
        <p id={`${id}-err`} className="errtext" role="alert">
          {error}
        </p>
      )}
      {scans.length > 0 && (
        <ul className="scans" aria-label="Recent scans">
          {scans.map((s) => (
            <li key={s.id}>
              {s.status === 'running' ? <span className="spinner sm" aria-label="Scanning" /> : <Icon name={s.status === 'done' ? 'check' : 'warn'} small className={s.status === 'done' ? 'ok' : 'bad'} />}
              <span className="mono">{s.repo}</span>
              <span className="muted grow">
                {s.status === 'running'
                  ? 'Scanning…'
                  : s.status === 'failed'
                    ? s.error
                    : `${s.testsFound} tests in ${s.filesScanned} files · ${s.testsNew} new${s.testsRemoved ? ` · ${s.testsRemoved} removed` : ''}${
                        s.complete === false ? ` · partial scan (${s.filesFailed ? `${s.filesFailed} files could not be read` : 'not every file was listed or read'}): tests in unread files were kept` : ''
                      }`}
                {' · '}
                {s.startedBy}, {relTime(s.startedAt)}
              </span>
              {s.status === 'done' && (
                <button type="button" className="linkbtn" onClick={() => onShowRepo(s.repo)}>
                  View tests
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/** Pipeline runs: results from GitHub Actions merge-commit runs, CI pushes and uploads. */
function Runs() {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const id = useId();

  const load = useCallback(async () => {
    try {
      setRuns((await api<{ runs: RunRow[] }>('/api/hexa/runs')).runs);
    } catch (e) {
      if (e instanceof StaleScopeError) return;
      setMsg({ ok: false, text: (e as Error).message });
    }
  }, []);
  useEffect(() => {
    void load();
    window.addEventListener('hexa:changed', load);
    window.addEventListener('hz:session', load);
    return () => {
      window.removeEventListener('hexa:changed', load);
      window.removeEventListener('hz:session', load);
    };
  }, [load]);

  const sync = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api<{ checked: number; ingested: number; already: number; notMerge: number; noResults: number; results: number; failed: number }>('/api/hexa/runs/sync', {
        method: 'POST',
        body: JSON.stringify({ repo }),
      });
      setMsg({
        ok: true,
        text: `Checked ${r.checked} runs: ${r.ingested} merge-commit runs added (${r.results} results, ${r.failed} failed), ${r.already} already in Hexa, ${r.notMerge} not PR merges, ${r.noResults} without JUnit results.`,
      });
      hexaChanged();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="card scanbox" aria-labelledby={`${id}-h`}>
        <div className="sechead">
          <h3 id={`${id}-h`}>Collect from GitHub Actions</h3>
          <span>Merge-commit runs on the default branch</span>
        </div>
        <form className="field-row" onSubmit={sync}>
          <div className="field">
            <Icon name="play" small />
            <label htmlFor={id} className="sr">
              Repository
            </label>
            <input id={id} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" />
          </div>
          <button type="submit" className="btn ink" disabled={!repo.trim() || busy}>
            {busy ? 'Collecting…' : 'Collect results'}
          </button>
        </form>
        {msg && (
          <p className={msg.ok ? 'muted' : 'errtext'} role={msg.ok ? 'status' : 'alert'} style={{ margin: 0, fontSize: 13 }}>
            {msg.text}
          </p>
        )}
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
          Catalyzt reads JUnit XML artifacts (named like <span className="mono">test-results</span> or <span className="mono">junit</span>) from each PR merge commit's run. In production, the workflow
          pushes results to Catalyzt instead: see <span className="mono">docs/hexa-github-action.yml</span>.
        </p>
      </section>

      {runs === null ? (
        <p className="muted">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="muted">No pipeline runs yet. Collect them from GitHub Actions, or upload a JUnit XML file.</p>
      ) : (
        <>
          <div className="sechead runsources">
            <h3>Pipeline runs</h3>
            <span>{runSources(runs)}</span>
          </div>
          <ol className="runlist">
            {runs.map((r) => (
              <li key={r.id} className="card runcard">
                <div className="runhead">
                  <span className={`pill ${r.status === 'passed' ? 'pass' : 'crit'}`}>{r.status === 'passed' ? 'Passed' : 'Failed'}</span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <b>{r.workflow ?? (r.source === 'upload' ? 'Uploaded results' : 'CI results')}</b>
                    <span className="muted">
                      {r.repo ? ` · ${r.repo}` : ''}
                      {r.prNumber ? (
                        <>
                          {' · '}
                          {r.repo ? (
                            <a href={`https://github.com/${r.repo}/pull/${r.prNumber}`} target="_blank" rel="noreferrer">
                              PR #{r.prNumber}
                            </a>
                          ) : (
                            `PR #${r.prNumber}`
                          )}
                          {r.isMerge ? ' merged' : ''}
                        </>
                      ) : null}
                      {r.sha ? (
                        <>
                          {' · '}
                          <span className="mono">{r.sha.slice(0, 7)}</span>
                        </>
                      ) : null}
                      {r.branch ? ` on ${r.branch}` : ''} · {relTime(r.at)}
                    </span>
                  </div>
                  {r.runUrl && (
                    <a className="btn plain small" href={r.runUrl} target="_blank" rel="noreferrer">
                      View run
                    </a>
                  )}
                </div>
                <div className="runbody">
                  <span>
                    <b>{r.passed}</b> passed · <b className={r.failed ? 'failnum' : undefined}>{r.failed}</b> failed · <b>{r.skipped}</b> skipped of {r.total}
                    {r.durationMs ? ` · ${(r.durationMs / 1000).toFixed(1)} s of test time` : ''}
                  </span>
                  <span className="muted">{r.source === 'github_actions' ? 'Collected from GitHub Actions' : r.source === 'webhook' ? 'Pushed by CI' : `Uploaded${r.by ? ` by ${r.by}` : ''}`}</span>
                </div>
                {r.failures.length > 0 && (
                  <ul className="failures">
                    {r.failures.map((f) => (
                      <li key={f.id}>
                        <Icon name="warn" small className="bad" />
                        <span>
                          <Link to={`/hexa/test/${f.id}?tab=runs`}>{f.title}</Link>
                          {f.message && <small className="mono">{f.message.split('\n').find((l) => l.trim()) ?.slice(0, 200)}</small>}
                        </span>
                      </li>
                    ))}
                    {r.failed > r.failures.length && (
                      <li className="muted">
                        Showing {r.failures.length} of {r.failed} failures; the rest are on each test's page.
                      </li>
                    )}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </>
  );
}
