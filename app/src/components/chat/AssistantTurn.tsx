import { useState } from 'react';

import { canRetry, decideApproval, rateAnswer, retryAnswer } from '../../lib/chatStore';
import type { AssistantMessage, Chat } from '../../lib/types';
import { HorizonMark } from '../HorizonMark';
import { Icon } from '../Icon';
import { ApprovalCard } from './ApprovalCard';
import { ArtifactCard } from './ArtifactCard';
import { Prose } from './Prose';
import { RunSummary } from './RunSummary';
import { StarRating } from './StarRating';

interface AssistantTurnProps {
  chat: Chat;
  message: AssistantMessage;
  onFollowUp: (text: string) => void;
}

/** Prose first, then the card, then the rating, approvals and follow-up suggestions. */
export function AssistantTurn({ chat, message, onFollowUp }: AssistantTurnProps) {
  const [copied, setCopied] = useState(false);
  const status = message.status ?? 'done';
  const live = status === 'working' || status === 'streaming';
  const finished = status === 'done';
  const proseText = message.blocks.flatMap((b) => (b.kind === 'prose' ? [b.text] : [])).join('\n\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(proseText.replace(/`/g, '').replace(/\s?\[\d+\]/g, ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: nothing to do */
    }
  };

  // Approvals and follow-ups come after the rating row, so the gate sits right above them.
  const before = message.blocks.filter((b) => b.kind !== 'approval' && b.kind !== 'followups');
  const after = message.blocks.filter((b) => b.kind === 'approval' || b.kind === 'followups');

  const renderBlock = (b: AssistantMessage['blocks'][number], i: number) => {
    switch (b.kind) {
      case 'run':
        return <RunSummary key={i} summary={b.summary} steps={b.steps} agents={b.agents} live={live} />;
      case 'prose':
        return <Prose key={i} text={b.text} citations={message.citations} streaming={status === 'streaming'} />;
      case 'artifact': {
        const a = chat.artifacts[b.artifactId];
        return a ? <ArtifactCard key={i} chatId={chat.id} artifact={a} /> : null;
      }
      case 'approval':
        return (
          <ApprovalCard
            key={i}
            approval={b.approval}
            locked={message.rating === null}
            onDecide={(d) => decideApproval(chat.id, message.id, d)}
          />
        );
      case 'rejected':
        return (
          <section key={i} className="rejected" role="alert" aria-label="Request rejected">
            <div className="rj-head">
              <Icon name="shield" small />
              <b>Rejected: {b.title}</b>
              <span className="muted">by the {b.by.toLowerCase()}</span>
            </div>
            <p>{b.text}</p>
          </section>
        );
      case 'followups':
        return (
          <div key={i} className="chips">
            {b.items.map((t) => (
              <button key={t} type="button" className="chip" onClick={() => onFollowUp(t)}>
                {t}
              </button>
            ))}
          </div>
        );
    }
  };

  return (
    <div className="turn">
      <div style={{ paddingTop: 2 }}>
        <HorizonMark size={24} />
      </div>
      <div className="content">
        {before.map(renderBlock)}
        {status === 'error' && (
          <div className="callout bad" role="alert">
            <Icon name="warn" small />
            <span>
              {message.error ?? 'The answer failed.'}
              {canRetry(message.id) && (
                <>
                  {' '}
                  <button type="button" className="linkbtn" onClick={() => retryAnswer(chat.id, message.id)}>
                    Try again
                  </button>
                </>
              )}
            </span>
          </div>
        )}
        {!live && (
          <div className="msgactions">
            <button type="button" className="icon" aria-label={copied ? 'Copied' : 'Copy answer'} onClick={copy} disabled={!proseText}>
              <Icon name={copied ? 'check' : 'copy'} small />
            </button>
            <button
              type="button"
              className="icon"
              aria-label="Retry"
              title={canRetry(message.id) ? 'Run this again as a new revision' : 'This answer cannot be retried'}
              disabled={!canRetry(message.id)}
              onClick={() => retryAnswer(chat.id, message.id)}
            >
              <Icon name="retry" small />
            </button>
            {finished && (
              <>
                <StarRating value={message.rating} onRate={(s) => rateAnswer(chat.id, message.id, s)} />
                <span aria-live="polite">{message.rating ? `Rated ${message.rating} of 5` : 'Rate this answer'}</span>
              </>
            )}
            {message.revision > 1 && <span className="muted rev">Revision {message.revision}</span>}
            {message.intent && (
              <span className="muted rev" title={`Confidence ${Math.round(message.intent.confidence * 100)}%`}>
                Routed by {message.intent.source === 'model' ? 'DeepSeek' : 'rules'}
              </span>
            )}
          </div>
        )}
        {!live && after.map(renderBlock)}
      </div>
    </div>
  );
}
