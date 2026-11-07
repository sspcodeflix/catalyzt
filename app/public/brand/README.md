# Catalyzt brand assets

Recreated as vector geometry from `docs/brand/catalyzt-reference.png` (the concept sheet). The mark is an open C
with angled terminals and a crimson needle pointing to the upper right; the geometry lives in `src/lib/brand.ts`
and every file here is generated from it by `scripts/brand.ts` (SVG) and `scripts/brand-preview.py` (PNG).

| File | Use |
|---|---|
| `catalyzt-mark.svg`, `-dark.svg`, `-mono.svg` | The mark alone: ink on transparent (light UI), paper on transparent (dark UI), one colour (`currentColor`) |
| `catalyzt-lockup.svg`, `-dark.svg`, `-mono.svg` | Horizontal lockup: mark, wordmark "Catalyzt", tagline "Confidence to ship." Text is converted to paths |
| `catalyzt-lockup.source.svg` | The editable source of the lockup with live text (needs Montserrat installed) |
| `favicon.svg` | The mark, ink by default and paper under a dark system scheme |
| `png/` | Transparent PNG exports: the mark at 16, 24, 32, 48, 180, 192 and 512 px (light and dark), the lockup at 1200 px wide, and app icons |

Colours: crimson `#C8102E`, ink `#17181C`, warm paper `#FBFAF8`; white for reversed versions. Flat fills only.

Wordmark face: Montserrat ExtraBold (800) and Medium (500) for the tagline, from `@fontsource/montserrat`, licensed under the
SIL Open Font License 1.1 (`FONT-LICENSE-OFL.txt`). Fidelity note: the reference sheet was drawn with a geometric sans whose
exact face is unknown; Montserrat is the closest licensed face available offline. Letterforms (notably the z) therefore
follow Montserrat, not the sheet, while weight, proportions and spacing were matched by eye. No trademark clearance is
claimed for the name or the mark.
