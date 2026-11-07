import { Fragment, useEffect, useRef } from 'react';
import { Link, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';

import { AssistantTurn } from '../components/chat/AssistantTurn';
import { Composer, type ComposerSubmit } from '../components/Composer';
import { createChat, isAnswering, sendMessage, stopAnswer, useChat } from '../lib/chatStore';
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

  // A new chat from the home page carries its first message in router state.
  useEffect(() => {
    if (first && !created.current) {
      created.current = true;
      createChat(chatId, first);
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [chatId, first, location.pathname, navigate]);

  const chat = useChat(chatId);
  const panelOpen = location.pathname.includes('/artifact/');

  const send = (msg: ComposerSubmit) => sendMessage(chatId, msg);

  return (
    <div className={`body${panelOpen ? ' split' : ''}`}>
      <div className="chatcol">
        <div className="thread">
          {!chat && !first && <p className="muted">This chat will load from the API once it is connected.</p>}
          {chat?.messages.map((m) =>
            m.role === 'user' ? (
              <Fragment key={m.id}>
                {Boolean(m.testType || m.tickets?.length || m.components?.length) && (
                  <div className="msgtags" aria-label="How Horizon read this request">
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
        {chat && (
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
      </div>
      <Outlet />
    </div>
  );
}
