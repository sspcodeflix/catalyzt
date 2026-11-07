import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Icon } from '../components/Icon';
import { useSession } from '../lib/session';
import { createStory, refineStory } from '../lib/ticketStore';
import { STORY_STATUSES, type Refined, type StoryDraft } from '../lib/types';

const EMPTY: StoryDraft = {
  summary: '',
  description: '',
  type: 'Story',
  status: 'Ready for UAT',
  fixVersion: '',
  components: [],
  acceptanceCriteria: '',
};

const lines = (t: string) => t.split('\n').map((l) => l.trim()).filter(Boolean);

/**
 * Creates a story in the dummy Jira (stored in SQLite on the server). People write as they
 * like; "Refine with AI" proposes a clearer version, and they choose to use it or keep theirs.
 * Both versions are kept. Route /tickets/new.
 */
export function StoryCreate() {
  const [draft, setDraft] = useState<StoryDraft>(EMPTY);
  const [refined, setRefined] = useState<Refined | null>(null);
  /** Set once a refinement is used: what the author wrote before it, and which refinement. */
  const [used, setUsed] = useState<{ original: { summary: string; description: string; acceptanceCriteria: string }; refinementId: number } | null>(null);
  const [busy, setBusy] = useState<'refine' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const ref = useRef<HTMLElement>(null);
  const allComponents = useSession().me?.app?.components.map((c) => c.name) ?? [];
  const ids = { summary: useId(), desc: useId(), ac: useId(), type: useId(), status: useId(), version: useId() };

  useEffect(() => {
    if (window.matchMedia('(max-width: 899px)').matches) ref.current?.scrollIntoView({ block: 'start' });
  }, []);

  const set = <K extends keyof StoryDraft>(k: K, v: StoryDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const canRefine = !!(draft.summary.trim() || draft.acceptanceCriteria.trim());
  const canSave = !!draft.summary.trim() && lines(draft.acceptanceCriteria).length > 0;

  const refine = async () => {
    setBusy('refine');
    setError(null);
    try {
      setRefined(await refineStory(draft));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const useRefined = () => {
    if (!refined) return;
    setUsed({ original: { summary: draft.summary, description: draft.description, acceptanceCriteria: draft.acceptanceCriteria }, refinementId: refined.refinementId });
    setDraft((d) => ({
      ...d,
      summary: refined.refined.summary,
      description: refined.refined.description || d.description,
      acceptanceCriteria: refined.refined.acceptanceCriteria.join('\n'),
    }));
    setRefined(null);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy('save');
    setError(null);
    try {
      const { story, visible } = await createStory({ ...draft, original: used?.original ?? null, refinementId: used?.refinementId ?? null });
      navigate(`/tickets/${story.key}`, { state: { created: true, visible } });
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };

  return (
    <section ref={ref} className="panel" aria-label="Create a Jira story">
      <div className="phead">
        <div className="t">
          <b>Create a Jira story</b>
          <span>Saved in Catalyzt's dummy Jira (SQLite). Write it as you like, then refine it if you want.</span>
        </div>
        <Link to="/tickets" className="icon" aria-label="Close panel">
          <Icon name="close" />
        </Link>
      </div>

      <form className="pbody storyform" onSubmit={save}>
        <div className="field-col">
          <label htmlFor={ids.summary}>Summary</label>
          <input id={ids.summary} className="text" value={draft.summary} onChange={(e) => set('summary', e.target.value)} maxLength={200} required placeholder="e.g. merchants can refund part of a payment" />
        </div>

        <div className="formgrid">
          <div className="field-col">
            <label htmlFor={ids.type}>Type</label>
            <select id={ids.type} value={draft.type} onChange={(e) => set('type', e.target.value as StoryDraft['type'])}>
              {['Story', 'Bug', 'Task'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="field-col">
            <label htmlFor={ids.status}>Status</label>
            <select id={ids.status} value={draft.status} onChange={(e) => set('status', e.target.value as StoryDraft['status'])}>
              {STORY_STATUSES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="field-col">
            <label htmlFor={ids.version}>Fix version</label>
            <input id={ids.version} className="text" value={draft.fixVersion} onChange={(e) => set('fixVersion', e.target.value)} maxLength={20} placeholder="24.12" />
          </div>
        </div>

        <fieldset className="field-col">
          <legend>Components</legend>
          <div className="checks">
            {allComponents.map((c) => (
              <label key={c} className="check mono">
                <input type="checkbox" checked={draft.components.includes(c)} onChange={(e) => set('components', e.target.checked ? [...draft.components, c] : draft.components.filter((x) => x !== c))} />
                {c}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="field-col">
          <label htmlFor={ids.desc}>Description</label>
          <textarea id={ids.desc} rows={3} value={draft.description} onChange={(e) => set('description', e.target.value)} maxLength={4000} />
        </div>

        <div className="field-col">
          <label htmlFor={ids.ac}>Acceptance criteria</label>
          <textarea
            id={ids.ac}
            rows={6}
            value={draft.acceptanceCriteria}
            onChange={(e) => set('acceptanceCriteria', e.target.value)}
            placeholder={'One per line, as you like. For example:\n- merchant can do partial refund\n- cant refund more than paid, show error\n- needs a reason'}
            aria-describedby={`${ids.ac}-hint`}
          />
          <small id={`${ids.ac}-hint`} className="muted">
            {lines(draft.acceptanceCriteria).length} criteria · one per line; bullets and numbers are fine
          </small>
        </div>

        {used && (
          <p className="callout" role="status">
            <Icon name="check" small />
            <span>
              Using the refined version. What you wrote is kept with the story.{' '}
              <button
                type="button"
                className="linkbtn"
                onClick={() => {
                  setDraft((d) => ({ ...d, ...used.original }));
                  setUsed(null);
                }}
              >
                Undo
              </button>
            </span>
          </p>
        )}

        {refined && (
          <section className="card refinecmp" aria-label="Refined version">
            <div className="rc-head">
              <b>Refined {refined.source === 'model' ? `with ${refined.model}` : 'with rules'}</b>
              {refined.note && <span className="muted">{refined.note}</span>}
            </div>
            <div className="rc-cols">
              <div>
                <h4>What you wrote</h4>
                <p className="rc-sum">{draft.summary || <span className="muted">No summary</span>}</p>
                <ul>
                  {lines(draft.acceptanceCriteria).map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h4>Refined</h4>
                <p className="rc-sum">{refined.refined.summary}</p>
                {refined.refined.description && <p className="muted rc-desc">{refined.refined.description}</p>}
                <ol>
                  {refined.refined.acceptanceCriteria.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ol>
              </div>
            </div>
            {refined.refined.questions.length > 0 && (
              <div className="check rc-q">
                <Icon name="warn" small />
                <div>
                  <b>Questions to settle before UAT</b>
                  <ul>
                    {refined.refined.questions.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            <div className="formactions">
              <button type="button" className="btn plain" onClick={() => setRefined(null)}>
                Keep mine
              </button>
              <button type="button" className="btn ink" onClick={useRefined}>
                Use this
              </button>
            </div>
          </section>
        )}

        {error && (
          <p className="callout bad" role="alert">
            <Icon name="warn" small />
            <span>{error}</span>
          </p>
        )}

        <div className="formactions sticky">
          <button type="button" className="btn" onClick={refine} disabled={!canRefine || busy !== null} aria-busy={busy === 'refine'}>
            {busy === 'refine' ? <span className="spinner sm" aria-hidden="true" /> : <Icon name="auto" small />}
            {busy === 'refine' ? 'Refining…' : 'Refine with AI'}
          </button>
          <span className="grow" />
          <Link to="/tickets" className="btn plain">
            Cancel
          </Link>
          <button type="submit" className="btn ink" disabled={!canSave || busy !== null}>
            {busy === 'save' ? 'Creating…' : 'Create story'}
          </button>
        </div>
      </form>
    </section>
  );
}
