import { useId, useState, type FormEvent } from 'react';

import { checkFeedback, MAX_COMMENT, MIN_COMMENT, reasonsFor } from '../../lib/feedback';
import type { Capability } from '../../lib/types';

interface FeedbackFormProps {
  stars: number;
  capability: Capability | null;
  busy: boolean;
  error: string | null;
  onSubmit: (reasons: string[], comment: string) => void;
  onCancel: () => void;
}

/**
 * Opens below 4 stars (DESIGN.md "Feedback"): reasons for the capability, and what was expected.
 * Rules nudge vague comments; the rating is only sent, and only shown as sent, once the server
 * has stored it.
 */
export function FeedbackForm({ stars, capability, busy, error, onSubmit, onCancel }: FeedbackFormProps) {
  const [reasons, setReasons] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const [touched, setTouched] = useState(false);
  const id = useId();
  const { blocking, hints } = checkFeedback(reasons, comment);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (blocking.length === 0) onSubmit(reasons, comment.trim());
  };

  return (
    <form className="card feedback" aria-label={`Feedback for a ${stars}-star rating`} onSubmit={submit}>
      <div className="fb-head">
        <b>{stars} of 5. What went wrong?</b>
        <span className="muted">Sent with the answer's revision, application and sources. Feedback improves Catalyzt; it is not used to assess people.</span>
      </div>
      <fieldset>
        <legend>Reasons (pick at least one)</legend>
        <div className="checks">
          {reasonsFor(capability).map((r) => (
            <label key={r} className="check">
              <input type="checkbox" checked={reasons.includes(r)} onChange={(e) => setReasons(e.target.checked ? [...reasons, r] : reasons.filter((x) => x !== r))} disabled={busy} />
              {r}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field-col" htmlFor={id}>
        What did you expect?
        <textarea id={id} rows={3} maxLength={MAX_COMMENT} value={comment} onChange={(e) => setComment(e.target.value)} onBlur={() => setTouched(true)} placeholder="The answer should have…" disabled={busy} />
        <small className="muted">
          {comment.trim().length}/{MAX_COMMENT} · at least {MIN_COMMENT} characters
        </small>
      </label>
      {hints.length > 0 && (
        <ul className="fb-hints">
          {hints.map((h) => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
      {touched && blocking.length > 0 && <p className="errtext">{blocking[0]}</p>}
      {error && (
        <p className="errtext" role="alert">
          {error}
        </p>
      )}
      <div className="formactions">
        <button type="button" className="btn plain" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn ink" disabled={busy} aria-busy={busy}>
          {busy ? 'Sending…' : 'Send feedback'}
        </button>
      </div>
    </form>
  );
}
