import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';

import { AssistantTurn } from '../components/chat/AssistantTurn';
import { Composer, type ComposerSubmit } from '../components/Composer';
import { Icon } from '../components/Icon';
import { createChat, isAnswering, loadChat, sendMessage, stopAnswer, useChat, useChatLoad, type ChatLoad } from '../lib/chatStore';
import { useSession } from '../lib/session';
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
  // Anything else (a reload, a deep link, a recent) comes from the server.
  useEffect(() => {
    if (!chat && !first && loaded) void loadChat(chatId);
  }, [chatId, chat, first, loaded]);

  const panelOpen = location.pathname.includes('/artifact/');
  const readOnly = !!chat?.createdBy && chat.createdBy !== userId;
  const starter = readOnly ? (me?.people.find((p) => p.id === chat?.createdBy)?.name ?? 'someone else') : null;

  // On a phone the report and the chat are tabs, not a stack; both stay mounted so scroll positions survive the switch.
  const [view, setView] = useState<'chat' | 'report'>('report');
  useEffect(() => {
    if (panelOpen) setView('report');
  }, [panelOpen, location.pathname]);

  const send = (msg: ComposerSubmit) => sendMessage(chatId, msg);

  return (
    <div className={`body${panelOpen ? ` split view-${view}` : ''}`}>
      {panelOpen && (
        <div className="mobiletabs segctl" role="tablist" aria-label="Chat or report">
          <button type="button" role="tab" aria-selected={view === 'chat'} className={view === 'chat' ? 'on' : undefined} onClick={() => setView('chat')}>
            Chat
          </button>
          <button type="button" role="tab" aria-selected={view === 'report'} className={view === 'report' ? 'on' : undefined} onClick={() => setView('report')}>
            Report
          </button>
        </div>
      )}
      <div className="chatcol">
        <div className="thread">
          {!chat && !first && <ChatState load={load} onRetry={() => void loadChat(chatId, true)} />}
          {chat?.messages.map((m) =>
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
                <div className="user">{m.text}</div>
              </Fragment>
            ) : (
              <AssistantTurn
                key={m.id}
                chat={chat}
                message={m}
                onFollowUp={(text) => {
                  // A follow-up keeps the chat's test type unless its own words say otherwise.
                  const d = detectTestType(text);
                  send({
                    text,
                    agent: chat.agent,
                    scope: chat.scope,
                    testType: d.type ?? chat.testType,
                    testTypeSource: d.type ? 'rules' : null,
                    tickets: d.tickets,
                    components: [],
                  });
                }}
              />
            ),
          )}
        </div>
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
