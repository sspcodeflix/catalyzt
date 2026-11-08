import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Prose } from '../components/chat/Prose';
import { Icon } from '../components/Icon';
import { addComment, decide, fetchItem, kindInfo, markNeedsInput, me, useHuddleItem, vote } from '../lib/huddleData';
import { reasonFavoursOther } from '../lib/huddleReason';
import { useSession } from '../lib/session';
import { itemStatus } from './Huddle';
import { relTime } from './Tickets';

/** One Huddle decision: Catalyzt's cited summary, options with votes, discussion, and the owner's decision. */
export function HuddleItemPanel() {
  // Remount per item so drafts and the decide form never carry over.
  const { itemId } = useParams();
  return <ItemPanel key={itemId} itemId={itemId} />;
}

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${relTime(iso)} (${d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })})`;
};

function ItemPanel({ itemId }: { itemId: string | undefined }) {
  // The full item (discussion, cited summary) is read when it opens; the list holds summaries only.
  const item = useHuddleItem(itemId);
  const { loaded: sessionLoaded } = useSession();
  const ref = useRef<HTMLElement>(null);
  const [lookup, setLookup] = useState<'idle' | 'loading' | 'ready' | 'missing' | 'error'>('idle');
  const [draft, setDraft] = useState('');
  const [deciding, setDeciding] = useState(false);
  const [choice, setChoice] = useState<string>('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const commentId = useId();
  const reasonId = useId();
  const voteName = useId();
  const decideName = useId();

  // Read the item from the server when it opens (a click in the list, a deep link, a reload), so votes
  // and comments are current.
  useEffect(() => {
    if (!itemId || !sessionLoaded || lookup !== 'idle') return;
    setLookup('loading');
    fetchItem(itemId).then(
      (i) => setLookup(i ? 'ready' : 'missing'),
      () => setLookup('error'),
    );
  }, [itemId, sessionLoaded, lookup]);

  useEffect(() => {
    if (window.matchMedia('(max-width: 899px)').matches) ref.current?.scrollIntoView({ block: 'start' });
  }, [itemId]);

  const close = (
    <Link to="/huddle" className="icon" aria-label="Close panel">
      <Icon name="close" />
    </Link>
  );

  if (!item) {
    const missing = lookup === 'missing' || lookup === 'error';
    return (
      <section ref={ref} className="panel" aria-label={missing ? 'Not found' : 'Loading'} aria-busy={!missing}>
        <div className="phead">
          <div className="t">
            <b>{lookup === 'error' ? 'Could not load this decision' : missing ? 'Not found' : 'Loading…'}</b>
            <span>{missing ? "This decision doesn't exist in this application." : ''}</span>
          </div>
          {close}
        </div>
      </section>
    );
  }

  const st = itemStatus(item);
  const myVote = item.myVote;
  const leading = [...item.options].sort((a, b) => b.votes.length - a.votes.length)[0];
  const decidedOption = item.decision && item.options.find((o) => o.id === item.decision!.optionId);
  // R16: a warning, never a block, when the reason seems to argue for another option.
  const favoured = deciding ? reasonFavoursOther(reason, item.options, choice) : null;

  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const post = (e?: FormEvent) => {
    e?.preventDefault();
    if (!draft.trim()) return;
    void run('comment', async () => {
      await addComment(item.id, draft);
      setDraft('');
    });
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
    void run('decide', async () => {
      await decide(item.id, choice, reason);
      setDeciding(false);
    });
  };

  return (
    <section ref={ref} className="panel" aria-label={item.title}>
      <div className="phead">
        <div className="t">
          <b>{item.title}</b>
          <span>
            {kindInfo[item.kind].label} · {item.scope} · raised by {item.raisedBy} {relTime(item.raisedAt)}
          </span>
        </div>
        {close}
      </div>

      <div className="pbody" style={{ gap: 18 }}>
        <div>
          <span className={`pill ${st.tone}`}>{st.label}</span>
        </div>

        {error && (
          <p className="errtext" role="alert">
            {error}
          </p>
        )}

        {item.decision && decidedOption && (
          <div className="decision" role="status">
            <Icon name="check" small />
            <div>
              <b>Decided: {decidedOption.title}</b>
              <span>
                {item.decision.by} · {when(item.decision.at)}. Reason: {item.decision.reason}
              </span>
              <span className="muted">Kept with every affected item. {item.kind === 'conflict' ? 'Applied to App Context.' : ''}</span>
            </div>
          </div>
        )}

        <div className="aisum">
          <span className="lbl">
            <Icon name="auto" small />
            {item.raisedByType === 'agent' ? 'Summary by Catalyzt · cited' : 'Summary · cited'}
          </span>
          <Prose text={item.aiSummary} citations={item.citations} />
        </div>

        {item.similar.length > 0 && !item.decision && (
          <p className="callout" role="note">
            <Icon name="warn" small />
            <span>
              Possibly the same decision as{' '}
              {item.similar.map((s, n) => (
                <span key={s.id}>
                  {n > 0 ? ', ' : ''}
                  <Link to={`/huddle/${s.id}`}>{s.title}</Link>
                </span>
              ))}
              . Nothing is merged; decide each, or ask the team which one stands.
            </span>
          </p>
        )}

        {item.affects.length > 0 && (
          <div className="block">
            <span className="blockhead">Affects</span>
            <div className="chips">
              {item.affects.map((a) =>
                a.href ? (
                  <Link key={`${a.label}${a.href}`} to={a.href} className="pill">
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
        )}

        <fieldset className="block options" disabled={!!item.decision || busy === 'vote'}>
          <legend className="blockhead">Options {item.decision ? '' : '· your vote'}</legend>
          {item.options.map((o) => (
            <label key={o.id} className={`option${myVote === o.id || decidedOption?.id === o.id ? ' on' : ''}`}>
              <input type="radio" name={voteName} value={o.id} checked={myVote === o.id} onChange={() => void run('vote', () => vote(item.id, o.id))} />
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
                <time dateTime={c.at}>{relTime(c.at)}</time>
                <p>{c.text}</p>
              </div>
            </div>
          ))}
          <form onSubmit={post} className="replyform">
            <label htmlFor={commentId} className="sr">
              Reply
            </label>
            <textarea id={commentId} rows={2} placeholder="Reply" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onCommentKey} disabled={busy === 'comment'} />
            <button type="submit" className="btn" disabled={!draft.trim() || busy === 'comment'} aria-busy={busy === 'comment'}>
              {busy === 'comment' ? 'Posting…' : 'Post'}
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
                    <button type="button" className="btn plain" disabled={item.needsInput || busy === 'input'} onClick={() => void run('input', () => markNeedsInput(item.id))}>
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
                <textarea id={reasonId} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required aria-describedby={favoured ? `${reasonId}-warn` : undefined} />
                {favoured && (
                  <p id={`${reasonId}-warn`} className="callout reasonwarn" role="status">
                    <Icon name="warn" small />
                    <span>
                      Your reason reads like an argument for "{favoured.title}", not for the option you chose. Check the choice before you confirm; you can still confirm as it is.
                    </span>
                  </p>
                )}
                <div className="acts">
                  <button type="button" className="btn plain" onClick={() => setDeciding(false)} disabled={busy === 'decide'}>
                    Cancel
                  </button>
                  <button type="submit" className="btn ink" disabled={!reason.trim() || busy === 'decide'} aria-busy={busy === 'decide'}>
                    {busy === 'decide' ? 'Recording…' : 'Confirm decision'}
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
