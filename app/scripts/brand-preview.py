"""PNG exports and the preview sheet for the Catalyzt assets (run scripts/brand.ts first).
   cd app && python3 scripts/brand-preview.py
Writes public/brand/png/*.png and docs/brand/catalyzt-preview.png."""
import os, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
BRAND = ROOT / 'public' / 'brand'
PNG = BRAND / 'png'
PNG.mkdir(exist_ok=True)
DOCS = ROOT.parent / 'docs' / 'brand'
SIZES = [16, 24, 32, 48, 180, 192, 512]

import re

def aspect(svg):
    m = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', svg)
    return float(m.group(1)) / float(m.group(2))

def svg_html(svg_path, width=None, height=None, bg='transparent', color='#17181C'):
    svg = svg_path.read_text()
    a = aspect(svg)
    if height and not width:
        width = round(height * a)
    if width and not height:
        height = round(width / a)
    return f"<html><head><style>div>svg{{display:block;width:100%;height:100%}}</style></head><body style='margin:0;background:{bg};color:{color};display:inline-block'><div style='width:{width}px;height:{height}px;display:block;line-height:0'>{svg}</div></body></html>"

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_context(device_scale_factor=1).new_page()
    def shot(html, out, scale=1):
        ctx = b.new_context(device_scale_factor=scale)
        pg = ctx.new_page()
        pg.set_content(html)
        el = pg.query_selector('div')
        el.screenshot(path=str(out), omit_background=True)
        ctx.close()
    for size in SIZES:
        shot(svg_html(BRAND / 'catalyzt-mark.svg', height=size), PNG / f'catalyzt-mark-{size}.png')
        shot(svg_html(BRAND / 'catalyzt-mark-dark.svg', height=size), PNG / f'catalyzt-mark-dark-{size}.png')
    shot(svg_html(BRAND / 'catalyzt-lockup.svg', width=1200), PNG / 'catalyzt-lockup-1200.png')
    shot(svg_html(BRAND / 'catalyzt-lockup-dark.svg', width=1200), PNG / 'catalyzt-lockup-dark-1200.png')
    # App icons: the mark centred in a square on the brand colours.
    for size, bg, fname, mark in [(512, '#FBFAF8', 'app-icon-512.png', 'catalyzt-mark.svg'), (512, '#17181C', 'app-icon-dark-512.png', 'catalyzt-mark-dark.svg'), (192, '#FBFAF8', 'app-icon-192.png', 'catalyzt-mark.svg'), (180, '#FBFAF8', 'apple-touch-icon-180.png', 'catalyzt-mark.svg')]:
        svg = (BRAND / mark).read_text()
        html = f"<html><head><style>div>svg{{display:block;width:100%;height:100%}}</style></head><body style='margin:0'><div style='width:{size}px;height:{size}px;background:{bg};display:flex;align-items:center;justify-content:center;border-radius:{round(size*0.18)}px'><div style='width:{round(size*0.66)}px;height:{round(size*0.55)}px;line-height:0'>{svg}</div></div></body></html>"
        ctx = b.new_context(device_scale_factor=1); pg = ctx.new_page(); pg.set_content(html); pg.query_selector('div').screenshot(path=str(PNG / fname), omit_background=True); ctx.close()

    # Preview sheet: lockups on paper and ink, the mark at 16/24/32/48 on both, mono on crimson.
    lock = (BRAND / 'catalyzt-lockup.svg').read_text(); lockd = (BRAND / 'catalyzt-lockup-dark.svg').read_text()
    mark = (BRAND / 'catalyzt-mark.svg').read_text(); markd = (BRAND / 'catalyzt-mark-dark.svg').read_text(); mono = (BRAND / 'catalyzt-mark-mono.svg').read_text()
    row = lambda svg: ''.join(f"<div style='display:flex;flex-direction:column;align-items:center;gap:6px;font:12px sans-serif;opacity:.8'><div style='height:{s}px;width:{round(s*1.2)}px;line-height:0'>{svg}</div><span>{s}px</span></div>" for s in [16, 24, 32, 48])
    html = f"""<html><head><style>div>svg{{display:block;width:100%;height:100%}}</style></head><body style='margin:0;font-family:sans-serif'>
<div style='width:1200px'>
  <div style='background:#FBFAF8;padding:48px 64px;display:flex;flex-direction:column;gap:36px;color:#17181C'>
    <div style='width:720px;height:{round(720*300/985)}px'>{lock}</div>
    <div style='display:flex;gap:40px;align-items:flex-end'>{row(mark)}</div>
  </div>
  <div style='background:#17181C;padding:48px 64px;display:flex;flex-direction:column;gap:36px;color:#FBFAF8'>
    <div style='width:720px;height:{round(720*300/985)}px'>{lockd}</div>
    <div style='display:flex;gap:40px;align-items:flex-end'>{row(markd)}</div>
  </div>
  <div style='background:#C8102E;padding:40px 64px;display:flex;gap:40px;align-items:flex-end;color:#FFFFFF'>{row(mono)}<div style='height:96px;width:115px;line-height:0'>{mono}</div><span style='font:13px sans-serif'>one colour, reversed on crimson</span></div>
</div></body></html>"""
    page.set_content(html)
    page.query_selector('body > div').screenshot(path=str(DOCS / 'catalyzt-preview.png'))
    b.close()
print('wrote', len(list(PNG.glob('*.png'))), 'PNGs and', DOCS / 'catalyzt-preview.png')
