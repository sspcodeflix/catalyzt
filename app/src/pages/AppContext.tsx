import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { Icon } from '../components/Icon';
import { currentUser } from '../lib/data';
import { useJiraSync, useTickets } from '../lib/ticketStore';
import { relTime } from './Tickets';
import {
  acceptedFileTypes,
  addConfluence,
  addFiles,
  adminSettings,
  processingSteps,
  statusLabel,
  useContextStore,
  workspaces,
  type ScopeKind,
  type Source,
  type SourceStatus,
} from '../lib/contextData';
import '../styles/pages.css';

const PAGE_SIZE = 8;

/** App Context: what Horizon knows about the selected application, and what the team adds. */
export function AppContext() {
  const { sources, conflict, notice } = useContextStore();
  const location = useLocation();
  const panelOpen = location.pathname.startsWith('/context/source/');
  const selectedId = panelOpen ? decodeURIComponent(location.pathname.split('/')[3] ?? '') : undefined;

  const repos = sources.filter((s) => s.type === 'Repository').length;
  const review = sources.filter((s) => s.status === 'review').length;
  const processing = sources.filter((s) => s.status === 'processing');
  const fabric = sources.find((s) => s.type === 'Fabric');

  return (
    <div className={`body${panelOpen ? ' split' : ''}`}>
      <div className="chatcol listcol">
        <div className="page">
          <div className="pagehead">
            <div>
              <span className="appname">
                <Icon name="layers" small />
                Payments Hub · ABCD
              </span>
              <h1>App Context</h1>
              {!panelOpen && (
                <p>
                  Everything Horizon knows about this application: the Enterprise Knowledge Fabric, code discovered
                  through GitHub, and what your team adds. New sources are embedded automatically and used in every
                  answer, test and scan for this app.
                </p>
              )}
            </div>
            <Link className="btn" to="/context/source/fabric">
              <Icon name="search" small />
              Test a question
            </Link>
          </div>

          {!panelOpen && (
            <>
              <div className="tiles">
                <div className="card ctile ekf">
                  <div className="row">
                    <span className="tile">
                      <Icon name="fabric" />
                    </span>
                    <div>
                      <div style={{ fontWeight: 600 }}>Enterprise Knowledge Fabric</div>
                      <span>Read only · {fabric?.updated.toLowerCase() ?? 'synced'} · v14</span>
                    </div>
                  </div>
                  <span>214 sections for Payments Hub. Highest trust; your uploads never overwrite it.</span>
                </div>
                <div className="card ctile">
                  <b>{sources.length}</b>
                  <span>
                    Sources: {repos} repositories from GitHub and ZIPs, {sources.length - repos} documents, pages and
                    feeds
                  </span>
                </div>
                <div className="card ctile">
                  <b>{review}</b>
                  <span>Needs review: conflicts with the Fabric</span>
                </div>
              </div>

              <AddContext />

              {processing.map((s) => (
                <Pipeline key={s.id} source={s} />
              ))}

              {conflict && <ConflictBanner />}
            </>
          )}

          <p className="sr" role="status" aria-live="polite">
            {notice}
          </p>
          {notice && !panelOpen && (
            <p className="notice" aria-hidden="true">
              {notice}
            </p>
          )}

          <SourceTable sources={sources} compact={panelOpen} selectedId={selectedId} />
        </div>
      </div>
      <Outlet />
    </div>
  );
}

/* ---------- Add context ---------- */

