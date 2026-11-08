"""F16: the mobile drawer is modal: focus moves in, Tab stays inside, Escape closes and restores focus, background is inert."""
import json, sys
from playwright.sync_api import sync_playwright

import os
BASE = os.environ.get('E2E_BASE', 'http://127.0.0.1:5199')
checks = []
def check(name, ok, detail=''):
    checks.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail and not ok else ''))

errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_context(viewport={'width': 390, 'height': 844}).new_page()
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.goto(BASE + '/tickets')
    page.wait_for_selector('button[aria-label="Open sidebar"]')
    page.focus('button[aria-label="Open sidebar"]')
    page.keyboard.press('Enter')
    page.wait_for_selector('.sidebar.open')
    active = page.evaluate("() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent")
    check('focus moves to the drawer close button', active == 'Close sidebar', active)
    check('drawer is a modal dialog', page.get_attribute('.sidebar', 'role') == 'dialog' and page.get_attribute('.sidebar', 'aria-modal') == 'true')
    check('background is inert', page.evaluate("() => document.querySelector('main').hasAttribute('inert')"))
    inside = True
    for _ in range(40):
        page.keyboard.press('Tab')
        if not page.evaluate("() => document.querySelector('.sidebar').contains(document.activeElement)"):
            inside = False
            break
    check('40 Tabs stay inside the drawer', inside)
    for _ in range(3):
        page.keyboard.press('Shift+Tab')
    check('Shift+Tab stays inside too', page.evaluate("() => document.querySelector('.sidebar').contains(document.activeElement)"))
    page.keyboard.press('Escape')
    page.wait_for_function("() => !document.querySelector('.sidebar.open')")
    check('Escape closes the drawer', True)
    check('focus returns to the menu button', page.evaluate("() => document.activeElement?.getAttribute('aria-label')") == 'Open sidebar')
    check('background is no longer inert', not page.evaluate("() => document.querySelector('main').hasAttribute('inert')"))
    # Navigating from the drawer closes it and leaves focus somewhere sensible (not lost behind).
    page.click('button[aria-label="Open sidebar"]')
    page.wait_for_selector('.sidebar.open')
    page.click('.sidebar .nav a[href="/hexa"]')
    page.wait_for_function("() => !document.querySelector('.sidebar.open')")
    check('navigation closes the drawer', page.url.endswith('/hexa'))
    # F16: crossing to the desktop layout while the drawer is open closes it, so the page is usable again.
    page.click('button[aria-label="Open sidebar"]')
    page.wait_for_selector('.sidebar.open')
    page.set_viewport_size({'width': 1200, 'height': 800})
    page.wait_for_function("() => !document.querySelector('.sidebar.open')", timeout=5000)
    check('widening to desktop closes the drawer', True)
    check('main is not inert after widening', not page.evaluate("() => document.querySelector('main').hasAttribute('inert')"))
    b.close()

bad = [c for c in checks if not c[1]]
print(f'\n{len(checks) - len(bad)} of {len(checks)} checks passed; console errors: {json.dumps(errors[:5]) if errors else "none"}')
sys.exit(1 if bad else 0)
