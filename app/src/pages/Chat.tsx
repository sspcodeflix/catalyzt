import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';

import { AssistantTurn } from '../components/chat/AssistantTurn';
import { StoryFlowBar } from '../components/chat/FlowCards';
import { Composer, type ComposerSubmit } from '../components/Composer';
import { Icon } from '../components/Icon';
import { onTabListKey } from '../components/tabKeys';
import { createChat, isAnswering, loadChat, loadOlderMessages, sendMessage, stopAnswer, useChat, useChatLoad, type ChatLoad } from '../lib/chatStore';
import { api } from '../lib/hexa';
import type { FlowView } from '../lib/flows';
import type { Message } from '../lib/types';
import { sessionEpoch, useSession } from '../lib/session';
import { questionFor } from '../lib/staleAnswer';
import { detectTestType, testTypeLabel } from '../lib/testType';

/**
 * Chat on the left; when a work product is open (nested route), it shows in the side panel
 * on the right. Below 900px the panel stacks under the chat.
 */
export function Chat() {
  // Remount per chat so one chat's local state never carries over to the next.
  const { chatId } = useParams();
  return <ChatView key={chatId} chatId={chatId!} />;
}

function ChatView({ chatId }: { chatId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const first = (location.state as { first?: ComposerSubmit } | null)?.first;
  const created = useRef(false);
  const { userId, me, loaded } = useSession();

  // A new chat from the home page carries its first message in router state.
  useEffect(() => {
    if (first && !created.current) {
      created.current = true;
      createChat(chatId, first);
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [chatId, first, location.pathname, navigate]);

  const chat = useChat(chatId);
  const load = useChatLoad(chatId);
  // Anything else (a reload, a deep link, a recent) comes from the server. A sign-in or application
  // change clears the load records, so a chat that was "missing" in one application is looked up again
  // in the next (F08).
  useEffect(() => {
    if (!chat && !first && loaded && !load) void loadChat(chatId);
  }, [chatId, chat, first, loaded, load]);

  const panelOpen = location.pathname.includes('/artifact/');
  // A flow's team thread is open to every member of the application; other chats to the person who started them.
  const thread = chat?.flowId ?? null;
  const readOnly = !!chat?.createdBy && chat.createdBy !== userId && !thread;
  const flow = useThreadFlow(thread, chatId, chat ? isAnswering(chat) : false);
  const starter = readOnly ? (me?.people.find((p) => p.id === chat?.createdBy)?.name ?? 'someone else') : null;

  // On a phone the report and the chat are tabs, not a stack; both stay mounted so scroll positions survive the switch.
  const [view, setView] = useState<'chat' | 'report'>('report');
  useEffect(() => {
    if (panelOpen) setView('report');
  }, [panelOpen, location.pathname]);

  const send = (msg: ComposerSubmit) => {
    // Sending always brings the newest message into view.
    stick.current = true;
    sendMessage(chatId, msg);
  };

  /* ---------- The conversation scrolls on its own; the reply box stays put ---------- */
  const scroller = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const topSentinel = useRef<HTMLDivElement>(null);
  // Follow new content while the reader is at the bottom; stop following when they scroll up to read.
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const restore = useRef<{ height: number; top: number } | null>(null);
  const toBottom = (smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };
  const lastTop = useRef(0);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // Only the reader scrolling up stops following; content growing under a followed view does not.
    if (near) stick.current = true;
    else if (el.scrollTop < lastTop.current - 2) stick.current = false;
    lastTop.current = el.scrollTop;
    setAtBottom(near || stick.current);
  };
  // Content grows while an answer streams, a report card opens, images load: keep the bottom in view if following.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (restore.current) return;
      if (stick.current) toBottom();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [chat !== undefined]);
  // Older messages are put above without moving what the reader is looking at.
  useLayoutEffect(() => {
    const el = scroller.current;
    const r = restore.current;
    if (el && r) {
      el.scrollTop = el.scrollHeight - r.height + r.top;
      restore.current = null;
    }
  }, [chat?.messages.length]);

  const [older, setOlder] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const showOlder = () => {
    if (older.busy) return;
    const el = scroller.current;
    if (el) restore.current = { height: el.scrollHeight, top: el.scrollTop };
    setOlder({ busy: true, error: null });
    loadOlderMessages(chatId).then(
      () => setOlder({ busy: false, error: null }),
      (e: Error) => {
        restore.current = null;
        setOlder({ busy: false, error: e.message });
      },
    );
  };
  // Scrolling up to the top loads the previous page by itself; the button stays for keyboard users.
  const hasOlder = chat?.olderCursor != null;
  useEffect(() => {
    const target = topSentinel.current;
    const root = scroller.current;
    if (!target || !root || !hasOlder) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && !stick.current) showOlder();
    }, { root, rootMargin: '200px 0px 0px 0px' });
    io.observe(target);
    return () => io.disconnect();
  });

  const renderMessage = (m: Message) =>
            m.role === 'user' ? (
              <Fragment key={m.id}>
                {Boolean(m.testType || m.tickets?.length || m.components?.length || m.attachments?.length) && (
                  <div className="msgtags" aria-label="How Catalyzt read this request">
                    {m.testType && <span className="pill info">{testTypeLabel(m.testType)}</span>}
                    {m.tickets?.map((t) => (
                      <Link key={t} to={`/tickets/${t}`} className="pill mono">
                        {t}
                      </Link>
                    ))}
                    {m.components?.map((c) => (
                      <span key={c} className="pill mono">
                        {c}
                      </span>
                    ))}
                    {m.attachments?.map((a) => (
                      <span key={a.id} className="pill" title={a.status === 'stored' ? 'Kept, but Catalyzt could not read this file' : undefined}>
                        <Icon name="clip" small />
                        {a.filename}
                        {a.status === 'stored' ? ' · not readable' : ''}
                      </span>
                    ))}
                  </div>
                )}
                {thread && m.author && <div className="author">{m.author.id === userId ? 'You' : m.author.name}</div>}
                <div className="user">{m.text}</div>
              </Fragment>
            ) : (
              <AssistantTurn
                key={m.id}
                chat={chat!}
                message={m}
                onFollowUp={(text) => {
                  // A follow-up keeps the chat's test type unless its own words say otherwise.
                  const d = detectTestType(text);
                  send({
                    text,
                    agent: chat!.agent,
                    scope: chat!.scope,
                    testType: d.type ?? chat!.testType,
                    testTypeSource: d.type ? 'rules' : null,
                    tickets: d.tickets,
                    components: [],
                  });
                }}
                onAskAgain={(() => {
                  // R04: the same question, with the same tags, as a new turn; only the chat's owner can send.
                  const q = readOnly || isAnswering(chat!) ? null : questionFor(chat!.messages, m.id);
                  return q
                    ? () =>
                        send({
                          text: q.text,
                          agent: chat!.agent,
                          scope: chat!.scope,
                          testType: q.testType ?? chat!.testType,
                          testTypeSource: q.testType ? 'rules' : null,
                          tickets: q.tickets ?? [],
                          components: q.components ?? [],
                        })
                    : undefined;
                })()}
              />
            );

  return (
    <div className={`body chatpage${panelOpen ? ` split view-${view}` : ''}`}>
      {/* The page heading for assistive technology; the top bar shows the same title visually. */}
      <h1 className="sr">{chat?.title ?? 'Chat'}</h1>
      {panelOpen && (
        <div className="mobiletabs segctl" role="tablist" aria-label="Chat or report" onKeyDown={onTabListKey}>
          <button type="button" role="tab" aria-selected={view === 'chat'} className={view === 'chat' ? 'on' : undefined} onClick={() => setView('chat')}>
            Chat
          </button>
          <button type="button" role="tab" aria-selected={view === 'report'} className={view === 'report' ? 'on' : undefined} onClick={() => setView('report')}>
            Report
          </button>
        </div>
      )}
      <div className="chatcol">
        <div className="threadscroll" ref={scroller} onScroll={onScroll}>
        <div className="thread" ref={threadRef}>
          {!chat && !first && <ChatState load={load} onRetry={() => void loadChat(chatId, true)} />}
          {chat?.olderCursor != null && (
            <div className="olderbar" ref={topSentinel}>
              <button type="button" className="btn plain" onClick={showOlder} disabled={older.busy} aria-busy={older.busy}>
                {older.busy ? 'Loading older messages…' : 'Show older messages'}
              </button>
              {older.error && (
                <span className="errtext" role="alert">
                  {older.error}
                </span>
              )}
            </div>
          )}
          {thread && (
            <div className="threadhead" role="note">
              <Icon name="people" small />
              <span>
                Team thread for <Link to={`/flows/${thread}`}>{flow?.title ?? 'this test flow'}</Link>. Everyone on the team reads and writes here; the flow's steps show up as they happen, and the full history stays with the flow.
              </span>
            </div>
          )}
          {chat && interleave(chat.messages, thread && flow ? flow.events : [], chat.olderCursor != null).map((row) =>
            row.kind === 'event' ? (
              <div key={row.key} className="flowevent">
                <Icon name="branch" small />
                <span>
                  <b>{row.e.who ?? 'Catalyzt'}</b> {row.e.text}
                </span>
                <time dateTime={row.e.at}>{new Date(row.e.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time>
              </div>
            ) : (
              renderMessage(row.m)
            ),
          )}
          {(() => {
            // A question with no saved answer (the run stopped before it could save one) says so, never a blank page.
            const last = chat?.messages[chat.messages.length - 1];
            if (!chat || !last || last.role !== 'user' || isAnswering(chat)) return null;
            return (
              <div className="callout noanswer" role="status">
                <Icon name="warn" small />
                <span>No answer was saved for this question: the run stopped before it finished.</span>
                {!readOnly && (
                  <button
                    type="button"
                    className="btn small"
                    onClick={() =>
                      send({
                        text: last.text,
                        agent: chat.agent,
                        scope: chat.scope,
                        testType: last.testType ?? chat.testType,
                        testTypeSource: last.testType ? 'rules' : null,
                        tickets: last.tickets ?? [],
                        components: last.components ?? [],
                      })
                    }
                  >
                    Ask again
                  </button>
                )}
              </div>
            );
          })()}
        </div>
        </div>
        {!atBottom && chat && (
          <button type="button" className="btn jumplatest" onClick={() => ((stick.current = true), setAtBottom(true), toBottom(true))}>
            <Icon name="down" small />
            Jump to latest
          </button>
        )}
        {chat && !thread && <StoryFlowBar stories={chatStories(chat)} />}
        {chat && !readOnly && (
          <div className="composerwrap">
            <Composer
              key={chat.id}
              onSubmit={send}
              initialAgent={chat.agent}
              initialScope={chat.scope}
              busy={isAnswering(chat)}
              onStop={() => stopAnswer(chat.id)}
            />
          </div>
        )}
        {chat && readOnly && (
          <div className="composerwrap">
            <p className="callout" role="status">
              <Icon name="lock" small />
              <span>Started by {starter}. You can read this chat; only they can add to it.</span>
            </p>
          </div>
        )}
      </div>
      <Outlet />
    </div>
  );
}

/** Loading, missing, denied and failed are told apart, and nothing from another application is shown. */
function ChatState({ load, onRetry }: { load: ChatLoad | undefined; onRetry: () => void }) {
  switch (load?.state) {
    case 'missing':
      return (
        <section className="emptystate" role="status" aria-label="Chat not found">
          <b>This chat doesn't exist in this application</b>
          <span>Check the link, or switch to the application it belongs to with the switcher in the sidebar.</span>
          <Link to="/" className="btn">
            Back to home
          </Link>
        </section>
      );
    case 'denied':
      return (
        <section className="emptystate" role="status" aria-label="No access">
          <b>You don't have access to this chat</b>
          <span>{load.error}</span>
          <Link to="/" className="btn">
            Back to home
          </Link>
        </section>
      );
    case 'error':
      return (
        <section className="emptystate" role="alert" aria-label="Could not load the chat">
          <b>Could not load this chat</b>
          <span>{load.error}</span>
          <button type="button" className="btn" onClick={onRetry}>
            <Icon name="retry" small />
            Try again
          </button>
        </section>
      );
    default:
      return (
        <p className="muted" aria-busy="true">
          Loading this chat…
        </p>
      );
  }
}

type Row = { kind: 'message'; m: Message } | { kind: 'event'; key: string; e: FlowView['events'][number] };

/**
 * Messages with the flow's events between them, by time. Events older than the first loaded message
 * stay out while older messages are still to load.
 */
function interleave(messages: Message[], events: FlowView['events'], olderToLoad: boolean): Row[] {
  const evs = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const first = messages.find((m) => m.at)?.at;
  let i = olderToLoad && first ? evs.findIndex((e) => e.at >= first) : 0;
  if (i < 0) i = evs.length;
  const out: Row[] = [];
  for (const m of messages) {
    // A message sent just now has no server time yet: everything recorded so far comes before it.
    const at = m.at ?? '\uffff';
    while (i < evs.length && evs[i].at <= at) out.push({ kind: 'event', key: `e${i}`, e: evs[i++] });
    out.push({ kind: 'message', m });
  }
  while (i < evs.length) out.push({ kind: 'event', key: `e${i}`, e: evs[i++] });
  return out;
}

/** The flow behind a team thread, refreshed with the thread so teammates' messages and new events appear. */
function useThreadFlow(flowId: string | null, chatId: string, answering: boolean) {
  const [flow, setFlow] = useState<FlowView | null>(null);
  useEffect(() => {
    if (!flowId) return;
    const epoch = sessionEpoch();
    let live = true;
    const load = () => {
      api<{ flow: FlowView }>(`/api/flows/${flowId}`)
        .then((d) => live && epoch === sessionEpoch() && setFlow(d.flow))
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(() => {
      load();
      // Other people write here too: read the latest page again, unless an answer is streaming in.
      if (!answering) void loadChat(chatId, true);
    }, 10_000);
    window.addEventListener('flows:changed', load);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('flows:changed', load);
    };
  }, [flowId, chatId, answering]);
  return flow;
}

/** The stories a chat is about: the ones its questions name and the ones its UAT reports cover. */
function chatStories(chat: NonNullable<ReturnType<typeof useChat>>): string[] {
  const keys = chat.messages.flatMap((m) => (m.role === 'user' ? (m.tickets ?? []) : []));
  for (const a of Object.values(chat.artifacts)) if (a.kind === 'uat') keys.push(a.ticketKey);
  return [...new Set(keys)].slice(0, 10);
}