function AddContext() {
  const [kind, setKind] = useState<ScopeKind>('app');
  const [workspace, setWorkspace] = useState(workspaces[0]);
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const linkId = useId();
  const wsId = useId();

  const take = (files: FileList | null) => {
    if (!files?.length) return;
    setFileErrors(addFiles(Array.from(files), kind, workspace, currentUser.name));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    take(e.dataTransfer.files);
  };

  const submitLink = (e: FormEvent) => {
    e.preventDefault();
    const err = addConfluence(link, kind, workspace);
    setLinkError(err);
    if (!err) setLink('');
  };

  return (
    <section className="card drop" aria-label="Add context">
      <div
        className={`dz${dragging ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <Icon name="upload" />
        <b>
          Drop files here or{' '}
          <button type="button" className="linkbtn" onClick={() => input.current?.click()}>
            browse
          </button>
        </b>
        <span className="muted" style={{ fontSize: 13 }}>
          PDF, Word, images, or a repository as a ZIP. Up to {adminSettings.maxUploadMb} MB each, set by your admin.
        </span>
        <div className="types" aria-hidden="true">
          <span className="pill">
            <Icon name="doc" small />
            PDF
          </span>
          <span className="pill">
            <Icon name="word" small />
            Word
          </span>
          <span className="pill">
            <Icon name="img" small />
            PNG, JPG
          </span>
          <span className="pill">
            <Icon name="codeic" small />
            ZIP
          </span>
        </div>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept={acceptedFileTypes}
          onChange={(e) => {
            take(e.target.files);
            e.target.value = '';
          }}
        />
        {fileErrors.length > 0 && (
          <ul className="errors" role="alert">
            {fileErrors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="linkbox">
        <form onSubmit={submitLink} className="linkform">
          <label htmlFor={linkId} style={{ fontSize: 14, fontWeight: 600 }}>
            Add a Confluence page
          </label>
          <div className="field-row">
            <div className="field">
              <Icon name="link" small />
              <input
                id={linkId}
                type="url"
                placeholder="Paste a Confluence link"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                aria-invalid={!!linkError}
                aria-describedby={linkError ? `${linkId}-err` : `${linkId}-hint`}
              />
            </div>
            <button type="submit" className="btn" disabled={!link.trim()}>
              Add
            </button>
          </div>
          {linkError ? (
            <span id={`${linkId}-err`} className="errtext">
              {linkError}
            </span>
          ) : (
            <span id={`${linkId}-hint`} className="muted" style={{ fontSize: 12.5 }}>
              Read with your Confluence access and re-synced when the page changes.
            </span>
          )}
        </form>

        <fieldset className="scoperow">
          <legend>Use new sources for</legend>
          {(
            [
              ['app', 'Whole app'],
              ['workspace', 'One workspace'],
              ['chat', 'This chat only'],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="radio">
              <input type="radio" name="scope" value={k} checked={kind === k} onChange={() => setKind(k)} />
              {label}
            </label>
          ))}
        </fieldset>
        {kind === 'workspace' && (
          <div className="wsrow">
            <label htmlFor={wsId}>Workspace</label>
            <select id={wsId} value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w}>{w}</option>
              ))}
            </select>
          </div>
        )}
        {kind === 'chat' && (
          <span className="muted" style={{ fontSize: 12.5 }}>
            Chat-only sources are used in your next chat and are not added to the app.
          </span>
        )}
      </div>
    </section>
  );
}

/* ---------- Processing ---------- */

function Pipeline({ source }: { source: Source }) {
  const stage = source.stage ?? 0;
  const label = (step: string) => (step === 'Text extracted' && source.type === 'Image' ? 'Text read by the model' : step);
  return (
    <section className="card pipeline" aria-label={`Processing ${source.title}`}>
      <div className="pipehead">
        <span>
          <b>{source.title}</b>{' '}
          <span className="muted">
            · {source.scope === 'App' ? 'whole app' : source.scope}
            {source.addedBy ? ` · added by ${source.addedBy}` : ''}
          </span>
        </span>
        <span className="muted" style={{ fontSize: 13 }}>
          Usually under a minute
        </span>
      </div>
      <ol className="pipe">
        {processingSteps.map((step, i) => {
          const st = i < stage ? 'done' : i === stage ? 'run' : '';
          return (
            <li key={step} className={`pstep ${st}`} aria-current={i === stage ? 'step' : undefined}>
              <span className="pdot">{st === 'done' && <Icon name="check" />}</span>
              {label(step)}
              <span className="sr">{st === 'done' ? ', done' : st === 'run' ? ', in progress' : ', waiting'}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* ---------- Conflict ---------- */

function ConflictBanner() {
  const { conflict } = useContextStore();
  const navigate = useNavigate();
  const [comparing, setComparing] = useState(false);
  if (!conflict) return null;
  return (
    <div className="conflictwrap">
      <div className="conflict" role="alert">
        <Icon name="warn" />
        <div>
          <b>{conflict.title}</b>
          <br />
          {conflict.detail}
        </div>
        <div className="acts">
          <button type="button" className="btn" aria-expanded={comparing} onClick={() => setComparing(!comparing)}>
            {comparing ? 'Hide comparison' : 'Compare'}
          </button>
          <button type="button" className="btn ink" onClick={() => navigate(`/huddle/${conflict.huddleItemId}`)}>
            Send to Huddle
          </button>
        </div>
      </div>
      {comparing && (
        <div className="card compare">
          {conflict.compare.map((c) => (
            <div key={c.label}>
              <b>{c.label}</b>
              <em>{c.value}</em>
              <span className="muted">{c.where}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Sources table ---------- */

const statusFilters: { value: 'all' | SourceStatus; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'ready', label: 'Ready' },
  { value: 'indexed', label: 'Indexed' },
  { value: 'review', label: 'Needs review' },
  { value: 'processing', label: 'Processing' },
  { value: 'failed', label: 'Failed' },
];

function SourceTable({ sources: raw, compact, selectedId }: { sources: Source[]; compact: boolean; selectedId?: string }) {
  // The Jira row shows the live sync state from the ticket store, so it matches the Tickets page.
  const tickets = useTickets();
  const sync = useJiraSync();
  const sources = useMemo(
    () =>
      raw.map((s) =>
        s.type === 'Jira'
          ? {
              ...s,
              sub: `filter: ${sync.filter} · synced every ${sync.everyMinutes} min · last sync ${relTime(sync.lastSync)}`,
              content: `${tickets.length} tickets`,
              updated: sync.syncing ? 'Syncing…' : `Last sync ${relTime(sync.lastSync)}`,
            }
          : s,
      ),
    [raw, tickets, sync],
  );
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | SourceStatus>('all');
  const [page, setPage] = useState(1);
  const navigate = useNavigate();
  const searchId = useId();
  const statusId = useId();

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sources.filter(
      (s) =>
        (status === 'all' || s.status === status) &&
        (!needle || `${s.title} ${s.sub} ${s.type} ${s.scope}`.toLowerCase().includes(needle)),
    );
  }, [sources, q, status]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  useEffect(() => setPage(1), [q, status]);
  const current = Math.min(page, pages);
  const rows = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const first = filtered.length ? (current - 1) * PAGE_SIZE + 1 : 0;

  const openHref = (s: Source) => s.href ?? `/context/source/${encodeURIComponent(s.id)}`;

  return (
    <section className={`card dt${compact ? ' compact' : ''}`} aria-label="Sources">
      <div className="toolbar">
        <div className="search">
          <Icon name="search" small />
          <label htmlFor={searchId} className="sr">
            Search sources
          </label>
          <input id={searchId} type="search" placeholder="Search sources" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="selectwrap">
          <Icon name="filter" small />
          <label htmlFor={statusId} className="sr">
            Status
          </label>
          <select id={statusId} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            {statusFilters.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              {!compact && <th>Type</th>}
              <th>Scope</th>
              {!compact && <th>Trust</th>}
              <th>Status</th>
              {!compact && (
                <>
                  <th>Content</th>
                  <th>Updated</th>
                  <th>
                    <span className="sr">Ask</span>
                  </th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const st = statusLabel[s.status];
              return (
                <tr key={s.id} className={s.id === selectedId ? 'sel' : undefined}>
                  <td>
                    <div className="src">
                      <span className="tile">
                        <Icon name={s.icon} small />
                      </span>
                      <div>
                        <Link to={openHref(s)} className="srclink" aria-current={s.id === selectedId ? 'page' : undefined}>
                          {s.title}
                        </Link>
                        <small>{s.sub}</small>
                      </div>
                    </div>
                  </td>
                  {!compact && <td>{s.type}</td>}
                  <td className={s.scope === 'App' ? undefined : 'mono'} style={s.scope === 'App' ? undefined : { fontSize: 12.5 }}>
                    {s.scope === 'App' ? 'Whole app' : s.scope}
                  </td>
                  {!compact && <td>{s.trust}</td>}
                  <td>
                    <span className={`pill ${st.tone}`}>
                      {s.status === 'processing' ? `${st.label}: ${s.content}` : st.label}
                    </span>
                    {s.failReason && !compact && <small className="failreason">{s.failReason}</small>}
                  </td>
                  {!compact && (
                    <>
                      <td className="muted">{s.status === 'processing' ? '' : s.content}</td>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                        {s.updated}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn plain askbtn"
                          aria-label={s.href ? `Open ${s.title}` : `Ask Horizon about ${s.title}`}
                          // TODO: start a chat scoped to this source (item chips in the composer).
                          onClick={() => navigate(s.href ?? '/')}
                        >
                          <Icon name="chat" small />
                          {s.href ? 'Open' : 'Ask'}
                        </button>
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={compact ? 3 : 8} className="muted" style={{ padding: 16 }}>
                  No sources match. Clear the search or the status filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <span>
          Showing {first} to {first ? first + rows.length - 1 : 0} of {filtered.length} sources
        </span>
        {pages > 1 && (
          <nav className="pages" aria-label="Pages">
            {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                className={n === current ? 'on' : undefined}
                aria-current={n === current ? 'page' : undefined}
                aria-label={`Page ${n}`}
                onClick={() => setPage(n)}
              >
                {n}
              </button>
            ))}
          </nav>
        )}
      </div>
    </section>
  );
}
