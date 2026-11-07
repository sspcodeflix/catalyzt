"""Phase 3 browser smoke: persistence, reload hydration, rating gate, approvals, isolation.
Runs against the throwaway server on 127.0.0.1:5199 (IBGM has stories and manual tests)."""
import json, re, sys, time
from playwright.sync_api import sync_playwright

import os
BASE = os.environ.get('E2E_BASE', 'http://127.0.0.1:5199')
checks = []
def check(name, ok, detail=''):
    checks.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail and not ok else ''))

console_errors, failed_requests = [], []

def sign_in(page, name):
    page.click('.mebtn')
    page.click(f'[role=menuitemradio]:has-text("{name}")')
    page.wait_for_timeout(600)
    page.wait_for_function("() => !document.querySelector('[aria-busy=\"true\"]')", timeout=10000)

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 1360, 'height': 900})
    page = ctx.new_page()
    # A 404 for a chat of another application is the correct answer and is logged by the browser as a failed resource load.
    page.on('console', lambda m: console_errors.append(m.text) if m.type == 'error' and '404' not in m.text else None)
    page.on('requestfailed', lambda r: failed_requests.append(r.url) if '/api/chats/' not in r.url else None)
    page.on('response', lambda r: failed_requests.append(f'{r.status} {r.url}') if r.status >= 500 else None)

    page.goto(BASE + '/')
    page.wait_for_selector('.mebtn')
    sign_in(page, 'Mohd Sayeer')
    check('signed in as Sayeer', 'Sayeer' in page.inner_text('.mebtn'))

    # 1. Start a UAT analysis from Jira Stories.
    page.goto(BASE + '/tickets')
    page.wait_for_selector('table.tickets tbody tr .tlink')
    first_key = page.inner_text('table.tickets tbody tr:first-child .tlink .mono').strip()
    page.click('table.tickets tbody tr:first-child button.btn.small')
    page.wait_for_url(re.compile(r'/chat/[0-9a-f-]+/artifact/uat-'), timeout=15000)
    chat_url = page.url
    chat_id = re.search(r'/chat/([0-9a-f-]+)', chat_url).group(1)
    page.wait_for_selector('.msgactions', timeout=20000)
    page.wait_for_function("() => /Rate this answer|cannot be rated/.test(document.querySelector('.msgactions')?.innerText || '')", timeout=20000)
    check('answer finished and was saved (rating offered)', 'Rate this answer' in page.inner_text('.msgactions'))
    check('artifact panel shows the UAT report', first_key in page.inner_text('.panel .phead'))
    approvals_before = page.locator('.approve').count()

    # 2. Reload: the chat hydrates from the server with its artifact.
    page.reload()
    page.wait_for_selector('.turn .msgactions', timeout=15000)
    check('after reload: user message is back', f'Is {first_key} ready for UAT?' in page.inner_text('.thread'))
    check('after reload: artifact panel renders', first_key in page.inner_text('.panel .phead'))
    check('after reload: no API placeholder text', 'will load from the API' not in page.inner_text('.thread'))
    check('after reload: rating still offered', 'Rate this answer' in page.inner_text('.msgactions'))
    check('after reload: approvals still there', page.locator('.approve').count() == approvals_before, f'{approvals_before} -> {page.locator(".approve").count()}')

    # 3. Approval is locked until rated; a low rating needs feedback.
    if approvals_before:
        btn = page.locator('.approve .actions .btn.ink').first
        check('approve button locked before rating', btn.is_disabled())
        check('lock reason shown', 'Rate the answer' in page.inner_text('.approve .gatehint'))
    page.click('.rate label.star:nth-child(3)')  # 2 stars (legend is the first child)
    page.wait_for_selector('form.feedback')
    page.click('form.feedback button[type=submit]')
    check('feedback form blocks an empty submission', page.locator('form.feedback .errtext').count() > 0)
    page.click('form.feedback .check:first-child input')
    page.fill('form.feedback textarea', f'I expected the evidence to name the manual tests linked to {first_key}.')
    page.click('form.feedback button[type=submit]')
    page.wait_for_function("() => /Rated 2 of 5/.test(document.querySelector('.msgactions')?.innerText || '')", timeout=10000)
    check('low rating stored after feedback', 'Rated 2 of 5' in page.inner_text('.msgactions'))
    page.reload()
    page.wait_for_selector('.turn .msgactions', timeout=15000)
    check('rating survives a reload', 'Rated 2 of 5' in page.inner_text('.msgactions'))

    # 4. Approve: the server executes and reports the outcome.
    if approvals_before:
        btn = page.locator('.approve .actions .btn.ink').first
        check('approve button unlocked after rating', not btn.is_disabled())
        btn.click()
        page.wait_for_selector('.approve .outcome', timeout=15000)
        out = page.inner_text('.approve .outcome')
        check('approval outcome reports added tests', 'Added' in out and 'manual test' in out, out)
        check('approval shows who approved', 'Approved by Mohd Sayeer' in page.inner_text('.approve .foot'))
        page.reload()
        page.wait_for_selector('.approve', timeout=15000)
        check('approval state survives a reload', 'Approved by' in page.inner_text('.approve .foot'))
        page.goto(BASE + '/hexa?tab=manual')
        page.wait_for_timeout(1500)
        check('Hexa lists the UAT case as a manual test', f'UAT-{first_key}-' in page.inner_text('body'))
        page.goto(chat_url)
        page.wait_for_selector('.turn .msgactions', timeout=15000)

    # 5. Recents and search know the chat.
    check('sidebar recents list the chat', page.locator(f'.recent[href="/chat/{chat_id}"]').count() == 1)

    # 6. A teammate reads it but cannot add; another application sees nothing.
    sign_in(page, 'Nabih Ben Lagha')
    page.goto(chat_url)
    page.wait_for_selector('.turn .msgactions, .emptystate', timeout=15000)
    check('owner of the same application can read the chat', first_key in page.inner_text('.thread'))
    check('teammate sees the read-only note, no composer', 'Started by Mohd Sayeer' in page.inner_text('.composerwrap') and page.locator('.composer textarea').count() == 0)
    sign_in(page, 'Ram Kumar')
    page.goto(chat_url)
    page.wait_for_selector('.emptystate, .turn', timeout=15000)
    check('another application gets "does not exist" (not disclosed)', "doesn't exist in this application" in page.inner_text('.thread'))
    check('no secret or foreign content shown', first_key not in page.inner_text('.thread'))

    # 7. A secret is rejected and never kept; the chat title is "Message removed".
    sign_in(page, 'Mohd Sayeer')
    page.goto(BASE + '/')
    page.wait_for_selector('.composer textarea')
    page.fill('.composer textarea', 'my key is AKIAABCDEFGHIJKLMNOP')
    page.keyboard.press('Enter')
    page.wait_for_selector('.rejected', timeout=15000)
    page.wait_for_function("() => /Rate|cannot be rated/.test(document.querySelector('.msgactions')?.innerText || '')", timeout=15000)
    check('secret rejected by the input guard', 'Secret in the message' in page.inner_text('.rejected'))
    check('secret not shown on screen', 'AKIAABCDEFGHIJKLMNOP' not in page.inner_text('.thread'))
    page.reload()
    page.wait_for_selector('.turn', timeout=15000)
    check('after reload: removed message placeholder, no secret', 'Message removed' in page.inner_text('.thread') and 'AKIAABCDEFGHIJKLMNOP' not in page.inner_text('body'))

    browser.close()

bad = [c for c in checks if not c[1]]
print(f'\n{len(checks) - len(bad)} of {len(checks)} checks passed')
print('console errors:', json.dumps(console_errors[:10], indent=1) if console_errors else 'none')
print('failed requests:', json.dumps(failed_requests[:10], indent=1) if failed_requests else 'none')
sys.exit(1 if bad or console_errors else 0)
