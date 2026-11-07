/**
 * The Catalyzt mark, as geometry shared by the React component, the favicon and the asset
 * generator (scripts/brand.ts), so every rendering is the same shape.
 *
 * A bold open C (a ring of outer radius 46 and inner radius 27 around (50, 50), open to the right
 * at ±38° outside and ±30° inside, so the terminals are cut at an angle) and a crimson needle: a
 * slim triangle rooted near the centre that crosses the opening and points to the upper right.
 * Recreated from docs/brand/catalyzt-reference.png. Flat fills, no effects.
 */
export const BRAND = {
  name: 'Catalyzt',
  tagline: 'Confidence to ship.',
  crimson: '#C8102E',
  ink: '#17181C',
  paper: '#FBFAF8',
} as const;

export const MARK_VIEWBOX = '0 0 120 100';

const deg = Math.PI / 180;
const pt = (r: number, a: number) => [50 + r * Math.cos(a * deg), 50 + r * Math.sin(a * deg)] as const;
const f = (n: number) => n.toFixed(2);

function cPath() {
  const R = 46;
  const r = 27;
  const [ox1, oy1] = pt(R, 38);
  const [ox2, oy2] = pt(R, -38);
  const [ix1, iy1] = pt(r, -30);
  const [ix2, iy2] = pt(r, 30);
  // Outer arc the long way round (through the left), a slanted cut, the inner arc back, close.
  return `M${f(ox1)} ${f(oy1)}A${R} ${R} 0 1 1 ${f(ox2)} ${f(oy2)}L${f(ix1)} ${f(iy1)}A${r} ${r} 0 1 0 ${f(ix2)} ${f(iy2)}Z`;
}

export const C_PATH = cPath();
export const NEEDLE_PATH = 'M52 50L118 32L106 58Z';
