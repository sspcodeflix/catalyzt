"""Test flows inside chat (docs/FLOWS.md): asking to start a flow gives a Start card listing the
stories found; Start turns it into the live flow card, which stays the live flow after a reload;
"where is the UAT" and "what's waiting on me" answer with live cards. Runs against run.sh's server."""
import os, re, sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get('E2E_BASE', 'http://127.0.0.1:5199')
checks = []
def check(name, ok, detail=''):
    checks.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail and not ok else ''))

def sign_in(page, name):
    page.click('.mebtn'); page.click(f'[role=menuitemradio]:has-text("{name}")'); page.wait_for_timeout(700)

def ask(page, text):
    n = page.locator('.turn .msgactions').count()
    page.fill('.composer textarea', text)
    page.keyboard.press('Enter')
    page.wait_for_function(f"document.querySelectorAll('.turn .msgactions').length > {n}", timeout=30000)
    page.wait_for_timeout(500)

errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1360, 'height': 900})
    page = ctx.new_page()
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and '404' not in m.text else None)
    page.goto(BASE + '/')
    page.wait_for_selector('.mebtn')
    sign_in(page, 'Ram Kumar')

    # Ask to start: a Start card with the stories, nothing created yet.
    H = {'x-horizon-user': 'u-ram', 'x-horizon-app': 'ABCD'}
    count = lambda: len(ctx.request.get(BASE + '/api/flows?all=1', headers=H).json()['flows'])
    before = count()
    page.goto(BASE + '/')
    page.wait_for_selector('.composer textarea')
    page.fill('.composer textarea', 'Start UAT for the Ready for UAT stories')
    page.keyboard.press('Enter')
    page.wait_for_selector('.flowstartcard', timeout=30000)
    page.wait_for_selector('.turn .msgactions', timeout=30000)
    n = page.locator('.flowstartlist input:checked').count()
    check('start card: lists the Ready for UAT stories, all ticked', n >= 2, str(n))
    check('start card: the answer itself starts nothing', count() == before)
    boxes = page.locator('.flowstartlist input[type=checkbox]')
    for i in range(2, boxes.count()):
        boxes.nth(i).uncheck()
    btn = page.locator('.flowstartcard .btn.ink')
    page.wait_for_function("!document.querySelector('.flowstartcard .btn.ink').disabled", timeout=15000)
    check('start card: button counts the ticked stories', 'Start with 2 stories' in btn.inner_text(), btn.inner_text())
    btn.click()
    page.wait_for_selector('.flowchat .flowsteps', timeout=15000)
    check('after Start: the card is the live flow', page.locator('.flowstartcard').count() == 0 and page.locator('.flowchat .flowsteps li').count() == 4)
    chat_url = page.url

    # The background analysis shows up in the card without asking again.
    ok = False
    for _ in range(30):
        if '2 of 2' in page.locator('.flowchat .flowsteps li').first.inner_text():
            ok = True; break
        page.wait_for_timeout(1000)
    check('live: the card follows the background analysis', ok)

    # Reload: the answer shows the flow, not a second Start.
    page.goto(chat_url)
    page.wait_for_selector('.flowchat .flowsteps', timeout=15000)
    check('reload: still the live flow, no Start button again', page.locator('.flowstartcard').count() == 0)

    # Where does it stand, and what waits on me.
    ask(page, 'Where is the UAT flow?')
    check('status: answers with the flow card and its step', page.locator('.turn').last.locator('.flowchat').count() == 1 and re.search(r'is at (Analyse|Review cases|Run tests|Sign off)', page.locator('.turn').last.inner_text()) is not None)
    ask(page, "What's waiting on me?")
    last = page.locator('.turn').last
    check('waiting: a sentence and the list of flows', last.locator('.flowchatlist .flowcard').count() >= 1)
    check('card: opens the full flow', page.locator('.flowchat a:has-text("Open the full flow")').count() >= 1)

    # Sourav, a component manager, sees the same flow from his own chat.
    sign_in(page, 'Sourav')
    page.goto(BASE + '/')
    page.fill('.composer textarea', "What's waiting on me?")
    page.keyboard.press('Enter')
    page.wait_for_selector('.turn .msgactions', timeout=30000)
    check('team: Sourav gets the same flow in his chat', page.locator('.flowchatlist .flowcard').count() >= 1)

    page.set_viewport_size({'width': 390, 'height': 844})
    page.goto(chat_url)
    page.wait_for_timeout(1500)
    sw = page.evaluate('document.documentElement.scrollWidth')
    check('phone: no sideways scroll with a flow card', sw <= 392, str(sw))
    b.close()

print(f'\n{sum(ok for _, ok in checks)} of {len(checks)} checks passed; console errors: {len(errors) or "none"}')
for e in errors[:5]:
    print('  console:', e[:200])
sys.exit(0 if all(ok for _, ok in checks) and not errors else 1)
