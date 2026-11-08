"""IBGM review items in the browser: passage Markdown and build files (R19, R20), the Jira Stories badge
(R14), the pipeline runs header (R11), link undo in Hexa (R08), the scan-only caveat in a UAT report (R24)
and no stale-facts note on a fresh answer (R04). Runs against the throwaway server of run.sh."""
import base64, json, os, re, sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get('E2E_BASE', 'http://127.0.0.1:5199')
checks = []
def check(name, ok, detail=''):
    checks.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail and not ok else ''))

def sign_in(page, name):
    page.click('.mebtn'); page.click(f'[role=menuitemradio]:has-text("{name}")'); page.wait_for_timeout(700)

USERS = {'Mohd Sayeer': 'u-sayeer', 'Karim': 'u-karim'}
def api(ctx, who, method, path, body=None):
    headers = {'x-horizon-user': USERS[who], 'x-horizon-app': 'IBGM', 'Content-Type': 'application/json'}
    r = ctx.request.fetch(BASE + path, method=method, headers=headers, data=json.dumps(body) if body is not None else None)
    try:
        return r.status, r.json()
    except Exception:
        return r.status, None

errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1360, 'height': 900})
    page = ctx.new_page()
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and '404' not in m.text else None)
    page.goto(BASE + '/')
    page.wait_for_selector('.mebtn')
    sign_in(page, 'Mohd Sayeer')

    # R19, R20: the repository source reads build files too, and its passages render Markdown tables.
    page.goto(BASE + '/context')
    page.wait_for_selector('.dt tbody tr .srclink', timeout=15000)
    row = page.locator('.dt tbody tr', has_text='piggymetrics').first.inner_text()
    check('R19: repository row says documentation and build files were read', re.search(r'passages from \d+ documentation files? and \d+ build files?', row) is not None, row)
    page.goto(BASE + '/context/source/IBGM-repo-piggymetrics')
    page.wait_for_selector('.panel [role=tab]:has-text("Passages")', timeout=15000)
    page.click('.panel [role=tab]:has-text("Passages")')
    page.wait_for_selector('.panel .chunk')
    check('R20: a README table renders as a table with a header row', page.locator('.panel .chunk .passage-table table th').count() >= 3)
    raw = page.inner_text('.panel')
    check('R20: no raw table separator on screen', not re.search(r'\|\s*:?-{3,}', raw))
    check('R19: build files are passages, shown as written', page.locator('.panel .chunk pre.passage-pre').count() > 0 and 'pom.xml' in raw)

    # R14: one badge count with a label saying what it counts, the same on Home and on a UAT chat.
    page.goto(BASE + '/')
    badge = page.locator('.nav a[href="/tickets"] .navcount')
    try:
        badge.wait_for(timeout=15000)
    except Exception:
        pass
    home_n = badge.inner_text().strip() if badge.count() else '0'
    label = (badge.get_attribute('title') or '') if badge.count() else ''
    check('R14: badge says what it counts', 'in the Jira filter not analysed for UAT yet' in label and label == badge.get_attribute('aria-label'), label)

    # R24: a Juice Shop story (scan-only repository) says automated evidence cannot arrive.
    st, stories = api(ctx, 'Mohd Sayeer', 'GET', '/api/stories')
    juice = next((s['key'] for s in (stories or {}).get('stories', []) if 'customer-portal' in s.get('components', [])), None)
    if juice:
        page.goto(BASE + f'/tickets/{juice}')
        page.wait_for_selector('.panel button:has-text("UAT")', timeout=15000)
        page.click('.panel button:has-text("UAT")')
        page.wait_for_url(re.compile(r'/chat/[0-9a-f-]+/artifact/uat-'), timeout=20000)
        page.wait_for_function("() => /Rate this answer|cannot be rated/.test(document.querySelector('.msgactions')?.innerText || '')", timeout=30000)
        check('R24: scan-only caveat in the answer', 'scanned through GitHub only' in page.inner_text('.thread'))
        check('R24: scan-only flag in the report header', 'scan-only repository' in page.inner_text('.panel .phead'))
        page.wait_for_timeout(500)
        chat_n = badge.inner_text().strip() if badge.count() else '0'
        page.goto(BASE + '/')
        page.wait_for_selector('.composer textarea')
        page.wait_for_timeout(800)
        after_n = badge.inner_text().strip() if badge.count() else '0'
        check('R14: badge is the same on the UAT chat and on Home', chat_n == after_n, f'chat {chat_n}, home {after_n} (before {home_n})')
    else:
        check('R24: IBGM has a customer-portal story', False, 'none found')

    # R04: a fresh answer about a component carries no stale-facts note.
    page.goto(BASE + '/')
    page.wait_for_selector('.composer textarea')
    page.fill('.composer textarea', 'Which tests cover account-service?')
    page.keyboard.press('Enter')
    page.wait_for_selector('.turn .msgactions', timeout=30000)
    check('R04: no stale-facts note on an answer written now', page.locator('.stalenote').count() == 0)

    # R11: the runs header names the sources of the runs listed.
    xml = '<testsuite name="com.piggymetrics.account.AccountServiceTest" tests="1"><testcase classname="com.piggymetrics.account.AccountServiceTest" name="shouldFindByName" time="0.1"/></testsuite>'
    st, _ = api(ctx, 'Mohd Sayeer', 'POST', '/api/hexa/results/upload', {'files': [{'filename': 'TEST-e2e.xml', 'contentBase64': base64.b64encode(xml.encode()).decode()}], 'repo': 'sqshq/piggymetrics'})
    page.goto(BASE + '/hexa?tab=runs')
    page.wait_for_selector('.runsources', timeout=15000)
    head = page.inner_text('.runsources')
    check('R11: runs header counts the uploaded run and does not call it a GitHub Actions merge', 'uploaded' in head and 'GitHub Actions' not in head, head)
    check('R11: the GitHub Actions box is labelled as a collector', 'Collect from GitHub Actions' in page.inner_text('.scanbox'))

    # R08: link, undo; unlink, undo; the unlink control is a named target of at least 24 px.
    st, tests = api(ctx, 'Mohd Sayeer', 'GET', '/api/hexa/tests?kind=manual&limit=5')
    rows = (tests or {}).get('rows', [])
    t = next((r for r in rows if not any(l['type'] == 'component' and l['ref'].endswith('/gateway') for l in r['links'])), None)
    if t:
        page.goto(BASE + f'/hexa/test/{t["id"]}?tab=manual')
        page.wait_for_selector('.linkform select', timeout=15000)
        page.select_option('.linkform select >> nth=0', 'component')
        page.select_option('.linkform select >> nth=1', 'gateway')
        page.click('.linkform button[type=submit]')
        page.wait_for_selector('.linkundo:has-text("Linked gateway")', timeout=10000)
        check('R08: a link shows "Linked gateway · Undo"', 'Undo' in page.inner_text('.linkundo'))
        page.wait_for_selector('.covers .linkpill:has-text("gateway")')
        page.click('.linkundo button:has-text("Undo")')
        page.wait_for_function("() => ![...document.querySelectorAll('.covers .linkpill')].some((e) => e.innerText.includes('gateway'))", timeout=10000)
        check('R08: undo removes the link it made', page.locator('.covers .linkpill', has_text='gateway').count() == 0)
        x = page.locator('.covers .linkpill .chipx').first
        if x.count():
            box = x.bounding_box()
            name = x.get_attribute('aria-label') or ''
            check('R08: unlink control is at least 24 px with a name', box and box['width'] >= 24 and box['height'] >= 24 and name.startswith('Unlink ') and 'from this test' in name, f'{box} {name}')
            before = page.locator('.covers .linkpill').count()
            x.click()
            page.wait_for_selector('.linkundo:has-text("Unlinked")', timeout=10000)
            page.wait_for_function(f"() => document.querySelectorAll('.covers .linkpill').length === {before - 1}", timeout=10000)
            page.click('.linkundo button:has-text("Undo")')
            page.wait_for_function(f"() => document.querySelectorAll('.covers .linkpill').length === {before}", timeout=10000)
            check('R08: undo after unlink restores the link', page.locator('.covers .linkpill').count() == before)
    else:
        check('R08: IBGM has a manual test to link', False)

    check('no console errors', not errors, '; '.join(errors[:3]))
    b.close()

failed = [n for n, ok in checks if not ok]
print(f'\n{len(checks) - len(failed)}/{len(checks)} passed')
sys.exit(1 if failed else 0)
