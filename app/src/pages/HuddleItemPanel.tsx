import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Prose } from '../components/chat/Prose';
import { Icon } from '../components/Icon';
import { addAction, addComment, answerConcern, completeAction, decide, domainInfo, fetchItem, fetchPeople, kindInfo, markNeedsInput, useHuddleItem, vote, type HuddleItem, type HuddlePerson } from '../lib/huddleData';
import { reasonFavoursOther } from '../lib/huddleReason';
import { useSession } from '../lib/session';
import { itemStatus, shortDate } from './Huddle';
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
  const { loaded: sessionLoaded, me: session } = useSession();
  const ref = useRef<HTMLElement>(null);
  const [lookup, setLookup] = useState<'idle' | 'loading' | 'ready' | 'missing' | 'error'>('idle');
  const [draft, setDraft] = useState('');
  const [deciding, setDeciding] = useState(false);
  const [choice, setChoice] = useState<string>('');
  const [reason, setReason] = useState('');
  const [expiry, setExpiry] = useState('');
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const commentId = useId();
  const reasonId = useId();
  const voteName = useId();
  const decideName = useId();
  const answerId = useId();
  const expiryId = useId();

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
  const myId = session?.user.id;
  const canAnswer = item.kind === 'concern' && item.stage === 'open' && (item.canDecide || item.raisedBy === session?.user.name);
  const choiceAccepts = !!item.options.find((o) => o.id === choice)?.accepts;
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
    setExpiry(item.expiresAt && item.expiresAt > new Date().toISOString() ? item.expiresAt.slice(0, 10) : '');
    setDeciding(true);
  };
  const confirmDecide = (e: FormEvent) => {
    e.preventDefault();
    if (!choice || !reason.trim()) return;
    void run('decide', async () => {
      await decide(item.id, choice, reason, choiceAccepts ? expiry : undefined);
      setDeciding(false);
    });
  };
  const postAnswer = (e: FormEvent) => {
    e.preventDefault();
    if (!answer.trim()) return;
    void run('answer', async () => {
      await answerConcern(item.id, answer);
      setAnswer('');
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
        <div className="chips">
          <span className={`pill ${st.tone}`}>{st.label}</span>
          {item.overdue && <span className="pill crit">Overdue</span>}
          {item.waitingOnMe && <span className="pill info">Waiting on you</span>}
        </div>

        <dl className="facts">
          <div>
            <dt>Kind</dt>
            <dd>{kindInfo[item.kind].label}</dd>
          </div>
          <div>
            <dt>Domain</dt>
            <dd>{domainInfo[item.domain].label}</dd>
          </div>
          {item.severity && (
            <div>
              <dt>Severity</dt>
              <dd>{item.severity[0].toUpperCase() + item.severity.slice(1)}</dd>
            </div>
          )}
          {item.dueAt && (
            <div>
              <dt>Due</dt>
              <dd>{shortDate(item.dueAt)}</dd>
            </div>
          )}
          {item.expiresAt && (
            <div>
              <dt>{item.reopenNote && !item.decision ? 'Acceptance expired' : 'Acceptance ends'}</dt>
              <dd>{shortDate(item.expiresAt)}</dd>
            </div>
          )}
          <div>
            <dt>Decided by</dt>
            <dd>{domainInfo[item.domain].decider}</dd>
          </div>
        </dl>

        {item.reopenNote && !item.decision && (
          <p className="callout" role="note">
            <Icon name="warn" small />
            <span>{item.reopenNote}</span>
          </p>
        )}

        {item.answer && (
          <div className="answer" role="status">
            <b>Answered by {item.answer.by}</b>
            <span>{item.answer.text}</span>
            <span>{when(item.answer.at)}</span>
          </div>
        )}

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

        {item.links.length > 0 && (
          <div className="block">
            <span className="blockhead">Linked</span>
            <div className="chips">
              {item.links.map((l) =>
                l.href ? (
                  <Link key={`${l.type}:${l.ref}`} to={l.href} className="pill">
                    {linkLabel(l)}
                  </Link>
                ) : (
                  <span key={`${l.type}:${l.ref}`} className="pill">
                    {linkLabel(l)}
                  </span>
                ),
              )}
            </div>
          </div>
        )}

        {canAnswer && (
          <form className="block answerform" onSubmit={postAnswer}>
            <label htmlFor={answerId} className="blockhead">
              Answer this concern <span className="muted">(closes it; open actions stay to be done)</span>
            </label>
            <textarea id={answerId} rows={3} value={answer} onChange={(e) => setAnswer(e.target.value)} disabled={busy === 'answer'} />
            <div className="acts">
              <button type="submit" className="btn ink" disabled={!answer.trim() || busy === 'answer'} aria-busy={busy === 'answer'}>
                {busy === 'answer' ? 'Saving…' : 'Post answer'}
              </button>
            </div>
          </form>
        )}

        {item.options.length > 0 && (
        <fieldset className="block options" disabled={!!item.decision || item.stage !== 'open' || busy === 'vote'}>
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
            Votes are advisory. {domainInfo[item.domain].decider[0].toUpperCase() + domainInfo[item.domain].decider.slice(1)} decides.
          </span>
        </fieldset>
        )}

        <Actions item={item} myId={myId} run={run} busy={busy} />

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

        {!item.decision && item.stage === 'open' && item.options.length > 0 && (
          <div className="card decidebox">
            {!deciding ? (
              <div className="foot">
                <span className="lockline">
                  <Icon name="lock" small />
                  Decided by {domainInfo[item.domain].decider}. The decision and its reason are kept with every affected item.
                </span>
                {item.canDecide && (
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
                {choiceAccepts && (
                  <>
                    <label htmlFor={expiryId} className="blockhead">
                      Accepted until <span className="muted">(the item reopens on this date; empty keeps the default)</span>
                    </label>
                    <input id={expiryId} type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
                  </>
                )}
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

const LINK_LABEL: Record<string, string> = { story: 'Story', test: 'Test', run: 'Run', component: 'Component', chat: 'Chat', cve: 'CVE', deployment: 'Deployment' };
const linkLabel = (l: HuddleItem['links'][number]) => (l.type === 'cve' ? l.label : `${LINK_LABEL[l.type] ?? l.type}: ${l.label}`);

/** Follow-up actions: owner, due date, done. The item closes when every action of a decided item is done. */
function Actions({ item, myId, run, busy }: { item: HuddleItem; myId: string | undefined; run: (what: string, fn: () => Promise<unknown>) => Promise<boolean>; busy: string | null }) {
  const [adding, setAdding] = useState(false);
  const [people, setPeople] = useState<HuddlePerson[] | null>(null);
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState('');
  const [due, setDue] = useState('');
  const [link, setLink] = useState('');
  const ids = { title: useId(), owner: useId(), due: useId(), link: useId() };
  const closed = item.stage === 'closed';
  if (closed && item.actions.length === 0) return null;

  const open = () => {
    setAdding(true);
    setOwner(myId ?? '');
    if (!people) fetchPeople().then(setPeople, () => setPeople([]));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !owner) return;
    void run('action', async () => {
      await addAction(item.id, { title, ownerId: owner, dueAt: due || undefined, link: link.trim() || undefined });
      setTitle('');
      setDue('');
      setLink('');
      setAdding(false);
    });
  };

  return (
    <div className="block" style={{ gap: 10 }}>
      <span className="blockhead">Actions</span>
      {item.actions.length === 0 && <span className="muted">No actions yet. A decision usually creates some: open a PR, add a test, rotate a key.</span>}
      {item.actions.length > 0 && (
        <ul className="actionlist" aria-label="Actions">
          {item.actions.map((a) => (
            <li key={a.id} className={a.status === 'done' ? 'done' : undefined}>
              <span className="avatar" aria-hidden="true">
                {a.owner.initials}
              </span>
              <div>
                <b>{a.title}</b>
                <span className="muted">
                  {a.owner.name}
                  {a.dueAt ? ` · due ${shortDate(a.dueAt)}` : ''}
                  {a.status === 'done' ? ` · done${a.doneBy ? ` by ${a.doneBy}` : ''}` : ''}
                  {a.link && (
                    <>
                      {' · '}
                      {a.link.startsWith('/') ? <Link to={a.link}>link</Link> : <a href={a.link} target="_blank" rel="noreferrer">link</a>}
                    </>
                  )}
                </span>
                {a.overdue && <span className="pill crit">Overdue</span>}
                {a.status === 'open' && (
                  <button type="button" className="btn plain" style={{ marginTop: 6 }} disabled={busy === `done-${a.id}`} aria-busy={busy === `done-${a.id}`} onClick={() => void run(`done-${a.id}`, () => completeAction(item.id, a.id))}>
                    Mark done<span className="sr">: {a.title}</span>
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {!closed &&
        (adding ? (
          <form className="actionform" onSubmit={submit} aria-label="Add an action">
            <label htmlFor={ids.title}>
              What has to be done
              <input id={ids.title} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
            </label>
            <div className="row">
              <label htmlFor={ids.owner}>
                Owner
                <select id={ids.owner} value={owner} onChange={(e) => setOwner(e.target.value)} required>
                  {!people && <option value={owner}>Loading people…</option>}
                  {people?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor={ids.due}>
                Due
                <input id={ids.due} type="date" value={due} onChange={(e) => setDue(e.target.value)} />
              </label>
            </div>
            <label htmlFor={ids.link}>
              Link (optional)
              <input id={ids.link} value={link} onChange={(e) => setLink(e.target.value)} placeholder="/tickets/ABCD-1001 or https://…" />
            </label>
            <div className="acts">
              <button type="button" className="btn plain" onClick={() => setAdding(false)} disabled={busy === 'action'}>
                Cancel
              </button>
              <button type="submit" className="btn ink" disabled={!title.trim() || !owner || busy === 'action'} aria-busy={busy === 'action'}>
                {busy === 'action' ? 'Adding…' : 'Add action'}
              </button>
            </div>
          </form>
        ) : (
          <div>
            <button type="button" className="btn plain" onClick={open}>
              Add an action
            </button>
          </div>
        ))}
    </div>
  );
}
