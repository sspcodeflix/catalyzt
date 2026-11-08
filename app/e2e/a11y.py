"""Accessibility: axe-core on the main pages in light and dark at desktop and phone width, then a keyboard-only
pass through the main flows. Fails on any serious or critical axe violation, on a Tab stop with no visible
focus indicator, or on a flow step that cannot be done from the keyboard.

  A11Y_REPORT=1  also prints every violation (any impact) with its first targets.
axe-core is loaded from node_modules (devDependency) and injected into the page."""
import json, os, pathlib, re, sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get('E2E_BASE', 'http://127.0.0.1:5199')
AXE = pathlib.Path(__file__).resolve().parents[1] / 'node_modules' / 'axe-core' / 'axe.min.js'
REPORT = os.environ.get('A11Y_REPORT') == '1'
checks = []
def check(name, ok, detail=''):
    checks.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail and not ok else ''))

errors = []

def new_page(browser, theme, width, user='u-sayeer'):
    session = json.dumps({'userId': user, 'appId': 'IBGM', 'workspace': None})
    ctx = browser.new_context(viewport={'width': width, 'height': 900 if width > 600 else 844}, reduced_motion='reduce')
    ctx.add_init_script(f"try {{ localStorage.setItem('hz-session', {json.dumps(session)}); localStorage.setItem('hz-theme', '{theme}'); }} catch (e) {{}}")
    page = ctx.new_page()
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and '404' not in m.text else None)
    return page

def settle(page):
    page.wait_for_function("() => !document.querySelector('[aria-busy=\"true\"]') && !/Loading…/.test(document.querySelector('main')?.innerText || '')", timeout=15000)
    page.wait_for_timeout(300)

def axe(page, menu_open=False):
    if not page.evaluate("() => !!window.axe"):
        page.add_script_tag(path=str(AXE))
    # While a Radix menu is open it hides the rest of the page with aria-hidden and keeps focus inside the menu,
    # which axe cannot see; aria-hidden-focus is therefore not meaningful in that state (focus trap is checked
    # by the keyboard pass) and is left to the screen-reader check.
    rules = "{ 'aria-hidden-focus': { enabled: false } }" if menu_open else '{}'
    return page.evaluate("""async () => {
      const r = await axe.run(document, { resultTypes: ['violations'], rules: """ + rules + """ });
      return r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map(n => ({ target: n.target.join(' '), summary: n.failureSummary })) }));
    }""")

