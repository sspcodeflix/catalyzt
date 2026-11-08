import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { useSession } from '../lib/session';
import { useTickets } from '../lib/ticketStore';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { Icon } from '../components/Icon';
import { addedLinks, api, fileToBase64, hexaChanged, linkLabel, ORIGIN, PURPOSE, RESULT, type TestDetail, type TestLink } from '../lib/hexa';
import { withSession } from '../lib/session';
import { relTime } from './Tickets';

function useScrollIntoViewOnPhone(dep: unknown) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (window.matchMedia('(max-width: 899px)').matches) ref.current?.scrollIntoView({ block: 'start' });
  }, [dep]);
  return ref;
}

/** Upload manual tests (Octane .xlsx or .csv) or automated results (JUnit XML). Route /hexa/upload. */
export function HexaUpload() {
  const [params] = useSearchParams();
  const [kind, setKind] = useState<'manual' | 'results'>(params.get('tab') === 'automated' || params.get('tab') === 'runs' ? 'results' : 'manual');
  const [files, setFiles] = useState<File[]>([]);
  const [purpose, setPurpose] = useState<'' | 'uat' | 'regression'>('');
  const [meta, setMeta] = useState({ repo: '', branch: '', sha: '', prNumber: '', workflow: '', runUrl: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ title: string; lines: string[]; problems: { row: number; message: string }[] } | null>(null);
  const ref = useScrollIntoViewOnPhone(null);
  const fileId = useId();
  const tabBack = kind === 'manual' ? 'manual' : 'runs';

  const accept = kind === 'manual' ? '.xlsx,.csv' : '.xml';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!files.length) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      if (kind === 'manual') {
        const f = files[0];
        const r = await api<{ created: number; updated: number; problems: { row: number; message: string }[] }>('/api/hexa/manual/import', {
          method: 'POST',
          body: JSON.stringify({ filename: f.name, contentBase64: await fileToBase64(f), purpose: purpose || null }),
        });
        setDone({ title: `Imported ${f.name}`, lines: [`${r.created} new manual tests`, `${r.updated} updated (same Octane unique_id)`], problems: r.problems });
      } else {
        const r = await api<{ total: number; matched: number; created: number; passed: number; failed: number; skipped: number }>('/api/hexa/results/upload', {
          method: 'POST',
          body: JSON.stringify({
            files: await Promise.all(files.map(async (f) => ({ filename: f.name, contentBase64: await fileToBase64(f) }))),
            ...meta,
            prNumber: meta.prNumber ? Number(meta.prNumber) : null,
          }),
        });
        setDone({
          title: `Recorded ${r.total} results`,
          lines: [`${r.passed} passed · ${r.failed} failed · ${r.skipped} skipped`, `${r.matched} matched to known tests · ${r.created} new tests added`],
          problems: [],
        });
      }
      setFiles([]);
      hexaChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section ref={ref} className="panel" aria-label="Upload to Hexa">
      <div className="phead">
        <div className="t">
          <b>Upload to Hexa</b>
          <span>Manual tests you wrote, or results from a test run</span>
        </div>
        <Link to={`/hexa?tab=${tabBack}`} className="icon" aria-label="Close panel">
          <Icon name="close" />
        </Link>
      </div>
      <form className="pbody storyform" onSubmit={submit}>
        <fieldset>
          <legend>What are you uploading?</legend>
          <div className="choice">
            <label className={`choicecard${kind === 'manual' ? ' on' : ''}`}>
              <input type="radio" name="kind" checked={kind === 'manual'} onChange={() => (setKind('manual'), setFiles([]), setDone(null))} />
              <span>
                <b>Manual tests</b>
                <small className="muted">Octane import template, .xlsx or .csv. One row per step; rows of a test share its unique_id.</small>
              </span>
            </label>
            <label className={`choicecard${kind === 'results' ? ' on' : ''}`}>
              <input type="radio" name="kind" checked={kind === 'results'} onChange={() => (setKind('results'), setFiles([]), setDone(null))} />
              <span>
                <b>Automated test results</b>
                <small className="muted">JUnit XML from any framework: JUnit, pytest, Jest, Playwright, Go, .NET.</small>
              </span>
            </label>
          </div>
        </fieldset>

        <div className="field-col">
          <label htmlFor={fileId}>{kind === 'manual' ? 'Octane file' : 'JUnit XML files'}</label>
          <input id={fileId} type="file" accept={accept} multiple={kind === 'results'} onChange={(e) => setFiles([...(e.target.files ?? [])])} />
          {kind === 'manual' && (
            <small className="muted">
              No template yet?{' '}
              <a href={withSession('/api/hexa/manual/template')} download>
                Download the Octane template
              </a>
              . Tests with an existing unique_id are updated, not duplicated.
            </small>
          )}
        </div>

        {kind === 'manual' ? (
          <div className="field-col">
            <label>Purpose, for tests whose test_type does not say</label>
            <span className="segctl" role="radiogroup" aria-label="Purpose">
              {(
                [
                  ['', 'From the file'],
                  ['uat', 'UAT'],
                  ['regression', 'Regression'],
                ] as const
              ).map(([v, l]) => (
                <button key={v} type="button" role="radio" aria-checked={purpose === v} className={purpose === v ? 'on' : undefined} onClick={() => setPurpose(v)}>
                  {l}
                </button>
              ))}
            </span>
          </div>
        ) : (
          <fieldset className="field-col">
            <legend>Where the run came from (optional; helps match results to tests)</legend>
            <div className="formgrid">
              {(
                [
                  ['repo', 'Repository', 'owner/repo'],
                  ['branch', 'Branch', 'main'],
                  ['sha', 'Commit', 'a1b2c3d'],
                  ['prNumber', 'PR number', '1482'],
                  ['workflow', 'Workflow', 'CI'],
                  ['runUrl', 'Run link', 'https://github.com/…/actions/runs/…'],
                ] as const
              ).map(([k, l, ph]) => (
                <label key={k} className="field-col">
                  <span>{l}</span>
                  <input className="text" value={meta[k]} placeholder={ph} onChange={(e) => setMeta({ ...meta, [k]: e.target.value })} />
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {error && (
          <p className="callout bad" role="alert">
            <Icon name="warn" small />
            <span>{error}</span>
          </p>
        )}
        {done && (
          <div className="callout" role="status">
            <Icon name="check" small className="ok" />
            <div>
              <b>{done.title}</b>
              {done.lines.map((l) => (
                <div key={l}>{l}</div>
              ))}
              {done.problems.length > 0 && (
                <details>
                  <summary>
                    {done.problems.length} row{done.problems.length > 1 ? 's' : ''} need attention
                  </summary>
                  <ul>
                    {done.problems.map((p, i) => (
                      <li key={i}>
                        {p.row ? `Row ${p.row}: ` : ''}
                        {p.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <Link to={`/hexa?tab=${tabBack}`} className="linkbtn">
                See them in Hexa
              </Link>
            </div>
          </div>
        )}

        <div className="formactions sticky">
          <span className="grow muted" style={{ fontSize: 12.5 }}>
            {files.length ? files.map((f) => f.name).join(', ') : 'No file chosen'}
          </span>
          <button type="submit" className="btn ink" disabled={!files.length || busy}>
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </form>
    </section>
  );
}

const STEP_LABEL = { simple: 'Simple', validation: 'Validation', call: 'Call' } as const;

/** One test: Octane fields and steps for manual tests, result history for automated ones. Route /hexa/test/:testId. */
export function HexaTestPanel() {
  const { testId } = useParams();
  const [params] = useSearchParams();
  const [t, setT] = useState<TestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const ref = useScrollIntoViewOnPhone(testId);
  const back = `/hexa?tab=${params.get('tab') ?? 'manual'}`;
  // R08: a link or unlink can be taken back for a few seconds.
  const [undo, setUndo] = useState<LinkUndo | null>(null);
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => setUndo(null), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [undo]);

  useEffect(() => {
    setT(null);
    setError(null);
    setUndo(null);
    const load = () =>
      api<{ test: TestDetail }>(`/api/hexa/tests/${testId}`).then(
        (r) => setT(r.test),
        (e: Error) => setError(e.message),
      );
    void load();
    window.addEventListener('hexa:changed', load);
    return () => window.removeEventListener('hexa:changed', load);
  }, [testId]);

  const close = (
    <Link to={back} className="icon" aria-label="Close panel">
      <Icon name="close" />
    </Link>
  );

  if (!t) {
    return (
      <section ref={ref} className="panel" aria-label="Test" aria-busy={!error}>
        <div className="phead">
          <div className="t">
            <b>{error ? 'Not found' : testId}</b>
            <span>{error ?? 'Loading…'}</span>
          </div>
          {close}
        </div>
      </section>
    );
  }

  const fields: [string, string | number | null][] = [
    ['Octane id', t.externalId],
    ['Test type', t.testType],
    ['Phase', t.phase],
    ['Owner', t.owner],
    ['Designer', t.designer],
    ['Product areas', t.productAreas],
    ['Application modules', t.applicationModules],
    ['Tags', t.userTags],
    ['Estimated duration', t.estimatedMinutes ? `${t.estimatedMinutes} min` : null],
  ];
  const passRate = t.history.length ? Math.round((t.history.filter((h) => h.status === 'passed').length / t.history.length) * 100) : null;

  return (
    <section ref={ref} className="panel" aria-label={t.title}>
      <div className="phead">
        <div className="t">
          <b>{t.title}</b>
          <span>
            <span className="mono">{t.externalId ?? t.id}</span> · {t.kind === 'manual' ? 'Manual test' : t.kind === 'proposed' ? 'Proposed test' : 'Automated test'}
            {t.purpose ? ` · ${PURPOSE[t.purpose]}` : ''} · {ORIGIN[t.origin] ?? t.origin} · updated {relTime(t.updatedAt)}
          </span>
        </div>
        {t.kind === 'manual' && (
          <a className="ghost hidem" href={withSession(`/api/hexa/manual/export?ids=${t.id}`)} download>
            <Icon name="dl" small />
            Octane CSV
          </a>
        )}
        {close}
      </div>
      <div className="pbody" style={{ gap: 20 }}>
        {t.description && <p className="prose" style={{ margin: 0 }}>{t.description}</p>}

        {t.kind !== 'automated' && (
          <div>
            <div className="sechead">
              <h3>Steps</h3>
              <span>{t.steps.length} in Octane format</span>
            </div>
            {t.steps.length === 0 ? (
              <p className="muted">No steps.</p>
            ) : (
              <ol className="octsteps">
                {t.steps.map((s) => (
                  <li key={s.seq} className={s.type}>
                    <span className="stepno mono">{s.seq}</span>
                    <span className={`pill ${s.type === 'validation' ? 'info' : ''}`}>{STEP_LABEL[s.type]}</span>
                    <span className="stepdesc">{s.description}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {t.kind === 'automated' && (
          <>
            <dl className="facts">
              <div>
                <dt>Where</dt>
                <dd className="mono">
                  {t.url ? (
                    <a href={t.url} target="_blank" rel="noreferrer">
                      {t.repo}/{t.path}
                      {t.line ? `:${t.line}` : ''}
                    </a>
                  ) : (
                    `${t.repo ?? ''}${t.path ? `/${t.path}` : ''}` || 'Unknown'
                  )}
                </dd>
              </div>
              <div>
                <dt>In code</dt>
                <dd className="mono">
                  {t.suite ? `${t.suite} · ` : ''}
                  {t.codeName ?? '—'}
                </dd>
              </div>
              <div>
                <dt>Framework</dt>
                <dd>{t.framework ?? 'Not known yet'}</dd>
              </div>
            </dl>
            <div>
              <div className="sechead">
                <h3>Results</h3>
                <span>{t.history.length ? `${passRate}% passed in the last ${t.history.length} runs` : 'No runs yet'}</span>
              </div>
              {t.history.length === 0 ? (
                <p className="muted">Results appear here after a pipeline run on a PR merge commit, or when someone uploads JUnit results.</p>
              ) : (
                <ol className="history">
                  {t.history.map((h) => (
                    <li key={h.runId}>
                      <span className={`pill ${RESULT[h.status].cls}`}>{RESULT[h.status].label}</span>
                      <span className="grow">
                        {h.prNumber ? `PR #${h.prNumber}${h.isMerge ? ' merged' : ''}` : h.source === 'upload' ? 'Uploaded results' : 'CI run'}
                        {h.sha ? (
                          <>
                            {' · '}
                            <span className="mono">{h.sha.slice(0, 7)}</span>
                          </>
                        ) : null}
                        {h.branch ? ` on ${h.branch}` : ''}
                        <small className="muted">
                          {relTime(h.at)}
                          {h.durationMs != null ? ` · ${(h.durationMs / 1000).toFixed(2)} s` : ''}
                          {h.workflow ? ` · ${h.workflow}` : ''}
                        </small>
                        {h.message && <pre className="failmsg">{h.message}</pre>}
                      </span>
                      {h.runUrl && (
                        <a className="linkbtn" href={h.runUrl} target="_blank" rel="noreferrer">
                          Run
                        </a>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </>
        )}

        {t.kind !== 'automated' && (
          <dl className="facts">
            {fields
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
          </dl>
        )}

        <div>
          <div className="sechead">
            <h3>Covers</h3>
            <span>{t.links.length ? 'What this test is evidence for' : 'Not linked yet'}</span>
          </div>
          <span className="covers">
            {t.links.map((l) => (
              <span key={l.type + l.ref} className="pill mono linkpill">
                {l.type === 'story' ? (
                  <button type="button" className="linkbtn" onClick={() => navigate(`/tickets/${l.ref}`)}>
                    {l.ref}
                  </button>
                ) : l.type === 'criterion' ? (
                  l.ref.replace('#', ' ')
                ) : (
                  l.ref.replace(/^[^/]+\//, '')
                )}
                <button
                  type="button"
                  className="chipx"
                  aria-label={`Unlink ${linkLabel(l)} from this test`}
                  title={`Unlink ${linkLabel(l)}`}
                  onClick={() =>
                    void changeLinks(t.id, [l], true).then(
                      () => setUndo({ text: `Unlinked ${linkLabel(l)}`, links: [l], unlinked: true }),
                      (e: Error) => setUndo({ text: e.message, links: [], unlinked: false }),
                    )
                  }
                >
                  <Icon name="close" small />
                </button>
              </span>
            ))}
          </span>
          {undo && (
            <p className="linkundo muted" role="status">
              {undo.text}
              {undo.links.length > 0 && (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() => {
                      const u = undo;
                      setUndo(null);
                      // Undoing an unlink links again; undoing a link removes what that press added.
                      void changeLinks(t.id, u.links, !u.unlinked).then(
                        () => setUndo({ text: u.unlinked ? `Linked ${u.links.map(linkLabel).join(', ')} again` : `Removed ${u.links.map(linkLabel).join(', ')}`, links: [], unlinked: false }),
                        (e: Error) => setUndo({ text: e.message, links: [], unlinked: false }),
                      );
                    }}
                  >
                    Undo
                  </button>
                </>
              )}
            </p>
          )}
          <LinkForm testId={t.id} linked={t.links} onLinked={(added) => setUndo(added.length ? { text: `Linked ${added.map(linkLabel).join(', ')}`, links: added, unlinked: false } : null)} />
        </div>
      </div>
    </section>
  );
}

/** What the last link or unlink changed, so it can be undone (R08). */
interface LinkUndo {
  text: string;
  links: TestLink[];
  /** True when the links were removed (undo links them again). */
  unlinked: boolean;
}
const UNDO_MS = 10_000;


/** Links or unlinks, one call per link; a component is sent by its name. */
async function changeLinks(testId: string, links: TestLink[], remove: boolean): Promise<TestDetail | null> {
  let last: TestDetail | null = null;
  try {
    for (const l of links) {
      last = (await api<{ test: TestDetail }>(`/api/hexa/tests/${testId}/links`, { method: 'POST', body: JSON.stringify({ type: l.type, ref: l.type === 'component' ? linkLabel(l) : l.ref, remove }) })).test;
    }
  } finally {
    hexaChanged();
  }
  return last;
}


/**
 * Links a test to a story, one of its acceptance criteria, or a component, so UAT readiness can
 * count it as evidence. Stories and components come from the application; the server validates.
 */
function LinkForm({ testId, linked, onLinked }: { testId: string; linked: TestLink[]; onLinked: (added: TestLink[]) => void }) {
  const tickets = useTickets();
  const components = useSession().me?.app?.components ?? [];
  // R08: nothing is preselected; the Link button stays disabled until a target is chosen, so one press never links the wrong thing.
  const [type, setType] = useState<'criterion' | 'story' | 'component'>('criterion');
  const [story, setStory] = useState('');
  const [ac, setAc] = useState(0);
  const [component, setComponent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const chosen = tickets.find((x) => x.key === story);
  const storyKey = chosen?.key ?? '';
  const criteria = chosen?.acceptanceCriteria ?? [];
  const ref = type === 'component' ? component : type === 'story' ? storyKey : storyKey && ac > 0 ? `${storyKey}#AC${ac}` : '';
  const already = linked.some((l) => l.type === type && (l.type === 'component' ? l.ref.endsWith(`/${ref}`) : l.ref === ref));

  // A link the server refused because the test comes from another repository can be confirmed once.
  const [confirm, setConfirm] = useState(false);
  const link = async (force: boolean) => {
    if (!ref) return;
    setBusy(true);
    setError(null);
    try {
      const before = linked;
      const r = await api<{ test: TestDetail }>(`/api/hexa/tests/${testId}/links`, { method: 'POST', body: JSON.stringify({ type, ref, force }) });
      hexaChanged();
      setConfirm(false);
      onLinked(addedLinks(before, r.test.links));
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      setConfirm(!force && /would not count as evidence/.test(msg));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void link(false);
  };

  return (
    <form className="linkform" onSubmit={submit} aria-label="Link this test" style={{ marginTop: 12 }}>
      <div className="field-row" style={{ flexWrap: 'wrap' }}>
        <label htmlFor={`${id}-type`} className="sr">
          Link type
        </label>
        <select id={`${id}-type`} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="criterion">Acceptance criterion</option>
          <option value="story">Story</option>
          <option value="component">Component</option>
        </select>
        {type !== 'component' && (
          <>
            <label htmlFor={`${id}-story`} className="sr">
              Story
            </label>
            <select id={`${id}-story`} value={storyKey} onChange={(e) => (setStory(e.target.value), setAc(0))} disabled={tickets.length === 0}>
              <option value="">{tickets.length === 0 ? 'No stories in the Jira filter' : 'Choose a story…'}</option>
              {tickets.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.key} · {t.summary.slice(0, 48)}
                </option>
              ))}
            </select>
          </>
        )}
        {type === 'criterion' && criteria.length > 0 && (
          <>
            <label htmlFor={`${id}-ac`} className="sr">
              Criterion
            </label>
            <select id={`${id}-ac`} value={ac} onChange={(e) => setAc(Number(e.target.value))}>
              <option value={0}>Choose a criterion…</option>
              {criteria.map((c, i) => (
                <option key={i} value={i + 1}>
                  AC{i + 1} · {c.slice(0, 60)}
                </option>
              ))}
            </select>
          </>
        )}
        {type === 'component' && (
          <>
            <label htmlFor={`${id}-component`} className="sr">
              Component
            </label>
            <select id={`${id}-component`} value={component} onChange={(e) => setComponent(e.target.value)}>
              <option value="">Choose a component…</option>
              {components.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </>
        )}
        <button type="submit" className="btn" disabled={busy || !ref || already} title={already ? 'Already linked' : undefined} aria-busy={busy}>
          <Icon name="link" small />
          {already ? 'Linked' : busy ? 'Linking…' : 'Link'}
        </button>
      </div>
      {error && (
        <p className="errtext" role="alert">
          {error}
          {confirm && (
            <>
              {' '}
              <button type="button" className="btn small" onClick={() => void link(true)} disabled={busy}>
                Link anyway
              </button>
            </>
          )}
        </p>
      )}
    </form>
  );
}
