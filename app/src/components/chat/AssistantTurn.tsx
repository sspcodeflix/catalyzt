import { flowsChanged } from '../../lib/flows';
import { FlowChatCard, FlowReviewHandoff, FlowsWaitingCard, FlowStartCard } from './FlowCards';
import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { approvalBlockReason } from '../../lib/approvalRights';
import { canRetry, decideApproval, rateAnswer, retryAnswer, type FeedbackPattern } from '../../lib/chatStore';
import { domainInfo, raiseFromChat, type HuddleDomain } from '../../lib/huddleData';
import { useSession } from '../../lib/session';
import { useTickets } from '../../lib/ticketStore';
import { STALE_TEXT, staleTestFacts } from '../../lib/staleAnswer';
import type { AssistantMessage, Chat } from '../../lib/types';
import { BrandMark } from '../BrandMark';
import { Icon } from '../Icon';
import { ApprovalCard } from './ApprovalCard';
import { ArtifactCard } from './ArtifactCard';
import { FeedbackForm } from './FeedbackForm';
import { Prose } from './Prose';
import { RunSummary } from './RunSummary';
import { StarRating } from './StarRating';

interface AssistantTurnProps {
  chat: Chat;
  message: AssistantMessage;
  onFollowUp: (text: string) => void;
  /** Sends the question this answer replied to again (R04); absent when it cannot be resent here. */
  onAskAgain?: () => void;
}