with sync_playwright() as p:
    browser = p.chromium.launch()

    # Fixtures the pages need: a UAT chat with its report, and a Huddle item (from a reported conflict).
    page = new_page(browser, 'light', 1360)
    page.goto(BASE + '/')
    page.wait_for_selector('.composer textarea')
    page.fill('.composer textarea', 'Is IBGM-1008 ready for UAT?')
    page.keyboard.press('Enter')
    page.wait_for_url(re.compile(r'/chat/[0-9a-f-]+'), timeout=15000)
    page.wait_for_function("() => /Rate this answer|cannot be rated/.test(document.querySelector('.msgactions')?.innerText || '')", timeout=20000)
    page.click('.thread a.artifact')  # open the UAT report in the panel
    page.wait_for_selector('.panel', timeout=10000)
    chat_url = page.url
    page.goto(BASE + '/huddle')
    settle(page)
    if page.locator('a[href^="/huddle/hd-"]').count() == 0:
        page.goto(BASE + '/context')
        page.wait_for_selector('.dz input[type=file]', state='attached', timeout=15000)
        page.set_input_files('.dz input[type=file]', [{'name': 'a11y-notes.md', 'mimeType': 'text/markdown', 'buffer': b'# A11y notes\n\nStatements are kept for 400 days.'}])
        page.wait_for_function("() => document.querySelector('.dt')?.innerText.includes('a11y-notes.md')", timeout=20000)
        page.click('.dt tbody tr .srclink:text-is("a11y-notes.md")')
        page.click('.panel [role=tab]:has-text("Report a conflict")')
        page.fill('.panel input[placeholder="Refund window: 60 or 45 days?"]', 'Statement retention: 400 or 365 days?')
        page.fill('.panel input[placeholder="60 days"]', '400 days')
        page.fill('.panel input[placeholder="45 days"]', '365 days')
        page.click('.panel button:has-text("Send to Huddle")')
        page.wait_for_url(re.compile(r'/huddle/hd-'), timeout=15000)
    else:
        page.click('a[href^="/huddle/hd-"] >> nth=0')
        page.wait_for_url(re.compile(r'/huddle/hd-'), timeout=15000)
    huddle_url = page.url
    page.context.close()

    def go(path, wait):
        def f(pg):
            pg.goto(BASE + path)
            pg.wait_for_selector(wait, timeout=15000)
            settle(pg)
        return f
    def source_panel(pg):
        pg.goto(BASE + '/context')
        pg.wait_for_selector('.dt tbody tr .srclink', timeout=15000)
        pg.click('.dt tbody tr .srclink:text-is("piggymetrics")')
        pg.click('.panel [role=tab]:has-text("Passages")')
        pg.wait_for_selector('.panel .chunk', timeout=15000)
        settle(pg)

    PAGES = [
        ('Home', go('/', '.entry a')),
        ('Chat + UAT report', go(chat_url.replace(BASE, ''), '.panel')),
        ('Jira Stories', go('/tickets', 'table.tickets tbody tr')),
        ('Hexa manual', go('/hexa?tab=manual', '.dt')),
        ('Hexa automated', go('/hexa?tab=automated', '.dt')),
        ('Hexa runs', go('/hexa?tab=runs', '.tabs')),
        ('App Context', go('/context', '.dt tbody tr .srclink')),
        ('App Context source', source_panel),
        ('Huddle', go('/huddle', 'main')),
        ('Huddle item', go(huddle_url.replace(BASE, ''), '.panel .options')),
        ('Agents', go('/agents', 'main h1, main h2')),
    ]
    def menu_open(pg):
        go('/', '.entry a')(pg)
        btn = '.mebtn'
        if pg.locator('button[aria-label="Open sidebar"]').is_visible():
            pg.click('button[aria-label="Open sidebar"]')
            btn = '.sidebar.open .mebtn'
            pg.wait_for_selector(btn)
            pg.wait_for_timeout(300)
        pg.click(btn)
        pg.wait_for_selector('[role=menuitemradio]')
        pg.wait_for_timeout(300)
    def phone_chat_tab(pg):
        go(chat_url.replace(BASE, ''), '.mobiletabs [role=tab]')(pg)
        pg.click('.mobiletabs [role=tab]:has-text("Chat")')
        pg.wait_for_selector('.chatcol .msgactions')
    DESKTOP_EXTRA = [('Person menu open', menu_open)]
    PHONE_EXTRA = [('Drawer and person menu open', menu_open), ('Chat tab of a chat with a report', phone_chat_tab)]
    summary = []
    for theme, width in [('light', 1360), ('dark', 1360), ('light', 390), ('dark', 390)]:
        pg = new_page(browser, theme, width)
        for name, setup in PAGES + (PHONE_EXTRA if width < 600 else DESKTOP_EXTRA):
            setup(pg)
            vs = axe(pg, menu_open=setup is menu_open)
            bad = [v for v in vs if v['impact'] in ('serious', 'critical')]
            label = f'{name} · {theme} · {width}px'
            summary.append((label, len(bad), sum(len(v['nodes']) for v in bad)))
            if REPORT:
                for v in vs:
                    print(f"  {label}: {v['impact']} {v['id']} ({len(v['nodes'])}) {v['help']}")
                    for n in v['nodes'][:4]:
                        print(f"      {n['target']}  {n['summary'].splitlines()[-1][:160] if n['summary'] else ''}")
            check(f'axe: no serious/critical on {label}', not bad, '; '.join(f"{v['id']}×{len(v['nodes'])} {v['nodes'][0]['target']}" for v in bad))
        pg.context.close()

    # ---- Keyboard only.
    pg = new_page(browser, 'light', 1360, user='u-nabih')
    pg.goto(BASE + '/')
    pg.wait_for_selector('.entry a', timeout=15000)
    settle(pg)
    # A Tab stop shows focus when the focused element or a close ancestor looks different focused and blurred
    # (outline, ring, border or background), so focus-within styles on a wrapper count too.
    focus_info = """() => { const e = document.activeElement; if (!e || e === document.body) return null;
      const props = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'borderTopColor', 'borderBottomColor', 'backgroundColor', 'textDecorationLine'];
      const chain = []; for (let x = e, i = 0; x && i < 4; x = x.parentElement, i++) chain.push(x);
      const snap = () => chain.map(x => { const s = getComputedStyle(x); return props.map(p => s[p]).join('|'); }).join('/');
      const r = e.getBoundingClientRect();
      const focused = snap(); e.blur(); const blurred = snap(); e.focus();
      const name = (e.getAttribute('aria-label') || e.innerText || e.getAttribute('placeholder') || e.tagName).trim().slice(0, 40);
      return { name, tag: e.tagName, ring: focused !== blurred, visible: r.width > 0 && r.height > 0 }; }"""
    stops, no_ring = [], []
    for _ in range(45):
        pg.keyboard.press('Tab')
        f = pg.evaluate(focus_info)
        if not f: continue
        stops.append(f['name'])
        if not f['ring'] or not f['visible']: no_ring.append(f"{f['tag']} {f['name']}")
    check('keyboard: first Tab stop is the skip link', stops[:1] == ['Skip to content'], str(stops[:3]))
    check('keyboard: every Tab stop on Home shows a focus indicator', not no_ring, str(no_ring[:8]))
    check('keyboard: Tab reaches the nav, the person menu, the theme switch and the message box', all(any(k in x for x in stops) for k in ['Jira Stories', 'Nabih Ben Lagha', 'Switch to dark theme', 'Message']), str(stops))

    # Skip link moves focus into the page content.
    pg.goto(BASE + '/')
    pg.wait_for_selector('.entry a', timeout=15000)
    pg.keyboard.press('Tab')
    pg.keyboard.press('Enter')
    check('keyboard: skip link moves focus to the page content', pg.evaluate("() => { const e = document.activeElement; return !!e?.closest('main') && !e.closest('header') && !e.closest('.sidebar'); }"))

    # Nav by keyboard: focus the Jira Stories link and follow it.
    pg.focus('.nav a[href="/tickets"]')
    pg.keyboard.press('Enter')
    pg.wait_for_url(re.compile(r'/tickets'), timeout=10000)
    pg.wait_for_selector('table.tickets tbody tr', timeout=15000)
    check('keyboard: sidebar link opens Jira Stories', '/tickets' in pg.url)

    # Ask from the composer with the keyboard only, then rate and approve.
    pg.goto(BASE + '/')
    pg.wait_for_selector('.composer textarea')
    pg.focus('.composer textarea')
    pg.keyboard.type('Is IBGM-1008 ready for UAT?')
    pg.keyboard.press('Enter')
    pg.wait_for_url(re.compile(r'/chat/[0-9a-f-]+'), timeout=15000)
    pg.wait_for_function("() => /Rate this answer/.test(document.querySelector('.msgactions')?.innerText || '')", timeout=20000)
    pg.focus('.rate input[type=radio] >> nth=0')
    for _ in range(4): pg.keyboard.press('ArrowRight')
    pg.keyboard.press('Space')
    pg.wait_for_function("() => /Rated 5 of 5/.test(document.querySelector('.msgactions')?.innerText || '')", timeout=10000)
    check('keyboard: rate five stars with arrows and Space', 'Rated 5 of 5' in pg.inner_text('.msgactions'))
    approve = pg.locator('.approve .actions .btn.ink').first
    if approve.count():
        approve.focus()
        pg.keyboard.press('Enter')
        pg.wait_for_selector('.approve .outcome, .approve .pill', timeout=15000)
        check('keyboard: approve with Enter', 'Approved' in pg.inner_text('.approve'))

    # The person menu and the scope menu open, move and close from the keyboard.
    pg.focus('.mebtn')
    pg.keyboard.press('Enter')
    pg.wait_for_selector('[role=menuitemradio]', timeout=5000)
    pg.keyboard.press('Escape')
    pg.wait_for_timeout(200)
    check('keyboard: person menu opens with Enter, Escape closes and returns focus', pg.locator('[role=menuitemradio]').count() == 0 and pg.evaluate("() => document.activeElement?.classList.contains('mebtn')"))
    pg.focus('header .scope.pick')
    pg.keyboard.press('Enter')
    pg.wait_for_selector('[role=menuitemradio]', timeout=5000)
    pg.keyboard.press('ArrowDown')
    focused_item = pg.evaluate("() => document.activeElement?.getAttribute('role')")
    pg.keyboard.press('Escape')
    check('keyboard: scope menu items take arrow-key focus', focused_item == 'menuitemradio', str(focused_item))

    # Theme toggle. The scope menu returns focus to its button a moment after Escape; wait for that first,
    # or it lands after we focus the theme switch and Enter reopens the menu (the cause of the earlier flake).
    pg.wait_for_function("() => !document.querySelector('[role=menuitemradio]') && document.activeElement?.matches('header .scope.pick')", timeout=5000)
    pg.focus('header button[aria-label^="Switch to dark"]')
    pg.keyboard.press('Enter')
    # The theme applies on the next render; wait for it instead of reading it in the same tick (was flaky under load).
    try:
        pg.wait_for_function("() => document.documentElement.dataset.theme === 'dark'", timeout=3000)
    except Exception:
        pass
    check('keyboard: theme toggles with Enter', pg.evaluate("() => document.documentElement.dataset.theme") == 'dark')

    # Hexa tabs: arrow keys move between tabs.
    pg.goto(BASE + '/hexa?tab=manual')
    pg.wait_for_selector('.tabs [role=tab]', timeout=15000)
    pg.focus('.tabs [role=tab][aria-selected=true]')
    pg.keyboard.press('ArrowRight')
    pg.wait_for_timeout(300)
    check('keyboard: Hexa tabs move with ArrowRight', 'tab=automated' in pg.url or pg.evaluate("() => document.activeElement?.innerText.includes('Automated')"), pg.url)

    # Every Tab stop on the chat page with its report shows focus.
    pg.goto(chat_url)
    pg.wait_for_selector('.panel', timeout=15000)
    settle(pg)
    no_ring = []
    for _ in range(60):
        pg.keyboard.press('Tab')
        f = pg.evaluate(focus_info)
        if f and (not f['ring'] or not f['visible']): no_ring.append(f"{f['tag']} {f['name']}")
    check('keyboard: every Tab stop in a chat with a report shows a focus indicator', not no_ring, str(no_ring[:8]))
    pg.context.close()
    browser.close()

print('\naxe serious+critical by page (rules, nodes):')
for label, n, nodes in summary:
    print(f'  {label}: {n} rules, {nodes} nodes')
bad = [c for c in checks if not c[1]]
print(f'\n{len(checks) - len(bad)} of {len(checks)} checks passed; console errors: {json.dumps(errors[:5]) if errors else "none"}')
sys.exit(1 if bad or errors else 0)
