import { useId, useRef, useState } from 'react';

import { iconPaths } from '../icons';

interface StarRatingProps {
  value: number | null;
  onRate: (stars: number) => void;
  disabled?: boolean;
}

/**
 * Five stars as a native radio group, so keyboard and screen readers work without extra code.
 * Below 4 stars the feedback form opens (FeedbackForm) before the rating is sent.
 *
 * A click or Space rates at once. Arrow keys only move the choice (native radios select as they move,
 * which would otherwise send a rating for every star passed); Enter or Space then rates the chosen star.
 */
export function StarRating({ value, onRate, disabled = false }: StarRatingProps) {
  const name = useId();
  const hintId = useId();
  const [preview, setPreview] = useState<number | null>(null);
  const arrowed = useRef(false);
  const shown = preview ?? value;
  return (
    <fieldset
      className="rate"
      disabled={disabled}
      aria-describedby={hintId}
      onKeyDown={(e) => {
        if (e.key.startsWith('Arrow')) arrowed.current = true;
        else if ((e.key === 'Enter' || e.key === ' ') && preview !== null) {
          e.preventDefault();
          setPreview(null);
          onRate(preview);
        }
      }}
      // The change event of an arrow key fires during keydown; anything after it is not an arrow move.
      onKeyUp={() => (arrowed.current = false)}
      onPointerDown={() => (arrowed.current = false)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPreview(null);
      }}
    >
      <legend className="sr">Rate this answer</legend>
      {[1, 2, 3, 4, 5].map((s) => (
        <label key={s} className={`star${shown !== null && s <= shown ? ' on' : ''}`}>
          <input
            type="radio"
            className="sr"
            name={name}
            value={s}
            checked={shown === s}
            onChange={() => {
              if (arrowed.current) {
                arrowed.current = false;
                setPreview(s);
              } else onRate(s);
            }}
            aria-label={`${s} star${s > 1 ? 's' : ''}`}
          />
          <svg viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: iconPaths.star }} />
        </label>
      ))}
      {/* Last, so the stars stay children 2 to 6 after the legend. */}
      <span id={hintId} className="sr">
        Arrow keys choose, Enter rates.
      </span>
    </fieldset>
  );
}
