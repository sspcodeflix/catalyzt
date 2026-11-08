import { useId, useMemo, useState, type FormEvent } from 'react';
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';

import { Icon } from '../components/Icon';
import { startUatChat } from '../lib/chatStore';
import { currentScope } from '../lib/session';
import { setJiraFilter, syncNow, useJiraSync, useTickets } from '../lib/ticketStore';
import { STORY_STATUSES, type StoryStatus, type Ticket, type UatState } from '../lib/types';

export const uatPill: Record<UatState, { cls: string; label: string }> = {
  'not-analysed': { cls: '', label: 'Not analysed' },
  gaps: { cls: 'warn', label: 'Gaps' },
  ready: { cls: 'pass', label: 'Ready' },
  'signed-off': { cls: 'pass', label: 'Signed off' },
};

export const relTime = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

export const uatText = (t: Ticket) =>
  t.uat.state === 'not-analysed'
    ? uatPill[t.uat.state].label
    : t.uat.state === 'signed-off' && t.uat.signedOff
      ? `Signed off · ${relTime(t.uat.signedOff.at)} by ${t.uat.signedOff.by}`
      : `${uatPill[t.uat.state].label} · ${t.uat.covered} of ${t.uat.total}${t.uat.analysedAt ? ` · analysed ${relTime(t.uat.analysedAt)}${t.uat.by ? ` by ${t.uat.by}` : ''}` : ''}`;

type Filter = 'all' | UatState;

/**
 * Jira stories Catalyzt pulls on a schedule. Pick one to analyse it for UAT, or create one.
 * Route /tickets; a story opens in the side panel at /tickets/:ticketKey, and /tickets/new creates one.
 */
