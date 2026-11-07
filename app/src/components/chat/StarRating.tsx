import { useId } from 'react';

import { iconPaths } from '../icons';

interface StarRatingProps {
  value: number | null;
  onRate: (stars: number) => void;
  disabled?: boolean;
}

/**
 * Five stars as a native radio group, so keyboard and screen readers work without extra code.
 * Below 4 stars the feedback form opens (FeedbackForm) before the rating is sent.
 */
export function StarRating({ value, onRate, disabled = false }: StarRatingProps) {
  const name = useId();
  return (
    <fieldset className="rate" disabled={disabled}>
      <legend className="sr">Rate this answer</legend>
      {[1, 2, 3, 4, 5].map((s) => (
        <label key={s} className={`star${value !== null && s <= value ? ' on' : ''}`}>
          <input
            type="radio"
            className="sr"
            name={name}
            value={s}
            checked={value === s}
            onChange={() => onRate(s)}
            aria-label={`${s} star${s > 1 ? 's' : ''}`}
          />
          <svg viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: iconPaths.star }} />
        </label>
      ))}
    </fieldset>
  );
}
