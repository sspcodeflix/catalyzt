import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';

import { Icon } from '../components/Icon';
import { acceptedFileTypes, addConfluence, iconFor, loadContext, retrievalLabel, statusLabel, uploadFiles, useContextStore, type Conflict, type ScopeKind, type Source, type SourceStatus } from '../lib/contextData';
import { useSession } from '../lib/session';
import { useJiraSync, useTickets } from '../lib/ticketStore';
import { relTime } from './Tickets';
import '../styles/pages.css';

const PAGE_SIZE = 8;

/** App Context: what Catalyzt knows about the selected application, where it came from, and what the team adds. */
export function AppContext() {
  const { sources, conflicts, connectors, limits, retrieval, loaded, error, notice } = useContextStore();
  const { me, loaded: sessionLoaded } = useSession();
  const app = me?.app;
  const location = useLocation();
  const panelOpen = location.pathname.startsWith('/context/source/');
  const selectedId = panelOpen ? decodeURIComponent(location.pathname.split('/')[3] ?? '') : undefined;

  useEffect(() => {
    if (sessionLoaded) void loadContext();
  }, [sessionLoaded]);

  const repos = sources.filter((s) => s.type === 'Repository');
  const indexed = repos.filter((s) => s.status === 'indexed').length;
  const uploads = sources.filter((s) => s.trust === 'Team upload');
  const passages = sources.reduce((a, s) => a + s.chunks, 0);
  const review = sources.filter((s) => s.status === 'review').length;

  return (
    <div className={`body${panelOpen ? ' split' : ''}`}>
      <div className="chatcol listcol">
        <div className="page">
          <div className="pagehead">
            <div>
              <span className="appname">
                <Icon name="layers" small />
                {app ? `${app.name}${app.description ? ` · ${app.description}` : ''}` : 'Loading…'}
              </span>
              <h1>App Context</h1>
              {!panelOpen && (
                <p>
                  Everything Catalyzt knows about this application: the documentation of its repositories, the Jira
                  feed, and what your team uploads. Readable sources are split into passages; answers cite the
                  passages they use, {retrievalLabel(retrieval)}
                </p>
              )}
            </div>
            <Link className="btn" to="/context/source/test">
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
                      <Icon name="lib" />
                    </span>
                    <div>
                      <div style={{ fontWeight: 600 }}>Knowledge sources</div>
                      <span>{connectors ? `Confluence: ${connectors.confluence === 'not_connected' ? 'not connected' : connectors.confluence} · Knowledge Fabric: ${connectors.fabric === 'none' ? 'none' : connectors.fabric}` : 'Checking connectors…'}</span>
                    </div>
                  </div>
                  <span>No Enterprise Knowledge Fabric or Confluence is connected in this build. Repositories, the Jira feed and your uploads are the sources.</span>
                </div>
                <div className="card ctile">
                  <b>{passages}</b>
                  <span>
                    Passages, from {indexed} of {repos.length} repositor{repos.length === 1 ? 'y' : 'ies'} and {uploads.length} upload{uploads.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="card ctile">
                  <b>{review}</b>
                  <span>Needs review: open conflicts with a higher-trust source, decided in Huddle</span>
                </div>
              </div>

              <AddContext workspaces={app?.workspaces ?? []} maxUploadMb={limits?.maxUploadMb ?? 8} readable={limits?.readable ?? []} storedOnly={limits?.storedOnly ?? []} confluence={connectors?.confluence ?? 'not_connected'} />

              {conflicts.map((c) => (
                <ConflictBanner key={c.id} conflict={c} />
              ))}
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
          {error && (
            <p className="errtext" role="alert">
              Could not load the sources: {error}
            </p>
          )}

          <SourceTable sources={sources} loaded={loaded} compact={panelOpen} selectedId={selectedId} />
        </div>
      </div>
      <Outlet />
    </div>
  );
}

/* ---------- Add context ---------- */

function AddContext({ workspaces, maxUploadMb, readable, storedOnly, confluence }: { workspaces: string[]; maxUploadMb: number; readable: string[]; storedOnly: string[]; confluence: string }) {
  const [kind, setKind] = useState<ScopeKind>('app');
  const [workspace, setWorkspace] = useState(workspaces[0] ?? '');
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [link, setLink] = useState('');
  const [linkMessage, setLinkMessage] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const wsId = useId();
  const linkId = useId();

  useEffect(() => {
    if (!workspace && workspaces[0]) setWorkspace(workspaces[0]);
  }, [workspaces, workspace]);

  const take = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setFileErrors([]);
    try {
      setFileErrors(await uploadFiles(Array.from(files), kind, workspace));
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void take(e.dataTransfer.files);
  };

  return (
    <section className="card drop" aria-label="Add context" aria-busy={uploading}>
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
          {uploading ? (
            'Uploading…'
          ) : (
            <>
              Drop files here or{' '}
              <button type="button" className="linkbtn" onClick={() => input.current?.click()}>
                browse
              </button>
            </>
          )}
        </b>
        <span className="muted" style={{ fontSize: 13 }}>
          Readable and split into passages: {readable.join(', ') || 'text formats'}. Kept but not readable in this build: {storedOnly.join(', ') || 'PDF, Word, images, ZIP'}. Up to {maxUploadMb} MB each.
        </span>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept={acceptedFileTypes}
          onChange={(e) => {
            void take(e.target.files);
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
        <div style={{ fontSize: 14, fontWeight: 600 }}>Confluence</div>
        {confluence === 'not_connected' ? (
          <div className="callout" role="status">
            <Icon name="link" small />
            <span>Not connected in this build. Export the page as Markdown or text and upload it here, so Catalyzt can read and cite it.</span>
          </div>
        ) : (
          <form
            className="linkform"
            onSubmit={(e) => {
              e.preventDefault();
              void addConfluence(link).then((m) => setLinkMessage(m || 'Added.'));
            }}
          >
            <label htmlFor={linkId} className="sr">
              Confluence link
            </label>
            <div className="field-row">
              <div className="field">
                <Icon name="link" small />
                <input id={linkId} type="url" placeholder="Paste a Confluence link" value={link} onChange={(e) => setLink(e.target.value)} />
              </div>
              <button type="submit" className="btn" disabled={!link.trim()}>
                Add
              </button>
            </div>
            {linkMessage && <span className="errtext">{linkMessage}</span>}
          </form>
        )}

        <fieldset className="scoperow">
          <legend>Use new sources for</legend>
          {(
            [
              ['app', 'Whole app'],
              ['workspace', 'One workspace'],
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
        <span className="muted" style={{ fontSize: 12.5 }}>
          For one chat only, attach the file in the composer instead.
        </span>
      </div>
    </section>
  );
}

/* ---------- Conflict ---------- */

function ConflictBanner({ conflict }: { conflict: Conflict }) {
  const [comparing, setComparing] = useState(false);
  return (
    <div className="conflictwrap">
      <div className="conflict" role="alert">
        <Icon name="warn" />
        <div>
          <b>{conflict.title}</b>
          <br />
          {conflict.detail || `${conflict.sourceTitle} disagrees with ${conflict.otherTitle}. Its passages are excluded until an app owner decides.`}
        </div>
        <div className="acts">
          <button type="button" className="btn" aria-expanded={comparing} onClick={() => setComparing(!comparing)}>
            {comparing ? 'Hide comparison' : 'Compare'}
          </button>
          {conflict.huddleItemId && (
            <Link className="btn ink" to={`/huddle/${conflict.huddleItemId}`}>
              Open in Huddle
            </Link>
          )}
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
  { value: 'stored', label: 'Kept, not readable' },
  { value: 'failed', label: 'Failed' },
];

function SourceTable({ sources: raw, loaded, compact, selectedId }: { sources: Source[]; loaded: boolean; compact: boolean; selectedId?: string }) {
  // The Jira row shows the live sync state from the ticket store, so it matches the Tickets page.
  const tickets = useTickets();
  const sync = useJiraSync();
  const sources = useMemo(
    () =>
      raw.map((s) =>
        s.type === 'Jira'
          ? { ...s, sub: `filter: ${sync.filter} · synced every ${sync.everyMinutes} min`, content: `${tickets.length} tickets in the filter`, updatedAt: sync.lastSync }
          : s,
      ),
    [raw, tickets, sync],
  );
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | SourceStatus>('all');
  const [page, setPage] = useState(1);
  const searchId = useId();
  const statusId = useId();

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sources.filter((s) => (status === 'all' || s.status === status) && (!needle || `${s.title} ${s.sub} ${s.type} ${s.scope}`.toLowerCase().includes(needle)));
  }, [sources, q, status]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  useEffect(() => setPage(1), [q, status]);
  const current = Math.min(page, pages);
  const rows = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const first = filtered.length ? (current - 1) * PAGE_SIZE + 1 : 0;

  const openHref = (s: Source) => s.href ?? `/context/source/${encodeURIComponent(s.id)}`;

  return (
    <section className={`card dt${compact ? ' compact' : ''}`} aria-label="Sources" aria-busy={!loaded}>
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
                    <span className="sr">Open</span>
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
                        <Icon name={iconFor(s.type)} small />
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
                    <span className={`pill ${st.tone}`}>{st.label}</span>
                    {s.note && !compact && <small className="failreason">{s.note}</small>}
                  </td>
                  {!compact && (
                    <>
                      <td className="muted">
                        {s.content}
                        {s.version > 1 ? ` · v${s.version}` : ''}
                      </td>
                      <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                        {relTime(s.updatedAt)}
                      </td>
                      <td>
                        <Link to={openHref(s)} className="btn plain askbtn" aria-label={`Open ${s.title}`}>
                          <Icon name={s.href ? 'right' : 'search'} small />
                          Open
                        </Link>
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={compact ? 3 : 8} className="muted" style={{ padding: 16 }}>
                  {!loaded ? 'Loading sources…' : sources.length === 0 ? 'No sources yet for this application.' : 'No sources match. Clear the search or the status filter.'}
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
              <button key={n} type="button" className={n === current ? 'on' : undefined} aria-current={n === current ? 'page' : undefined} aria-label={`Page ${n}`} onClick={() => setPage(n)}>
                {n}
              </button>
            ))}
          </nav>
        )}
      </div>
    </section>
  );
}
