import { BRAND, C_PATH, MARK_VIEWBOX, NEEDLE_PATH } from '../lib/brand';

interface BrandMarkProps {
  /** Rendered height in pixels; the mark is 1.2× as wide. */
  size?: number;
  /** Set when the mark stands alone and must be announced, e.g. in the mobile top bar. */
  label?: string;
}

/**
 * The Catalyzt mark: an open C in the text colour and a crimson needle pointing to the upper
 * right. Flat fills from the design tokens, so it follows the theme; works down to 16px.
 */
export function BrandMark({ size = 26, label }: BrandMarkProps) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  return (
    <svg width={size * 1.2} height={size} viewBox={MARK_VIEWBOX} {...a11y}>
      <path d={C_PATH} fill="var(--hz-text)" />
      <path d={NEEDLE_PATH} fill="var(--hz-accent)" />
    </svg>
  );
}

/** The wordmark as text, in the brand face (Montserrat ExtraBold), for the sidebar. */
export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className={`wordmark${className ? ` ${className}` : ''}`} aria-label={BRAND.name}>
      {BRAND.name}
    </span>
  );
}
