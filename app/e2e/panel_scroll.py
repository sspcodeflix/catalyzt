"""List pages with a side panel scroll like the chat: on a wide screen the list and the panel each scroll
on their own, the page does not, the panel's title bar stays visible, and a passage link lands in view."""
import json, os, sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get('E2E_BASE', 'http://127.0.0.1:5199')
checks = []
def check(name, ok, detail=''):
    checks.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail and not ok else ''))

def metrics(page):
    return page.evaluate("""() => {
      const l = document.querySelector('.body.panelpage > .listcol'), p = document.querySelector('.body.panelpage > .panel');
      return { doc: document.scrollingElement.scrollHeight, win: window.innerHeight,
               list: l && { sh: l.scrollHeight, ch: l.clientHeight }, panel: p && { sh: p.scrollHeight, ch: p.clientHeight } };
    }""")

errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_context(viewport={'width': 1360, 'height': 640}).new_page()
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.goto(BASE + '/')
    page.wait_for_selector('.mebtn')
    page.click('.mebtn')
    page.click('[role=menuitemradio]:has-text("Mohd Sayeer")')
    page.wait_for_timeout(400)

    # Jira Stories with a story open.
    page.goto(BASE + '/tickets')
    page.wait_for_selector('table tbody tr, .dt tbody tr', timeout=15000)
    first = page.locator('a[href^="/tickets/IBGM-"]').first
    first.click()
    page.wait_for_selector('.panel .phead')
    m = metrics(page)
    check('Jira: the page itself does not scroll', m['doc'] <= m['win'] + 1, json.dumps(m))
    check('Jira: the story list scrolls on its own', m['list'] and m['list']['sh'] > m['list']['ch'], json.dumps(m))
    page.evaluate("() => document.querySelector('.body.panelpage > .listcol').scrollTo({ top: 99999 })")
    check('Jira: scrolling the list leaves the panel open and in view', page.evaluate("() => { const r = document.querySelector('.panel .phead').getBoundingClientRect(); return r.top >= 0 && r.top < 200; }"))

    # App Context with a long source open.
    page.goto(BASE + '/context')
    page.wait_for_selector('.dt tbody tr .srclink', timeout=15000)
    page.click('.dt tbody tr .srclink:text-is("piggymetrics")')
    page.wait_for_selector('.panel [role=tab]:has-text("Passages")', timeout=15000)
    page.click('.panel [role=tab]:has-text("Passages")')
    page.wait_for_selector('.panel .chunk')
    m = metrics(page)
    check('App Context: the page itself does not scroll', m['doc'] <= m['win'] + 1, json.dumps(m))
    check('App Context: the source panel scrolls on its own', m['panel'] and m['panel']['sh'] > m['panel']['ch'] + 200, json.dumps(m))
    page.evaluate("() => document.querySelector('.body.panelpage > .panel').scrollTo({ top: 3000 })")
    page.wait_for_timeout(150)
    check('App Context: the panel title bar stays at the top while it scrolls', page.evaluate("() => { const r = document.querySelector('.panel .phead').getBoundingClientRect(); const pr = document.querySelector('.panel').getBoundingClientRect(); return Math.abs(r.top - pr.top) < 2; }"))
    check('App Context: the close button stays reachable', page.locator('.panel .phead [aria-label="Close panel"]').is_visible())
    # A passage link lands on its passage inside the panel.
    page.goto(BASE + '/context/source/IBGM-repo-piggymetrics#chunk-20')
    page.wait_for_selector('#chunk-20', timeout=15000)
    try:
        page.wait_for_function("() => { const r = document.getElementById('chunk-20').getBoundingClientRect(); const h = document.querySelector('.panel .phead').getBoundingClientRect(); return r.top >= h.bottom - 1 && r.top < window.innerHeight; }", timeout=5000)
        landed = True
    except Exception:
        landed = False
    check('App Context: a passage link scrolls the panel to the passage, below the title bar', landed, str(page.evaluate("() => document.getElementById('chunk-20').getBoundingClientRect().top")))

    # Phone keeps scrolling the page as a whole (list, then panel).
    phone = b.new_context(viewport={'width': 390, 'height': 844}).new_page()
    phone.goto(BASE + '/context')
    phone.wait_for_selector('.mebtn', state='attached')
    pm = phone.evaluate("() => ({ sw: document.scrollingElement.scrollWidth })")
    check('phone: no sideways scroll on App Context', pm['sw'] <= 391, json.dumps(pm))
    b.close()

bad = [c for c in checks if not c[1]]
print(f'\n{len(checks) - len(bad)} of {len(checks)} checks passed; console errors: {json.dumps(errors[:5]) if errors else "none"}')
sys.exit(1 if bad or errors else 0)
