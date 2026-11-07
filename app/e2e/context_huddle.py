"""F11: App Context and Huddle are server-backed. Sources come from the repositories' documentation; uploads are
read or honestly 'kept, not readable'; a reported conflict excludes passages until an owner decides in Huddle;
answers cite App Context passages with links that land on the passage."""
import json, os, re, sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get('E2E_BASE', 'http://127.0.0.1:5199')
checks = []
def check(name, ok, detail=''):
    checks.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail and not ok else ''))

def sign_in(page, name):
    page.click('.mebtn'); page.click(f'[role=menuitemradio]:has-text("{name}")'); page.wait_for_timeout(700)

errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_context(viewport={'width': 1360, 'height': 900}).new_page()
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and '404' not in m.text else None)
    page.goto(BASE + '/')
    page.wait_for_selector('.mebtn')
    sign_in(page, 'Mohd Sayeer')

    # 1. App Context lists real sources, says what is not connected, no simulated processing.
    page.goto(BASE + '/context')
    page.wait_for_selector('.dt tbody tr .srclink', timeout=15000)
    body = page.inner_text('.page')
    check('connectors shown as not connected / none', 'not connected' in body and 'Knowledge Fabric: none' in body)
    check('no fake Fabric version or embedding step', 'v14' not in body and 'Embedding' not in body)
    rows = page.locator('.dt tbody tr')
    titles = [rows.nth(i).locator('.srclink').inner_text() for i in range(rows.count())]
    check('repository and Jira sources listed', any(t == 'piggymetrics' for t in titles) and any(t.startswith('Jira') for t in titles), str(titles))
    check('Confluence add form replaced by a not-connected state', page.locator('.linkbox .callout').count() == 1 and page.locator('.linkbox input[type=url]').count() == 0)

    # 2. The repository source has passages from its documentation.
    page.click('.dt tbody tr .srclink:text-is("piggymetrics")')
    page.wait_for_selector('.panel [role=tab]:has-text("Passages")', timeout=15000)
    page.click('.panel [role=tab]:has-text("Passages")')
    page.wait_for_selector('.panel .chunk')
    n_chunks = page.locator('.panel .chunk').count()
    check('repository passages come from README/docs', n_chunks > 0 and 'README' in page.inner_text('.panel .chunk header'), str(n_chunks))

    # 3. Test a question against the context.
    page.click('.panel [role=tab]:has-text("Test a question")')
    page.fill('.panel input[type=search]', 'How do I run the application with docker compose?')
    page.click('.panel form button[type=submit]')
    page.wait_for_selector('.panel .chunk, .panel p.muted', timeout=15000)
    check('test a question returns ranked passages with keyword relevance', 'relevance' in page.inner_text('.panel').lower() and 'not correctness' in page.inner_text('.panel'))

    # 4. Upload a readable file and an unreadable one.
    page.goto(BASE + '/context')
    page.wait_for_selector('.dz input[type=file]', state='attached', timeout=15000)
    page.set_input_files('.dz input[type=file]', [
        {'name': 'team-notes.md', 'mimeType': 'text/markdown', 'buffer': b'# Team notes\n\nThe statistics service recalculates account statistics nightly at 02:00 UTC and keeps 400 days of history.'},
        {'name': 'arch.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF-1.4 fake'},
    ])
    page.wait_for_function("() => document.querySelector('.dt')?.innerText.includes('team-notes.md') && document.querySelector('.dt')?.innerText.includes('arch.pdf')", timeout=20000)
    table = page.inner_text('.dt')
    check('markdown upload is Ready with passages', 'team-notes.md' in table and '1 passage' in table)
    check('PDF upload is kept, not readable (never processed)', 'arch.pdf' in table and 'Kept, not readable' in table and 'not available in this build' in table)

    # 5. Report a conflict against the repository; it goes to Huddle and the passages are excluded.
    page.click('.dt tbody tr .srclink:text-is("team-notes.md")')
    page.wait_for_selector('.panel [role=tab]:has-text("Report a conflict")', timeout=15000)
    page.click('.panel [role=tab]:has-text("Report a conflict")')
    page.fill('.panel input[placeholder="Refund window: 60 or 45 days?"]', 'History retention: 400 or 365 days?')
    page.fill('.panel input[placeholder="60 days"]', '400 days')
    page.fill('.panel input[placeholder="45 days"]', '365 days')
    page.click('.panel button:has-text("Send to Huddle")')
    page.wait_for_url(re.compile(r'/huddle/hd-'), timeout=15000)
    page.wait_for_selector('.panel .options label', timeout=15000)
    check('conflict opens a Huddle item with two options', page.locator('.panel .options label').count() == 2)
    check('member cannot decide (no Decide button)', page.locator('.decidebox button:has-text("Decide")').count() == 0)
    page.click('.panel .options label:nth-child(2) input')
    page.wait_for_function("() => /1 vote/.test(document.querySelector('.panel .options')?.innerText || '')", timeout=10000)
    check('vote is recorded', '1 vote' in page.inner_text('.panel .options'))
    page.fill('.panel .replyform textarea', 'Product confirmed 400 days last sprint.')
    page.click('.panel .replyform button')
    page.wait_for_function("() => /Product confirmed 400 days/.test(document.querySelector('.panel')?.innerText || '')", timeout=10000)
    check('comment is recorded with its author', 'Mohd Sayeer' in page.inner_text('.panel .comment'))
    item_url = page.url

    page.goto(BASE + '/context')
    page.wait_for_selector('.conflict', timeout=15000)
    check('App Context shows the open conflict and the source needs review', 'History retention' in page.inner_text('.conflict') and 'Needs review' in page.inner_text('.dt'))

    # 6. The owner decides; the decision is applied and persists.
    sign_in(page, 'Nabih Ben Lagha')
    page.goto(item_url)
    page.wait_for_selector('.decidebox button:has-text("Decide")', timeout=15000)
    page.click('.decidebox button:has-text("Decide")')
    page.click('.decideform .radio:nth-child(2) input')
    page.fill('.decideform textarea', 'Product confirmed the retention is 400 days.')
    page.click('.decideform button:has-text("Confirm decision")')
    page.wait_for_selector('.panel .decision', timeout=15000)
    check('decision recorded with reason and owner', 'Nabih Ben Lagha' in page.inner_text('.panel .decision') and '400 days' in page.inner_text('.panel .decision'))
    page.reload()
    page.wait_for_selector('.panel .decision', timeout=15000)
    check('decision survives a reload', 'Decided' in page.inner_text('.panel'))
    page.goto(BASE + '/context')
    page.wait_for_selector('.dt tbody tr .srclink', timeout=15000)
    page.wait_for_function("() => !document.querySelector('.conflict')", timeout=10000)
    row = page.locator('.dt tbody tr', has_text='team-notes.md').inner_text()
    check('conflict gone from App Context; source back to Ready', 'Needs review' not in row and 'Ready' in row, row)

    # 7. An answer cites an App Context passage with a link that lands on the passage.
    page.goto(BASE + '/')
    page.wait_for_selector('.composer textarea')
    page.fill('.composer textarea', 'When are account statistics recalculated and how long is history kept?')
    page.keyboard.press('Enter')
    page.wait_for_selector('.turn .msgactions', timeout=20000)
    cites = page.locator('.thread a.cite')
    check('answer carries a clickable App Context citation', cites.count() >= 1 and (cites.first.get_attribute('href') or '').startswith('/context/source/'), str(cites.count()))
    if cites.count():
        href = cites.first.get_attribute('href')
        cites.first.click()
        page.wait_for_selector('.panel .chunk.target', timeout=15000)
        check('citation lands on the cited passage', page.locator('.panel .chunk.target').count() == 1, href)
    b.close()

bad = [c for c in checks if not c[1]]
print(f'\n{len(checks) - len(bad)} of {len(checks)} checks passed; console errors: {json.dumps(errors[:5]) if errors else "none"}')
sys.exit(1 if bad or errors else 0)
