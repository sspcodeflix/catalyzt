/**
 * Writes the Catalyzt brand assets into app/public/brand/ from the shared geometry (src/lib/brand.ts)
 * and the Montserrat font (OFL, bundled with @fontsource/montserrat):
 *
 *   catalyzt-mark.svg / -dark.svg / -mono.svg          the mark alone (ink on transparent, paper on transparent, currentColor)
 *   catalyzt-lockup.svg / -dark.svg / -mono.svg        mark + wordmark + tagline, text converted to paths
 *   catalyzt-lockup.source.svg                         the editable source: the same lockup with live <text>
 *   favicon.svg                                        the mark, following the system colour scheme
 *   README.md, FONT-LICENSE-OFL.txt                    what each file is; the font license
 *
 * PNG exports and the preview sheet come from scripts/brand-preview.py (Playwright).
 *   cd app && ./node_modules/.bin/vite-node scripts/brand.ts
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import opentype from 'opentype.js';

import { BRAND, C_PATH, MARK_VIEWBOX, NEEDLE_PATH } from '../src/lib/brand';

const out = resolve('public/brand');
mkdirSync(out, { recursive: true });
const fontDir = resolve('node_modules/@fontsource/montserrat/files');
const load = (file: string) => {
  const buf = readFileSync(join(fontDir, file));
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
};
const bold = load('montserrat-latin-800-normal.woff');
const medium = load('montserrat-latin-500-normal.woff');

/* ---------- Mark ---------- */
const mark = (c: string, needle: string, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_VIEWBOX}" role="img" aria-label="${BRAND.name} mark">${extra}<path class="c" d="${C_PATH}" fill="${c}"/><path class="n" d="${NEEDLE_PATH}" fill="${needle}"/></svg>\n`;
writeFileSync(join(out, 'catalyzt-mark.svg'), mark(BRAND.ink, BRAND.crimson));
writeFileSync(join(out, 'catalyzt-mark-dark.svg'), mark(BRAND.paper, BRAND.crimson));
writeFileSync(join(out, 'catalyzt-mark-mono.svg'), mark('currentColor', 'currentColor'));
writeFileSync(join(out, 'favicon.svg'), mark(BRAND.ink, BRAND.crimson, `<style>@media (prefers-color-scheme: dark){.c{fill:${BRAND.paper}}}</style>`));

/* ---------- Lockup: mark 240 high at the left, wordmark and tagline to its right ---------- */
const H = 300;
const markH = 220;
const markW = markH * 1.2;
const markX = 20;
const markY = (H - markH) / 2;
const textX = markX + markW + 36;
const wordSize = 150;
const tagSize = 46;
const wordBaseline = 168;
const tagBaseline = wordBaseline + 74;
const tracking = -0.012; // em, a touch tighter than default
const word = bold.getPath(BRAND.name, textX, wordBaseline, wordSize, { letterSpacing: tracking, kerning: true });
const tag = medium.getPath(BRAND.tagline, textX, tagBaseline, tagSize, { kerning: true });
const wordW = bold.getAdvanceWidth(BRAND.name, wordSize, { letterSpacing: tracking, kerning: true });
const tagW = medium.getAdvanceWidth(BRAND.tagline, tagSize, { kerning: true });
const W = Math.ceil(textX + Math.max(wordW, tagW) + 24);
const lockup = (ink: string, needle: string, tagColor: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${BRAND.name}. ${BRAND.tagline}">
  <g transform="translate(${markX} ${markY}) scale(${(markH / 100).toFixed(3)})"><path d="${C_PATH}" fill="${ink}"/><path d="${NEEDLE_PATH}" fill="${needle}"/></g>
  <path d="${word.toPathData(2)}" fill="${ink}"/>
  <path d="${tag.toPathData(2)}" fill="${tagColor}"/>
</svg>
`;
writeFileSync(join(out, 'catalyzt-lockup.svg'), lockup(BRAND.ink, BRAND.crimson, '#3A3B41'));
writeFileSync(join(out, 'catalyzt-lockup-dark.svg'), lockup(BRAND.paper, BRAND.crimson, '#D7D5CF'));
writeFileSync(join(out, 'catalyzt-lockup-mono.svg'), lockup('currentColor', 'currentColor', 'currentColor'));
writeFileSync(
  join(out, 'catalyzt-lockup.source.svg'),
  `<!-- Editable source. Wordmark: Montserrat ExtraBold (800); tagline: Montserrat Medium (500). Montserrat is licensed under the SIL Open Font License 1.1 (FONT-LICENSE-OFL.txt). The distribution files convert this text to paths. -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${BRAND.name}. ${BRAND.tagline}">
  <g transform="translate(${markX} ${markY}) scale(${(markH / 100).toFixed(3)})"><path d="${C_PATH}" fill="${BRAND.ink}"/><path d="${NEEDLE_PATH}" fill="${BRAND.crimson}"/></g>
  <text x="${textX}" y="${wordBaseline}" font-family="Montserrat" font-weight="800" font-size="${wordSize}" letter-spacing="${(tracking * wordSize).toFixed(1)}" fill="${BRAND.ink}">${BRAND.name}</text>
  <text x="${textX}" y="${tagBaseline}" font-family="Montserrat" font-weight="500" font-size="${tagSize}" fill="#3A3B41">${BRAND.tagline}</text>
</svg>
`,
);
copyFileSync(resolve('node_modules/@fontsource/montserrat/LICENSE'), join(out, 'FONT-LICENSE-OFL.txt'));
writeFileSync(
  join(out, 'README.md'),
  `# Catalyzt brand assets

Recreated as vector geometry from \`docs/brand/catalyzt-reference.png\` (the concept sheet). The mark is an open C
with angled terminals and a crimson needle pointing to the upper right; the geometry lives in \`src/lib/brand.ts\`
and every file here is generated from it by \`scripts/brand.ts\` (SVG) and \`scripts/brand-preview.py\` (PNG).

| File | Use |
|---|---|
| \`catalyzt-mark.svg\`, \`-dark.svg\`, \`-mono.svg\` | The mark alone: ink on transparent (light UI), paper on transparent (dark UI), one colour (\`currentColor\`) |
| \`catalyzt-lockup.svg\`, \`-dark.svg\`, \`-mono.svg\` | Horizontal lockup: mark, wordmark "Catalyzt", tagline "Confidence to ship." Text is converted to paths |
| \`catalyzt-lockup.source.svg\` | The editable source of the lockup with live text (needs Montserrat installed) |
| \`favicon.svg\` | The mark, ink by default and paper under a dark system scheme |
| \`png/\` | Transparent PNG exports: the mark at 16, 24, 32, 48, 180, 192 and 512 px (light and dark), the lockup at 1200 px wide, and app icons |

Colours: crimson \`${BRAND.crimson}\`, ink \`${BRAND.ink}\`, warm paper \`${BRAND.paper}\`; white for reversed versions. Flat fills only.

Wordmark face: Montserrat ExtraBold (800) and Medium (500) for the tagline, from \`@fontsource/montserrat\`, licensed under the
SIL Open Font License 1.1 (\`FONT-LICENSE-OFL.txt\`). Fidelity note: the reference sheet was drawn with a geometric sans whose
exact face is unknown; Montserrat is the closest licensed face available offline. Letterforms (notably the z) therefore
follow Montserrat, not the sheet, while weight, proportions and spacing were matched by eye. No trademark clearance is
claimed for the name or the mark.
`,
);
console.log(`Wrote brand assets to ${out} (lockup ${W}×${H})`);
