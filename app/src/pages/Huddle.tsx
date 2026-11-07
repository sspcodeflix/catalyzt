import { useEffect, useId, useMemo, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';

import { Icon } from '../components/Icon';
import { kindInfo, loadHuddle, me, useHuddleState, type HuddleItem } from '../lib/huddleData';
import { useSession } from '../lib/session';
import { relTime } from './Tickets';
import '../styles/pages.css';

type Filter = 'open' | 'decided' | 'mine';

const isMine = (i: HuddleItem) => i.people.includes(me.initials);

export const itemStatus = (i: HuddleItem) =>
  i.decision
    ? { label: 'Decided', tone: 'pass' }
    : i.needsInput
      ? { label: 'Needs more input', tone: 'info' }
      : { label: i.openLabel, tone: i.openTone };

/** Huddle: the team's shared place for decisions that the model or one person should not make alone. */
export function Huddle() {
  const { items, loaded, error } = useHuddleState();
  const location = useLocation();
  const panelOpen = /^\/huddle\/[^/]+/.test(location.pathname);
  const selectedId = panelOpen ? decodeURIComponent(location.pathname.split('/')[2]) : undefined;
  const [filter, setFilter] = useState<Filter>('open');
  const [q, setQ] = useState('');
  const searchId = useId();
  const { loaded: sessionLoaded } = useSession();

  useEffect(() => {
    if (sessionLoaded) void loadHuddle();
  }, [sessionLoaded]);

  const counts = {
    open: items.filter((i) => !i.decision).length,
    decided: items.filter((i) => i.decision).length,
    mine: items.filter((i) => !i.decision && isMine(i)).length,
  };

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((i) => {
      const inFilter = filter === 'open' ? !i.decision : filter === 'decided' ? !!i.decision : !i.decision && isMine(i);
      const text = `${i.title} ${i.summary} ${kindInfo[i.kind].label} ${i.raisedBy}`.toLowerCase();
      return inFilter && (!needle || text.includes(needle));
    });
  }, [items, filter, q]);

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
                <Link key={i.id} to={`/huddle/${i.id}`} className={`hitem${sel ? ' sel' : ''}`} aria-current={sel ? 'page' : undefined}>
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
              );
            })}
          </section>
        </div>
      </div>
      <Outlet />
    </div>
  );
}
