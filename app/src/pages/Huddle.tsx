import { Fragment, useEffect, useId, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';

import { Icon } from '../components/Icon';
import { DOMAINS, domainInfo, kindInfo, loadHuddle, loadMoreHuddle, useHuddleState, type HuddleDomain, type HuddleFilter, type HuddleItem, type HuddleSummary } from '../lib/huddleData';
import { useSession } from '../lib/session';
import { relTime } from './Tickets';
import '../styles/pages.css';

type Filter = HuddleFilter;

export const itemStatus = (i: HuddleItem | HuddleSummary) =>
  i.stage === 'closed'
    ? { label: i.answer && !i.decision ? 'Answered' : 'Closed', tone: 'pass' }
    : i.stage === 'follow_up'
      ? { label: 'Follow-up', tone: 'info' }
      : i.stage === 'decided' || i.decision
        ? { label: 'Decided', tone: 'pass' }
        : i.needsInput
          ? { label: 'Needs more input', tone: 'info' }
          : { label: i.openLabel, tone: i.openTone };

/** A date as "12 Nov 2026". */
export const shortDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
};

/** Huddle: the team's shared place for decisions that the model or one person should not make alone. */
export function Huddle() {
  const { items, loaded, error, counts, waiting, domains, query, nextCursor, loadingMore } = useHuddleState();
  const location = useLocation();
  const panelOpen = /^\/huddle\/[^/]+/.test(location.pathname);
  const selectedId = panelOpen ? decodeURIComponent(location.pathname.split('/')[2]) : undefined;
  // The filter and the search run on the server, a page at a time (the list can be long).
  const filter = query.filter;
  const [q, setQ] = useState(query.q);
  const [moreError, setMoreError] = useState<string | null>(null);
  const searchId = useId();
  const { loaded: sessionLoaded } = useSession();
  const setFilter = (f: Filter) => void loadHuddle(false, { filter: f });
  const setDomain = (d: HuddleDomain | null) => void loadHuddle(false, { domain: d });
  const domain = query.domain;

  useEffect(() => {
    if (sessionLoaded) void loadHuddle();
  }, [sessionLoaded]);
  // Search after a short pause in typing.
  useEffect(() => {
    if (!sessionLoaded || q === query.q) return;
    const t = setTimeout(() => void loadHuddle(false, { q }), 250);
    return () => clearTimeout(t);
  }, [q, query.q, sessionLoaded]);

  const shown = items;
  const more = () => {
    setMoreError(null);
    loadMoreHuddle().catch((e: Error) => setMoreError(e.message));
  };

  const filters: { id: Filter; label: string }[] = [
    { id: 'open', label: 'Open' },
    { id: 'waiting', label: 'Waiting on me' },
    { id: 'decided', label: 'Decided' },
    { id: 'mine', label: 'Mine' },
  ];

  const emptyText = !loaded
    ? 'Loading decisions…'
    : error
      ? `Could not load decisions: ${error}`
      : q
        ? 'No decisions match your search.'
        : domain && filter === 'open'
          ? `Nothing open in ${domainInfo[domain].label}.`
        : filter === 'waiting'
          ? 'Nothing waits on you: no item is yours to decide and you own no open action.'
        : filter === 'open'
          ? 'Nothing to decide right now. Decisions appear when someone raises one, when a source conflicts with a higher-trust source, or when Catalyzt finds a pattern in low ratings.'
          : filter === 'decided'
            ? 'Nothing decided yet.'
            : 'Nothing open that you raised, voted on or commented on.';

  return (
    <div className={`body panelpage${panelOpen ? ' split' : ''}`}>
      <div className="chatcol listcol">
        <div className="page">
          <div className="pagehead">
            <div>
              <span className="appname">
                <Icon name="layers" small />
                {useSession().me?.app?.name ?? 'Loading…'}
              </span>
              <h1>Huddle · Decisions</h1>
              <p>
                Concerns, decisions and accepted risks across testing, reliability and security, and the actions they
                create. Votes are advisory; the domain's decider decides, with a reason that is kept.
              </p>
            </div>
          </div>

          <div className="tools">
            <div className="search">
              <Icon name="search" small />
              <label htmlFor={searchId} className="sr">
                Search decisions
              </label>
              <input id={searchId} type="search" placeholder="Search decisions" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="segctl" role="group" aria-label="Show">
              {filters.map((f) => (
                <button key={f.id} type="button" className={filter === f.id ? 'on' : undefined} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                  {f.label} {f.id === 'waiting' ? waiting : counts[f.id]}
                </button>
              ))}
            </div>
          </div>
          <div className="chips domainchips" role="group" aria-label="Domain">
            <button type="button" className={`chip${!domain ? ' on' : ''}`} aria-pressed={!domain} onClick={() => setDomain(null)}>
              All
            </button>
            {DOMAINS.map((d) => (
              <button key={d} type="button" className={`chip${domain === d ? ' on' : ''}`} aria-pressed={domain === d} onClick={() => setDomain(d)}>
                {domainInfo[d].label}
                {domains && domains[d] > 0 ? <span className="muted"> {domains[d]}</span> : null}
              </button>
            ))}
          </div>

          <section className="card hlist" aria-label={`${filters.find((f) => f.id === filter)!.label} decisions`} aria-busy={!loaded}>
            {shown.length === 0 && (
              <p className={`muted${error ? ' errtext' : ''}`} style={{ padding: 16, margin: 0 }} role={error ? 'alert' : undefined}>
                {emptyText}
              </p>
            )}
            {shown.map((i) => {
              const st = itemStatus(i);
              const sel = i.id === selectedId;
              return (
                <Fragment key={i.id}>
                <Link to={`/huddle/${i.id}`} className={`hitem${sel ? ' sel' : ''}`} aria-current={sel ? 'page' : undefined}>
                  <span className="tile">
                    <Icon name={kindInfo[i.kind].icon} small />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <span className="kind">
                      <span className="kindbadge">{kindInfo[i.kind].label}</span> · {domainInfo[i.domain].label}
                      {i.severity ? ` · ${i.severity[0].toUpperCase()}${i.severity.slice(1)}` : ''}
                    </span>
                    <b>{i.title}</b>
                    <small>{i.summary}</small>
                    <div className="meta">
                      <span className="faces" aria-hidden="true">
                        {i.people.map((f) => (
                          <span key={f} className="avatar">
                            {f}
                          </span>
                        ))}
                      </span>
                      Raised by {i.raisedBy} · {relTime(i.raisedAt)}
                      {i.dueAt && <span>· Due {shortDate(i.dueAt)}</span>}
                      {i.expiresAt && <span>· {i.stage === 'open' && i.reopenNote ? 'Expired' : 'Expires'} {shortDate(i.expiresAt)}</span>}
                      {i.actions.some((a) => a.status === 'open') && <span>· {i.actions.filter((a) => a.status === 'open').length} open action{i.actions.filter((a) => a.status === 'open').length === 1 ? '' : 's'}</span>}
                      {i.overdue && <span className="pill crit">Overdue</span>}
                      {i.waitingOnMe && <span className="pill info">Waiting on you</span>}
                    </div>
                  </div>
                  <span className={`pill ${st.tone}`}>{st.label}</span>
                </Link>
                {/* R17: a likely duplicate is flagged, never merged; the link opens the other item. */}
                {i.similar.length > 0 && (
                  <p className="similar">
                    <Icon name="warn" small />
                    <span>
                      Similar to{' '}
                      <Link to={`/huddle/${i.similar[0].id}`}>{i.similar[0].title}</Link>
                      {i.similar.length > 1 ? ` and ${i.similar.length - 1} more open` : ''}
                    </span>
                  </p>
                )}
                </Fragment>
              );
            })}
          </section>
          {nextCursor && (
            <p className="loadmore">
              <button type="button" className="btn plain" onClick={more} disabled={loadingMore} aria-busy={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more decisions'}
              </button>
              {moreError && (
                <span className="errtext" role="alert">
                  {' '}
                  {moreError}
                </span>
              )}
            </p>
          )}
        </div>
      </div>
      <Outlet />
    </div>
  );
}
