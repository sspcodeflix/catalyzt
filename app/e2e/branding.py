"""Stage D: Catalyzt branding and the UI refinements. Title, mark and wordmark, no leftover product name,
no inactive controls, the scope switcher in the chrome, home entry points from real data, plain nav labels,
phone chat/report tabs. Also writes screenshots to docs/brand/ (light, dark, phone)."""
import json, os, pathlib, re, sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get('E2E_BASE', 'http://127.0.0.1:5199')
SHOTS = pathlib.Path(__file__).resolve().parents[2] / 'docs' / 'brand'
checks = []
def check(name, ok, detail=''):
    checks.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail and not ok else ''))

errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_context(viewport={'width': 1360, 'height': 900}).new_page()
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and '404' not in m.text else None)
    page.goto(BASE + '/')
    page.wait_for_selector('.mebtn')
    page.click('.mebtn'); page.click('[role=menuitemradio]:has-text("Mohd Sayeer")'); page.wait_for_timeout(800)
    page.wait_for_selector('.entry a', timeout=15000)
    page.wait_for_function("() => !document.querySelector('.entry')?.innerText.includes('Loading')", timeout=15000)

    check('document title is Catalyzt', page.title() == 'Catalyzt', page.title())
    check('favicon is the Catalyzt mark', (page.get_attribute('link[rel=icon][type="image/svg+xml"]', 'href') or '') == '/favicon.svg')
    check('sidebar shows the mark and the wordmark', page.locator('.brand svg').count() == 1 and page.inner_text('.brand .wordmark') == 'Catalyzt')
    body = page.inner_text('body')
    check('no "Horizon" left in the visible UI', 'Horizon' not in body)
    check('tagline on the home page', 'Confidence to ship.' in body)
    check('no inactive Share or notification controls', page.locator('header .ghost:has-text("Share")').count() == 0 and page.locator('header button[aria-label^="Notifications"]').count() == 0)
    scope = page.inner_text('header .scope')
    check('scope switcher names the application with its id secondary', "Nabih's Portfolio" in scope and 'IBGM' in scope, scope)
    check('nav labels are plain', 'Hexa · Tests' in page.inner_text('.nav') and 'Huddle · Decisions' in page.inner_text('.nav'))
    entry = page.inner_text('.entry')
    check('home entry points use real counts, not invented metrics', re.search(r'\d+ (story|stories) in the Jira filter', entry) is not None and ('runs failed' in entry or 'No pipeline runs recorded yet' in entry) and ('approval' in entry), entry[:200])
    chips = page.locator('.tryrow .chip')
    check('home keeps one example per capability as a compact row, not cards', chips.count() == 5 and page.locator('.caps').count() == 0, str(chips.count()))
    first = chips.first.inner_text().strip()
    chips.first.click()
    check('an example fills the message box', page.input_value('.composer textarea') == first, first)
    page.fill('.composer textarea', '')
    page.screenshot(path=str(SHOTS / 'ui-home-light.png'))

    page.click('header button[aria-label^="Switch to dark"]')
    page.wait_for_function("() => document.documentElement.dataset.theme === 'dark'")
    page.screenshot(path=str(SHOTS / 'ui-home-dark.png'))
    check('dark theme applies', page.evaluate("() => document.documentElement.dataset.theme") == 'dark')
    page.click('header button[aria-label^="Switch to light"]')

    # Scope switcher: workspace change is reflected in the composer scope.
    page.click('header .scope.pick')
    page.wait_for_selector('[role=menuitemradio]')
    items = page.locator('[role=menuitemradio]')
    names = [items.nth(i).inner_text() for i in range(items.count())]
    check('scope menu offers workspaces', any('juice-shop' in n or 'piggymetrics' in n for n in names), str(names))
    page.keyboard.press('Escape')

    # Phone: chat and report are tabs, not a stack.
    m = b.new_context(viewport={'width': 390, 'height': 844}).new_page()
    m.on('console', lambda msg: errors.append(msg.text) if msg.type == 'error' and '404' not in msg.text else None)
    m.goto(BASE + '/tickets')
    # A fresh browser context: sign in through the drawer first.
    m.click('button[aria-label="Open sidebar"]')
    m.wait_for_selector('.sidebar.open .mebtn')
    m.click('.sidebar.open .mebtn'); m.click('[role=menuitemradio]:has-text("Mohd Sayeer")'); m.wait_for_timeout(800)
    m.goto(BASE + '/tickets')
    m.wait_for_selector('table.tickets tbody tr button.btn.small', state='attached', timeout=15000)
    m.click('table.tickets tbody tr:first-child button.btn.small')
    m.wait_for_url(re.compile(r'/chat/[0-9a-f-]+/artifact/'), timeout=15000)
    m.wait_for_selector('.mobiletabs [role=tab]', timeout=15000)
    m.wait_for_function("() => /Rate|cannot be rated/.test(document.querySelector('.msgactions')?.innerText || '')", timeout=20000)
    check('phone shows chat/report tabs', m.locator('.mobiletabs [role=tab]').count() == 2)
    check('report tab is selected by default and the chat column is hidden', m.get_attribute('.mobiletabs [role=tab]:has-text("Report")', 'aria-selected') == 'true' and not m.is_visible('.chatcol'))
    m.screenshot(path=str(SHOTS / 'ui-report-phone.png'))
    m.click('.mobiletabs [role=tab]:has-text("Chat")')
    m.wait_for_function("() => getComputedStyle(document.querySelector('.chatcol')).display !== 'none'")
    check('chat tab shows the chat and hides the report', m.is_visible('.chatcol') and not m.is_visible('.panel'))
    m.screenshot(path=str(SHOTS / 'ui-chat-phone.png'))
    b.close()

bad = [c for c in checks if not c[1]]
print(f'\n{len(checks) - len(bad)} of {len(checks)} checks passed; console errors: {json.dumps(errors[:5]) if errors else "none"}')
sys.exit(1 if bad or errors else 0)