export function Tickets() {
  const tickets = useTickets();
  const sync = useJiraSync();
  const navigate = useNavigate();
  const { ticketKey } = useParams();
  const panelOpen = useLocation().pathname.split('/').length > 2;
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState(false);
  const filterId = useId();

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return tickets.filter(
      (t) =>
        (filter === 'all' || t.uat.state === filter) &&
        (!needle || [t.key, t.summary, ...t.components, t.fixVersion].some((x) => x.toLowerCase().includes(needle))),
    );
  }, [tickets, q, filter]);

  const counts = (s: Filter) => (s === 'all' ? tickets.length : tickets.filter((t) => t.uat.state === s).length);

  const analyse = (t: Ticket) => {
    // Re-open the existing analysis if there is one; otherwise start a new UAT chat.
    const scope = currentScope();
    if (!scope) return;
    const id = t.uat.chatId ?? startUatChat(t.key, scope);
    navigate(`/chat/${id}/artifact/uat-${t.key.toLowerCase()}`);
  };

  return (
    <div className={`body panelpage${panelOpen ? ' split' : ''}`}>
      <div className="chatcol listcol">
        <div className="page">
          <div className="pagehead withaction">
            <div>
              <h1 className="pagetitle">Jira Stories</h1>
              <p className="muted">
                Stories come from the workspace backlog for project {sync.project || '…'}; there is no live Jira connection in this
                build, and an app owner re-imports the backlog after editing it. Pick one to analyse it for UAT: each acceptance
                criterion is checked against your tests.
              </p>
            </div>
            <Link to="/tickets/new" className="btn ink">
              <Icon name="plus" small />
              Create story
            </Link>
          </div>

          <div className="syncbar">
            <Icon name="link" small />
            <span>
              <b>Jira · project {sync.project}</b> <span className="mono">{sync.filter}</span>
            </span>
            <span className="muted" role="status">
              {sync.error ? `Could not load stories: ${sync.error}` : sync.syncing ? 'Re-reading the backlog…' : `Last import ${relTime(sync.lastSync)} · workspace backlog`}
            </span>
            <span className="grow" />
            <button type="button" className="btn" onClick={syncNow} disabled={sync.syncing}>
              <Icon name="retry" small />
              Re-import backlog
            </button>
            <button type="button" className="btn plain" aria-expanded={editing} aria-controls={filterId} onClick={() => setEditing(!editing)}>
              <Icon name="filter" small />
              Change filter
            </button>
          </div>
          {editing && <FilterEditor id={filterId} onClose={() => setEditing(false)} />}

          <div className="tools">
            <label className="search">
              <Icon name="search" small />
              <input
                type="search"
                placeholder="Search key, summary, component or version"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                aria-label="Search stories"
              />
            </label>
            <span className="segctl" role="radiogroup" aria-label="UAT status">
              {(['all', 'not-analysed', 'gaps', 'ready', 'signed-off'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={filter === f}
                  className={filter === f ? 'on' : undefined}
                  onClick={() => setFilter(f)}
                >
                  {f === 'all' ? 'All' : uatPill[f].label} {counts(f)}
                </button>
              ))}
            </span>
          </div>

          <div className="tablewrap">
            <table className="tickets">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th className="hidem">Type</th>
                  <th className="hidem">Version</th>
                  <th>UAT</th>
                  <th className="hidem">Updated</th>
                  <th>
                    <span className="sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => (
                  <tr key={t.key} className={t.key === ticketKey ? 'on' : undefined}>
                    <td>
                      <Link to={`/tickets/${t.key}`} className="tlink">
                        <span className="mono">{t.key}</span>
                        <span>{t.summary}</span>
                      </Link>
                    </td>
                    <td className="hidem">{t.type}</td>
                    <td className="hidem mono">{t.fixVersion}</td>
                    <td>
                      <span className={`pill ${uatPill[t.uat.state].cls}`}>{uatText(t)}</span>
                    </td>
                    <td className="hidem muted nowrap">{relTime(t.updated)}</td>
                    <td className="r">
                      <button type="button" className="btn small" onClick={() => analyse(t)} aria-label={`${t.uat.chatId ? 'Open analysis' : 'Analyse for UAT'}: ${t.key}`}>
                        <Icon name="target" small />
                        <span className="hidem">{t.uat.chatId ? 'Open analysis' : 'Analyse for UAT'}</span>
                      </button>
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      {sync.loaded ? 'No stories match.' : 'Loading stories…'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="tfoot">
            <span>
              Showing {shown.length} of {tickets.length}
            </span>
            <span>Read with a read-only Jira service account</span>
          </div>
        </div>
      </div>
      <Outlet />
    </div>
  );
}

/** Edits which stories Catalyzt pulls: the statuses in the filter and how often it syncs. Saved on the server. */
function FilterEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const sync = useJiraSync();
  const [statuses, setStatuses] = useState<StoryStatus[]>(sync.statuses);
  const [every, setEvery] = useState(sync.everyMinutes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (statuses.length === 0) return setError('Choose at least one status.');
    setSaving(true);
    setError(null);
    try {
      await setJiraFilter(statuses, every);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form id={id} className="card filtered" onSubmit={save} aria-label="Jira filter">
      <fieldset>
        <legend>Pull stories in project {sync.project} with status</legend>
        <div className="checks">
          {STORY_STATUSES.map((st) => (
            <label key={st} className="check">
              <input
                type="checkbox"
                checked={statuses.includes(st)}
                onChange={(e) => setStatuses(e.target.checked ? [...statuses, st] : statuses.filter((x) => x !== st))}
              />
              {st}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="inline">
        Sync every
        <select value={every} onChange={(e) => setEvery(Number(e.target.value))}>
          {[5, 15, 30, 60].map((m) => (
            <option key={m} value={m}>
              {m} minutes
            </option>
          ))}
        </select>
      </label>
      <p className="muted mono jqlpreview">
        project = {sync.project} AND status in ({statuses.map((x) => `"${x}"`).join(', ') || '…'})
      </p>
      {error && (
        <p className="errtext" role="alert">
          {error}
        </p>
      )}
      <div className="formactions">
        <button type="button" className="btn plain" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn ink" disabled={saving}>
          {saving ? 'Saving…' : 'Save filter'}
        </button>
      </div>
    </form>
  );
}
