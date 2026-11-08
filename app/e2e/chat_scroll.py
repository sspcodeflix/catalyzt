"""The chat scrolls like other AI tools: the conversation has its own scroll area, the reply box stays
in view, new answers are followed, "Jump to latest" appears when the reader scrolls up, and the page
itself never scrolls. Checked at desktop and phone widths."""
import json, os, re, sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get('E2E_BASE', 'http://127.0.0.1:5199')
checks = []
def check(name, ok, detail=''):
    checks.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail and not ok else ''))

def sign_in(page, name):
    page.click('.mebtn')
    page.click(f'[role=menuitemradio]:has-text("{name}")')
    page.wait_for_timeout(400)

def in_view(page, sel):
    return page.evaluate(f"() => {{ const r = document.querySelector('{sel}')?.getBoundingClientRect(); return !!r && r.top >= 0 && r.bottom <= window.innerHeight + 1; }}")

errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_context(viewport={'width': 1360, 'height': 800}).new_page()
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.goto(BASE + '/')
    page.wait_for_selector('.mebtn')
    sign_in(page, 'Sourav')
    page.goto(BASE + '/')
    page.wait_for_selector('.composer textarea')
    page.fill('.composer textarea', 'Which tests cover frontend, and what is missing?')
    page.keyboard.press('Enter')
    page.wait_for_url(re.compile(r'/chat/[0-9a-f-]+'), timeout=15000)
    page.wait_for_selector('.turn .msgactions', timeout=20000)
    # Make the conversation longer than the window.
    for i in range(6):
        page.fill('.composer textarea', f'Follow-up question number {i + 1}: which tests cover checkoutservice and what evidence is missing?')
        page.keyboard.press('Enter')
        page.wait_for_function(f"() => document.querySelectorAll('.turn .msgactions').length >= {i + 2}", timeout=20000)
    page.wait_for_timeout(400)
    m = page.evaluate("() => { const s = document.querySelector('.threadscroll'); return { sh: s.scrollHeight, ch: s.clientHeight, top: s.scrollTop, doc: document.scrollingElement.scrollHeight, win: window.innerHeight }; }")
    check('the conversation has its own scroll area', m['sh'] > m['ch'] + 50, json.dumps(m))
    check('the page itself does not scroll', m['doc'] <= m['win'] + 1, json.dumps(m))
    check('the reply box is in view', in_view(page, '.composer textarea'))
    check('the newest answer is in view after sending', m['sh'] - m['top'] - m['ch'] < 80, json.dumps(m))
    check('no jump button while at the bottom', page.locator('.jumplatest').count() == 0)
    page.evaluate("() => document.querySelector('.threadscroll').scrollTo({ top: 0 })")
    page.wait_for_selector('.jumplatest', timeout=3000)
    check('scrolling up shows "Jump to latest"', page.locator('.jumplatest').is_visible())
    check('the reply box stays in view while reading older turns', in_view(page, '.composer textarea'))
    page.click('.jumplatest')
    page.wait_for_function("() => { const s = document.querySelector('.threadscroll'); return s.scrollHeight - s.scrollTop - s.clientHeight < 80; }", timeout=5000)
    check('"Jump to latest" goes back to the newest answer', page.locator('.jumplatest').count() == 0)
    # A new message while scrolled to the bottom is followed.
    page.fill('.composer textarea', 'One more question about the gateway and its tests?')
    page.keyboard.press('Enter')
    page.wait_for_function("() => document.querySelectorAll('.turn .msgactions').length >= 8", timeout=20000)
    page.wait_for_timeout(300)
    check('a new answer is followed to the bottom', page.evaluate("() => { const s = document.querySelector('.threadscroll'); return s.scrollHeight - s.scrollTop - s.clientHeight < 80; }"))
    chat_url = page.url

    # Phone: the same chat, the conversation scrolls inside, the reply box stays visible.
    phone = b.new_context(viewport={'width': 390, 'height': 844}).new_page()
    phone.goto(BASE + '/')
    phone.wait_for_selector('.mebtn', state='attached')
    phone.evaluate("() => document.querySelector('button[aria-label=\"Open sidebar\"]')?.click()")
    phone.wait_for_selector('.sidebar.open .mebtn')
    phone.click('.sidebar.open .mebtn')
    phone.click('[role=menuitemradio]:has-text("Sourav")')
    phone.wait_for_timeout(400)
    phone.goto(chat_url)
    phone.wait_for_selector('.turn .msgactions', timeout=20000)
    phone.wait_for_timeout(400)
    pm = phone.evaluate("() => { const s = document.querySelector('.threadscroll'); return { sh: s.scrollHeight, ch: s.clientHeight, doc: document.scrollingElement.scrollHeight, win: window.innerHeight, sw: document.scrollingElement.scrollWidth }; }")
    check('phone: the conversation scrolls inside, the page does not', pm['sh'] > pm['ch'] and pm['doc'] <= pm['win'] + 1, json.dumps(pm))
    check('phone: no sideways scroll', pm['sw'] <= 391, json.dumps(pm))
    check('phone: the reply box is in view', in_view(phone, '.composer textarea'))
    b.close()

bad = [c for c in checks if not c[1]]
print(f'\n{len(checks) - len(bad)} of {len(checks)} checks passed; console errors: {json.dumps(errors[:5]) if errors else "none"}')
sys.exit(1 if bad or errors else 0)
