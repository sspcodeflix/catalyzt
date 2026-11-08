import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Icon } from '../components/Icon';
import { loadMoreRecents, useChatList, useRecentChats, useRecentChatsPage } from '../lib/chatStore';
import { useTickets } from '../lib/ticketStore';
import { uatPill, uatText } from './Tickets';

/** Search across chats (titles and messages) and Jira stories. */
export function Search() {
  const [q, setQ] = useState('');
  const chats = useChatList();
  const recents = useRecentChats();
  const { hasMore } = useRecentChatsPage();
  const [more, setMore] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const tickets = useTickets();
  const needle = q.trim().toLowerCase();

  const chatHits = useMemo(() => {
    const loaded = chats.map((c) => ({
      id: c.id,
      title: c.title,
      text: c.messages.map((m) => (m.role === 'user' ? m.text : m.blocks.map((b) => (b.kind === 'prose' ? b.text : '')).join(' '))).join(' '),
    }));
    const others = recents.filter((r) => !chats.some((c) => c.id === r.id)).map((r) => ({ id: r.id, title: r.title, text: '' }));
    const all = [...loaded, ...others];
    return needle ? all.filter((c) => `${c.title} ${c.text}`.toLowerCase().includes(needle)) : all;
  }, [chats, recents, needle]);

  const ticketHits = useMemo(
    () =>
      tickets.filter((t) =>
        !needle ? true : [t.key, t.summary, t.description, ...t.acceptanceCriteria, ...t.components].some((x) => x.toLowerCase().includes(needle)),
      ),
    [tickets, needle],
  );

  return (
    <div className="page">
      <h1 className="pagetitle">Search</h1>
      <label className="search big">
        <Icon name="search" />
        <input
          type="search"
          autoFocus
          placeholder="Search chats and Jira stories"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search chats and Jira stories"
        />
      </label>

      <section aria-labelledby="sr-chats">
        <div className="sechead">
          <h3 id="sr-chats">Chats</h3>
          <span>{chatHits.length}</span>
        </div>
        <ul className="results">
          {chatHits.map((c) => (
            <li key={c.id}>
              <Link to={`/chat/${c.id}`}>
                <Icon name="chat" small />
                <span>{c.title}</span>
              </Link>
            </li>
          ))}
          {chatHits.length === 0 && <li className="muted">No chats match.</li>}
        </ul>
        {hasMore && (
          <p>
            <button
              type="button"
              className="btn plain"
              disabled={more.busy}
              aria-busy={more.busy}
              onClick={() => {
                setMore({ busy: true, error: null });
                loadMoreRecents().then(
                  () => setMore({ busy: false, error: null }),
                  (e: Error) => setMore({ busy: false, error: e.message }),
                );
              }}
            >
              {more.busy ? 'Loading…' : 'Load more chats'}
            </button>
            {more.error && <span className="errtext"> {more.error}</span>}
          </p>
        )}
      </section>

      <section aria-labelledby="sr-tickets">
        <div className="sechead">
          <h3 id="sr-tickets">Jira stories</h3>
          <span>{ticketHits.length}</span>
        </div>
        <ul className="results">
          {ticketHits.map((t) => (
            <li key={t.key}>
              <Link to={`/tickets/${t.key}`}>
                <Icon name="doc" small />
                <span>
                  <span className="mono">{t.key}</span> {t.summary}
                </span>
                <span className={`pill ${uatPill[t.uat.state].cls}`}>{uatText(t)}</span>
              </Link>
            </li>
          ))}
          {ticketHits.length === 0 && <li className="muted">No stories match.</li>}
        </ul>
      </section>
    </div>
  );
}
