import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import { Icon } from '../components/Icon';
import { startUatChat } from '../lib/chatStore';
import { currentScope } from '../lib/session';
import { fetchStory, getTicket, useTickets } from '../lib/ticketStore';
import { relTime, uatPill, uatText } from './Tickets';

/** One Jira story in the side panel, with the action to analyse it for UAT. */
export function TicketPanel() {
  const { ticketKey } = useParams();
  const all = useTickets(); // re-render when the list or a story's UAT state changes
  const t = ticketKey ? getTicket(ticketKey) : undefined;
  const navigate = useNavigate();
  const ref = useRef<HTMLElement>(null);
  const state = useLocation().state as { created?: boolean; visible?: boolean } | null;
  const [lookup, setLookup] = useState<'idle' | 'loading' | 'missing'>('idle');

  // A story the filter hides (or one just created) is fetched directly.
  useEffect(() => {
    if (!ticketKey || t || !all) return;
    setLookup('loading');
    void fetchStory(ticketKey).then((s) => setLookup(s ? 'idle' : 'missing'));
  }, [ticketKey, t, all]);

  useEffect(() => {
    if (window.matchMedia('(max-width: 899px)').matches) ref.current?.scrollIntoView({ block: 'start' });
  }, [ticketKey]);

  const close = (
    <Link to="/tickets" className="icon" aria-label="Close panel">
      <Icon name="close" />
    </Link>
  );

  if (!t && lookup !== 'missing') {
    return (
      <section ref={ref} className="panel" aria-label="Loading story" aria-busy="true">
        <div className="phead">
          <div className="t">
            <b>{ticketKey}</b>
            <span>Loading…</span>
          </div>
          {close}
        </div>
      </section>
    );
  }

  if (!t) {
    return (
      <section ref={ref} className="panel" aria-label="Ticket not found">
        <div className="phead">
          <div className="t">
            <b>{ticketKey} does not exist</b>
            <span>Check the key, or that you have access to the project in Jira.</span>
          </div>
          {close}
        </div>
      </section>
    );
  }

  const analyse = () => {
    const scope = currentScope();
    if (!scope) return;
    const id = t.uat.chatId ?? startUatChat(t.key, scope);
    navigate(`/chat/${id}/artifact/uat-${t.key.toLowerCase()}`);
  };

  return (
    <section ref={ref} className="panel" aria-label={`${t.key} ${t.summary}`}>
      <div className="phead">
        <div className="t">
          <b>
            <span className="mono">{t.key}</span> · {t.summary}
          </b>
          <span>
            {t.type} · {t.status} · {t.fixVersion} · {t.assignee} · updated {relTime(t.updated)}
          </span>
        </div>
        {close}
      </div>
      <div className="pbody" style={{ gap: 22 }}>
        {state?.created && (
          <p className="callout" role="status">
            <Icon name="check" small />
            <span>
              Created {t.key}.{' '}
              {state.visible === false ? 'Its status is outside the Jira filter, so it is not in the list until the filter includes it.' : ''}
            </span>
          </p>
        )}
        {!all.some((x) => x.key === t.key) && !state?.created && (
          <p className="callout" role="status">
            <Icon name="filter" small />
            <span>This story's status ({t.status}) is outside the Jira filter, so it is not in the list.</span>
          </p>
        )}
        <div className="ticketact">
          <span className={`pill ${uatPill[t.uat.state].cls}`}>UAT: {uatText(t)}</span>
          <span className="grow" />
          <button type="button" className="btn ink" onClick={analyse}>
            <Icon name="target" small />
            {t.uat.chatId ? 'Open UAT analysis' : 'Analyse for UAT'}
          </button>
        </div>

        <p className="prose" style={{ margin: 0 }}>
          {t.description}
        </p>

        <div>
          <div className="sechead">
            <h3>Acceptance criteria</h3>
            <span>{t.acceptanceCriteria.length} from Jira</span>
          </div>
          <ol className="aclist">
            {t.acceptanceCriteria.map((c, i) => (
              <li key={i}>
                <span className="mono muted">AC{i + 1}</span>
                {c}
              </li>
            ))}
          </ol>
        </div>

        {t.original && (
          <details className="original">
            <summary>What the author wrote before refining</summary>
            <p className="rc-sum">{t.original.summary}</p>
            {t.original.description && <p className="muted">{t.original.description}</p>}
            <pre className="mono">{t.original.acceptanceCriteria}</pre>
          </details>
        )}

        <dl className="facts">
          <div>
            <dt>Requirements</dt>
            <dd className="mono">{t.requirements.join(', ') || 'None linked yet'}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{t.source === 'horizon' ? `Created in Catalyzt${t.refinementId ? ', refined with AI' : ''}` : 'Synced from Jira'}</dd>
          </div>
          <div>
            <dt>Components</dt>
            <dd className="mono">{t.components.join(', ') || 'None'}</dd>
          </div>
        </dl>

        <div className="callout">
          <Icon name="lock" small />
          <span>
            Read from Jira with a read-only service account. Catalyzt only writes to this ticket after you approve,
            for example to add UAT test cases.
          </span>
        </div>
      </div>
    </section>
  );
}
