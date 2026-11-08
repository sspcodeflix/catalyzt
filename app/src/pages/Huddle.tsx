import { Fragment, useEffect, useId, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';

import { Icon } from '../components/Icon';
import { kindInfo, loadHuddle, loadMoreHuddle, useHuddleState, type HuddleFilter, type HuddleItem, type HuddleSummary } from '../lib/huddleData';
import { useSession } from '../lib/session';
import { relTime } from './Tickets';
import '../styles/pages.css';

type Filter = HuddleFilter;

export const itemStatus = (i: HuddleItem | HuddleSummary) =>
  i.decision
    ? { label: 'Decided', tone: 'pass' }
    : i.needsInput
      ? { label: 'Needs more input', tone: 'info' }
      : { label: i.openLabel, tone: i.openTone };

/** Huddle: the team's shared place for decisions that the model or one person should not make alone. */
export function Huddle() {
  const { items, loaded, error, counts, query, nextCursor, loadingMore } = useHuddleState();
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
    { id: 'decided', label: 'Decided' },
    { id: 'mine', label: 'Mine' },
  ];

  const emptyText = !loaded
    ? 'Loading decisions…'
    : error
      ? `Could not load decisions: ${error}`
      : q
        ? 'No decisions match your search.'
        : filter === 'open'
          ? 'Nothing to decide right now. Decisions appear when someone raises one, when a source conflicts with a higher-trust source, or when Catalyzt finds a pattern in low ratings.'
          : filter === 'decided'
            ? 'Nothing decided yet.'
            : 'Nothing open that you raised, voted on or commented on.';

  return (
    <div className={`body${panelOpen ? ' split' : ''}`}>
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
                Decisions Catalyzt won't make on its own: conflicting sources, disputed mappings, accepted risks and
                patterns in feedback. Votes are advisory; an app owner decides, with a reason that is kept.
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
                  {f.label} {counts[f.id]}
                </button>
              ))}
            </div>
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
                    <span className="kind">{kindInfo[i.kind].label}</span>
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
