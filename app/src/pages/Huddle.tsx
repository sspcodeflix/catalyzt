import { useId, useMemo, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';

import { Icon } from '../components/Icon';
import { kindInfo, me, useHuddle, type HuddleItem } from '../lib/huddleData';
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
  const items = useHuddle();
  const location = useLocation();
  const panelOpen = /^\/huddle\/[^/]+/.test(location.pathname);
  const selectedId = panelOpen ? decodeURIComponent(location.pathname.split('/')[2]) : undefined;
  const [filter, setFilter] = useState<Filter>('open');
  const [q, setQ] = useState('');
  const searchId = useId();

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
              <h1>Huddle</h1>
              <p>
                Decisions Horizon won't make on its own: conflicting sources, disputed mappings, accepted risks and
                patterns in feedback. Each one links to the items it affects.
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
                <button
                  key={f.id}
                  type="button"
                  className={filter === f.id ? 'on' : undefined}
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label} {counts[f.id]}
                </button>
              ))}
            </div>
          </div>

          <section className="card hlist" aria-label={`${filters.find((f) => f.id === filter)!.label} decisions`}>
            {shown.length === 0 && (
              <p className="muted" style={{ padding: 16, margin: 0 }}>
                {q ? 'No decisions match your search.' : 'Nothing here.'}
              </p>
            )}
            {shown.map((i) => {
              const st = itemStatus(i);
              const sel = i.id === selectedId;
              return (
                <Link
                  key={i.id}
                  to={`/huddle/${i.id}`}
                  className={`hitem${sel ? ' sel' : ''}`}
                  aria-current={sel ? 'page' : undefined}
                >
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
                      Raised by {i.raisedBy} · {i.raisedAt}
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
