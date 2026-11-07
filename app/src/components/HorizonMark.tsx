import { useId } from 'react';

interface HorizonMarkProps {
  size?: number;
  /** Set when the mark stands alone and must be announced, e.g. in the mobile top bar. */
  label?: string;
}

/**
 * The Horizon mark: a scan-line sun rising over the horizon line, ending in a circuit node,
 * inside a hexagon. Colours come from the --hz-dawn-* tokens and the text colour.
 */
export function HorizonMark({ size = 26, label }: HorizonMarkProps) {
  const id = useId().replace(/:/g, '');
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" {...a11y}>
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--hz-dawn-1)' }} />
          <stop offset=".6" style={{ stopColor: 'var(--hz-dawn-2)' }} />
          <stop offset="1" style={{ stopColor: 'var(--hz-dawn-3)' }} />
        </linearGradient>
        <clipPath id={`${id}c`}>
          <rect x="0" y="7.6" width="32" height="3.6" />
          <rect x="0" y="12.4" width="32" height="2.9" />
          <rect x="0" y="16.5" width="32" height="2.2" />
        </clipPath>
      </defs>
      <path d="M16 1.8 28.4 9v14L16 30.2 3.6 23V9z" fill="none" stroke="var(--hz-text)" strokeWidth="2.2" strokeLinejoin="round" />
      <circle cx="16" cy="19.6" r="10" fill={`url(#${id}g)`} clipPath={`url(#${id}c)`} />
      <rect x="5.6" y="20.3" width="16.4" height="2.4" rx="1.2" fill="var(--hz-text)" />
      <circle cx="24.9" cy="21.5" r="2.1" fill="var(--hz-text)" />
    </svg>
  );
}
