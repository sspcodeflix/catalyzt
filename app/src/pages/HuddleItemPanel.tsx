import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { Prose } from '../components/chat/Prose';
import { Icon } from '../components/Icon';
import { addComment, decide, kindInfo, markNeedsInput, me, useHuddle, vote } from '../lib/huddleData';
import { itemStatus } from './Huddle';

/** One Huddle decision: Horizon's cited summary, options with votes, discussion, and the owner's decision. */
export function HuddleItemPanel() {
  // Remount per item so drafts and the decide form never carry over.
  const { itemId } = useParams();
  return <ItemPanel key={itemId} itemId={itemId} />;
}

function ItemPanel({ itemId }: { itemId: string | undefined }) {
  const items = useHuddle();
  const item = items.find((i) => i.id === itemId);
  const navigate = useNavigate();
  const ref = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState('');
  const [deciding, setDeciding] = useState(false);
  const [choice, setChoice] = useState<string>('');
  const [reason, setReason] = useState('');
  const commentId = useId();
  const reasonId = useId();
  const voteName = useId();
  const decideName = useId();

  useEffect(() => {
    if (window.matchMedia('(max-width: 899px)').matches) ref.current?.scrollIntoView({ block: 'start' });
  }, [itemId]);

  const close = (
    <Link to="/huddle" className="icon" aria-label="Close panel">
      <Icon name="close" />
    </Link>
  );

  if (!item) {
    return (
      <section ref={ref} className="panel" aria-label="Not found">
        <div className="phead">
          <div className="t">
            <b>Not found</b>
            <span>This decision doesn't exist or you don't have access.</span>
          </div>
          {close}
        </div>
      </section>
    );
  }

  const st = itemStatus(item);
  const myVote = item.options.find((o) => o.votes.includes(me.initials))?.id;
  const leading = [...item.options].sort((a, b) => b.votes.length - a.votes.length)[0];
  const decidedOption = item.decision && item.options.find((o) => o.id === item.decision!.optionId);

  const post = (e?: FormEvent) => {
    e?.preventDefault();
    addComment(item.id, draft);
    setDraft('');
  };
  const onCommentKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) post();
  };

  const startDecide = () => {
    setChoice(myVote ?? leading.id);
    setDeciding(true);
  };
  const confirmDecide = (e: FormEvent) => {
    e.preventDefault();
    if (!choice || !reason.trim()) return;
    decide(item.id, choice, reason);
    setDeciding(false);
  };

  return (
    <section ref={ref} className="panel" aria-label={item.title}>
      <div className="phead">
        <div className="t">
          <b>{item.title}</b>
          <span>
            {kindInfo[item.kind].label} · {item.scope} · raised by {item.raisedBy} {item.raisedAt}
          </span>
        </div>
        {/* TODO: open a chat scoped to this item (item chip in the composer). */}
        <button type="button" className="ghost" aria-label="Ask about this" onClick={() => navigate('/')}>
          <Icon name="chat" small />
          <span className="hidem">Ask about this</span>
        </button>
        {close}
      </div>

      <div className="pbody" style={{ gap: 18 }}>
        <div>
          <span className={`pill ${st.tone}`}>{st.label}</span>
        </div>

        {item.decision && decidedOption && (
          <div className="decision" role="status">
            <Icon name="check" small />
            <div>
              <b>Decided: {decidedOption.title}</b>
              <span>
                {item.decision.by} · {item.decision.at}. Reason: {item.decision.reason}
              </span>
              <span className="muted">Kept with every affected item. Horizon applies it.</span>
            </div>
          </div>
        )}

        <div className="aisum">
          <span className="lbl">
            <Icon name="auto" small />
            Summary by Horizon · both sides, cited
          </span>
          <Prose text={item.aiSummary} citations={item.citations} />
        </div>

        <div className="block">
          <span className="blockhead">Affects</span>
          <div className="chips">
            {item.affects.map((a) =>
              a.href ? (
                <Link key={a.label} to={a.href} className="pill">
                  {a.label}
                </Link>
              ) : (
                <span key={a.label} className="pill">
                  {a.label}
                </span>
              ),
            )}
          </div>
        </div>

        <fieldset className="block options" disabled={!!item.decision}>
          <legend className="blockhead">Options {item.decision ? '' : '· your vote'}</legend>
          {item.options.map((o) => (
            <label key={o.id} className={`option${myVote === o.id || decidedOption?.id === o.id ? ' on' : ''}`}>
              <input
                type="radio"
                name={voteName}
                value={o.id}
                checked={myVote === o.id}
                onChange={() => vote(item.id, o.id)}
              />
              <div>
                <b>{o.title}</b>
                <span className="muted">{o.detail}</span>
              </div>
              <span className="votes">
                {o.votes.length} {o.votes.length === 1 ? 'vote' : 'votes'}
              </span>
            </label>
          ))}
          <span className="muted" style={{ fontSize: 12.5 }}>
            Votes are advisory. An app owner decides.
          </span>
        </fieldset>

        <div className="block" style={{ gap: 14 }}>
          <span className="blockhead">Discussion</span>
          {item.comments.length === 0 && <span className="muted">No comments yet.</span>}
          {item.comments.map((c) => (
            <div key={c.id} className="comment">
              <span className="avatar" aria-hidden="true">
                {c.who.initials}
              </span>
              <div>
                <b>{c.who.name}</b>
                <time>{c.at}</time>
                <p>{c.text}</p>
              </div>
            </div>
          ))}
          <form onSubmit={post} className="replyform">
            <label htmlFor={commentId} className="sr">
              Reply
            </label>
            <textarea
              id={commentId}
              rows={2}
              placeholder="Reply, or @mention someone"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onCommentKey}
            />
            <button type="submit" className="btn" disabled={!draft.trim()}>
              Post
            </button>
          </form>
        </div>

        {!item.decision && (
          <div className="card decidebox">
            {!deciding ? (
              <div className="foot">
                <span className="lockline">
                  <Icon name="lock" small />
                  Decided by an app owner. The decision and its reason are kept with every affected item.
                </span>
                {me.role === 'owner' && (
                  <div className="acts">
                    <button type="button" className="btn plain" disabled={item.needsInput} onClick={() => markNeedsInput(item.id)}>
                      {item.needsInput ? 'Asked for more input' : 'Needs more input'}
                    </button>
                    <button type="button" className="btn ink" onClick={startDecide}>
                      Decide
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <form onSubmit={confirmDecide} className="decideform">
                <fieldset>
                  <legend className="blockhead">Your decision</legend>
                  {item.options.map((o) => (
                    <label key={o.id} className="radio">
                      <input type="radio" name={decideName} value={o.id} checked={choice === o.id} onChange={() => setChoice(o.id)} />
                      {o.title}
                    </label>
                  ))}
                </fieldset>
                <label htmlFor={reasonId} className="blockhead">
                  Reason <span className="muted">(required, kept with every affected item)</span>
                </label>
                <textarea id={reasonId} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required />
                <div className="acts">
                  <button type="button" className="btn plain" onClick={() => setDeciding(false)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn ink" disabled={!reason.trim()}>
                    Confirm decision
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