/** Prose first, then the card, then the rating, approvals and follow-up suggestions. */
export function AssistantTurn({ chat, message, onFollowUp, onAskAgain }: AssistantTurnProps) {
  const [copied, setCopied] = useState(false);
  // A rating below 4 stars waits for the feedback form before it is sent.
  const [pendingStars, setPendingStars] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [rateError, setRateError] = useState<string | null>(null);
  const [patterns, setPatterns] = useState<FeedbackPattern[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [decideErrors, setDecideErrors] = useState<Record<string, string>>({});
  const session = useSession();
  const tickets = useTickets();
  // "Raise with the team": a Concern in Huddle with the question, the answer's opening and its sources.
  const [raising, setRaising] = useState(false);
  const [raiseTitle, setRaiseTitle] = useState('');
  const [raiseNote, setRaiseNote] = useState('');
  const [raiseBusy, setRaiseBusy] = useState(false);
  const [raiseError, setRaiseError] = useState<string | null>(null);
  const [raised, setRaised] = useState<{ id: string; title: string; already: boolean } | null>(null);
  const raiseTitleId = useId();
  const raiseNoteId = useId();

  const status = message.status ?? 'done';
  const live = status === 'working' || status === 'streaming';
  const finished = status === 'done';
  const proseText = message.blocks.flatMap((b) => (b.kind === 'prose' ? [b.text] : [])).join('\n\n');
  const stale = staleTestFacts(message);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(proseText.replace(/`/g, '').replace(/\s?\[\d+\]/g, ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: nothing to do */
    }
  };

  const submitRating = async (stars: number, feedback?: { reasons: string[]; comment: string }) => {
    setSaving(true);
    setRateError(null);
    try {
      const r = await rateAnswer(chat.id, message.id, stars, feedback);
      setPatterns(r.patterns);
      setPendingStars(null);
    } catch (e) {
      setRateError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const onRate = (stars: number) => {
    if (stars >= 4) void submitRating(stars);
    else {
      setPendingStars(stars);
      setRateError(null);
    }
  };

  const at = chat.messages.findIndex((m) => m.id === message.id);
  const question = at > 0 ? [...chat.messages.slice(0, at)].reverse().find((m) => m.role === 'user') : undefined;
  const questionText = question && question.role === 'user' ? question.text : '';
  const raiseDomain: HuddleDomain = message.capability === 'cloudops' ? 'reliability' : message.capability === 'security' ? 'security' : 'testing';
  const openRaise = () => {
    setRaiseTitle(questionText.slice(0, 160));
    setRaiseError(null);
    setRaising(true);
  };
  const submitRaise = async (e: FormEvent) => {
    e.preventDefault();
    if (!raiseTitle.trim()) return;
    setRaiseBusy(true);
    setRaiseError(null);
    try {
      const r = await raiseFromChat({ chatId: chat.id, messageId: message.id, title: raiseTitle, note: raiseNote });
      setRaised({ id: r.item.id, title: r.item.title, already: r.already });
      setRaising(false);
      setRaiseNote('');
    } catch (err) {
      setRaiseError((err as Error).message);
    } finally {
      setRaiseBusy(false);
    }
  };

  const decide = async (approvalId: string, decision: 'approved' | 'declined') => {
    setDeciding(approvalId);
    try {
      await decideApproval(chat.id, message.id, approvalId, decision);
      setDecideErrors(({ [approvalId]: _gone, ...rest }) => rest);
      // A test flow holding the story moves on: let its bar and cards reload now.
      flowsChanged();
    } catch (e) {
      setDecideErrors((x) => ({ ...x, [approvalId]: (e as Error).message }));
    } finally {
      setDeciding(null);
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
      case 'approval': {
        const a = b.approval;
        // The components the change touches, from the story of the report it came from (null when not loaded).
        const report = a.artifactId ? chat.artifacts[a.artifactId] : undefined;
        const story = report?.kind === 'uat' ? tickets.find((t) => t.key === report.ticketKey) : undefined;
        const rights = approvalBlockReason(session.me?.app, session.userId, story ? story.components : null);
        const lockReason = !a.id ? 'Waiting for the answer to be saved' : rights ?? (message.rating === null ? 'Rate the answer to approve' : null);
        return (
          <FlowReviewHandoff key={i} storyKey={a.action === 'add_uat_cases' ? (story?.key ?? (report?.kind === 'uat' ? report.ticketKey : null)) : null} pending={a.status === 'pending'}>
          <ApprovalCard
            approval={a}
            revision={message.revision}
            lockReason={lockReason}
            busy={deciding === a.id}
            error={a.id ? decideErrors[a.id] : undefined}
            onDecide={(d) => {
              if (a.id) void decide(a.id, d);
            }}
          />
          </FlowReviewHandoff>
        );
      }
      case 'flow':
        return <FlowChatCard key={i} flowId={b.flowId} />;
      case 'flow_start':
        return <FlowStartCard key={i} block={b} revisionId={message.revisionId} />;
      case 'flows_waiting':
        return <FlowsWaitingCard key={i} />;
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

  const ratingText = saving ? 'Saving…' : message.rating ? `Rated ${message.rating} of 5` : !message.revisionId ? 'Not saved, so it cannot be rated' : 'Rate this answer';

  return (
    <div className="turn">
      <div style={{ paddingTop: 4 }}>
        <BrandMark size={20} />
      </div>
      <div className="content">
        {before.map(renderBlock)}
        {stale && (
          <div className="callout stalenote" role="note" aria-label="These test facts may be out of date">
            <Icon name="warn" small />
            <span>
              {STALE_TEXT[stale]}
              {onAskAgain && (
                <>
                  {' '}
                  <button type="button" className="linkbtn" onClick={onAskAgain}>
                    Ask again
                  </button>
                </>
              )}
            </span>
          </div>
        )}
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
              title={canRetry(message.id) ? 'Run this again as a new revision' : 'This answer cannot be retried here'}
              disabled={!canRetry(message.id)}
              onClick={() => retryAnswer(chat.id, message.id)}
            >
              <Icon name="retry" small />
            </button>
            {finished && message.revisionId && (
              <button type="button" className="icon" aria-label="Raise with the team" title="Raise with the team: a concern in Huddle with this question, the answer and its sources" aria-expanded={raising} onClick={() => (raising ? setRaising(false) : openRaise())}>
                <Icon name="people" small />
              </button>
            )}
            {finished && (
              <>
                <StarRating value={pendingStars ?? message.rating} onRate={onRate} disabled={saving || !message.revisionId} />
                <span aria-live="polite">{ratingText}</span>
                {rateError && pendingStars === null && (
                  <span className="errtext" role="alert">
                    {rateError}
                  </span>
                )}
              </>
            )}
            {message.revision > 1 && <span className="muted rev">Revision {message.revision}</span>}
            {message.intent && (
              <span className="muted rev" title={`Confidence ${Math.round(message.intent.confidence * 100)}%: how sure the router was about what you asked, not whether the answer is right`}>
                Routed by {message.intent.source === 'model' ? 'DeepSeek' : 'rules'}
              </span>
            )}
          </div>
        )}
        {raising && (
          <form className="raiseform" onSubmit={(e) => void submitRaise(e)} aria-label="Raise with the team">
            <span className="muted">
              A concern in Huddle · {domainInfo[raiseDomain].label}, decided by {domainInfo[raiseDomain].decider}. It carries the question, the answer's opening and its sources, and links this chat.
            </span>
            <label htmlFor={raiseTitleId}>
              Title
              <input id={raiseTitleId} value={raiseTitle} onChange={(e) => setRaiseTitle(e.target.value)} maxLength={200} required />
            </label>
            <label htmlFor={raiseNoteId}>
              Note for the team (optional)
              <textarea id={raiseNoteId} rows={2} value={raiseNote} onChange={(e) => setRaiseNote(e.target.value)} maxLength={1500} placeholder="What you are unsure about" />
            </label>
            {raiseError && (
              <span className="errtext" role="alert">
                {raiseError}
              </span>
            )}
            <div className="acts">
              <button type="button" className="btn plain" onClick={() => setRaising(false)} disabled={raiseBusy}>
                Cancel
              </button>
              <button type="submit" className="btn ink" disabled={!raiseTitle.trim() || raiseBusy} aria-busy={raiseBusy}>
                {raiseBusy ? 'Raising…' : 'Raise concern'}
              </button>
            </div>
          </form>
        )}
        {raised && !raising && (
          <p className="callout raised" role="status">
            <Icon name="people" small />
            <span>
              {raised.already ? 'Already raised with the team: ' : 'Raised with the team: '}
              <Link to={`/huddle/${raised.id}`}>{raised.title}</Link>
            </span>
          </p>
        )}
        {pendingStars !== null && (
          <FeedbackForm stars={pendingStars} capability={message.capability} busy={saving} error={rateError} onSubmit={(reasons, comment) => void submitRating(pendingStars, { reasons, comment })} onCancel={() => setPendingStars(null)} />
        )}
        {patterns.length > 0 && (
          <p className="callout" role="status">
            <Icon name="people" small />
            <span>
              Others gave the same reason recently: {patterns.map((p) => `${p.reason} (${p.count} in 7 days)`).join(', ')}.
            </span>
          </p>
        )}
        {!live && after.map(renderBlock)}
      </div>
    </div>
  );
}
