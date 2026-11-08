"""Recovery and race paths, driven through Playwright routes (no model key, rules routing).

F07  a lost `saved` acknowledgement (dropped, or the stream cut after `done`) is recovered by reading the chat
     back: the answer becomes ratable and the approval gets its id, without a second /api/run. A stream cut
     before `done` (what a server restart mid-answer looks like to the browser) fails honestly and Try again
     works. Stop ends the answer as Stopped and claims nothing.
F08  a chat that is "missing" for one application is found again after switching to the person of its
     application, without navigating.
F09  a rating that resolves after a retry does not mark the new revision.
F10  a slow old-scope recent-chats response does not replace the new scope's list.
F15  an upload in flight during a scope switch was sent as the old scope, and leaves no chip for the new one.

A real server restart is not exercised: run.sh owns the one server all scripts share, and without a model key
an answer completes on the server in milliseconds, so a restart cannot be landed between two events. The
browser-side effect of a restart (the stream ends before `done`) is simulated instead."""
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
    page.wait_for_timeout(600)

def blocks(body):
    return [b for b in body.split('\n\n') if b.strip()]

def ev_type(block):
    m = re.search(r'"type":"(\w+)"', block)
    return m.group(1) if m else ''

errors, runs, chat_reads, attach_posts = [], [], [], []

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_context(viewport={'width': 1360, 'height': 900}).new_page()
    # 404 (missing chat) is expected; aborted requests are what these tests do on purpose.
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and '404' not in m.text and 'ERR_' not in m.text and 'abort' not in m.text.lower() else None)
    page.on('request', lambda r: runs.append(r) if r.method == 'POST' and r.url.endswith('/api/run') else None)
    page.on('request', lambda r: chat_reads.append(r.url) if r.method == 'GET' and re.search(r'/api/chats/[0-9a-f-]+$', r.url) else None)
    page.on('request', lambda r: attach_posts.append(r) if r.method == 'POST' and r.url.endswith('/api/attachments') else None)

    page.goto(BASE + '/')
    page.wait_for_selector('.mebtn')
    # Karim manages statistics-service, the component of IBGM-1008, so he may approve its cases (F19).
    sign_in(page, 'Karim')

    def start_uat():
        """A new UAT analysis from the home composer (a new chat and a new run every time)."""
        page.goto(BASE + '/')
        page.wait_for_selector('.composer textarea')
        page.fill('.composer textarea', 'Is IBGM-1008 ready for UAT?')
        page.keyboard.press('Enter')
        page.wait_for_url(re.compile(r'/chat/[0-9a-f-]+'), timeout=15000)
        return re.search(r'/chat/([0-9a-f-]+)', page.url).group(1)

    def rewrite_run(transform):
        """Serves /api/run from the real server, with the event stream rewritten."""
        def handler(route):
            resp = route.fetch()
            route.fulfill(response=resp, body='\n\n'.join(transform(blocks(resp.text()))) + '\n\n')
        page.route('**/api/run', handler)
        return handler

    def wait_rated_state():
        page.wait_for_function("() => /Rate this answer|cannot be rated|Rated/.test(document.querySelector('.msgactions')?.innerText || '')", timeout=20000)

    # ---- F07 a: the `saved` event is dropped; everything else arrives.
    h = rewrite_run(lambda bs: [b for b in bs if ev_type(b) != 'saved'])
    runs.clear(); chat_reads.clear()
    chat_id = start_uat()
    page.wait_for_function("() => /Rate this answer/.test(document.querySelector('.msgactions')?.innerText || '')", timeout=20000)
    page.unroute('**/api/run', h)
    page.wait_for_timeout(500)
    check('F07 lost saved: answer becomes ratable', 'Rate this answer' in page.inner_text('.msgactions'))
    check('F07 lost saved: the chat was read back from the server', any(u.endswith(f'/api/chats/{chat_id}') for u in chat_reads), str(chat_reads))
    check('F07 lost saved: approval has its id (Not now enabled)', page.locator('.approve').count() > 0 and page.locator('.approve .actions .btn.plain').first.is_enabled())
    check('F07 lost saved: exactly one run, no second model call', len(runs) == 1, str(len(runs)))
    page.click('.rate label.star:nth-child(6)')  # 5 stars
    page.wait_for_function("() => /Rated 5 of 5/.test(document.querySelector('.msgactions')?.innerText || '')", timeout=10000)
    check('F07 lost saved: the recovered revision id accepts a rating', 'Rated 5 of 5' in page.inner_text('.msgactions'))
    check('F07 lost saved: approve unlocks after rating', page.locator('.approve .actions .btn.ink').first.is_enabled())

    # ---- F07 b: the stream is cut right after `done`.
    def cut_after_done(bs):
        i = next(i for i, b in enumerate(bs) if ev_type(b) == 'done')
        return bs[: i + 1]
    h = rewrite_run(cut_after_done)
    runs.clear(); chat_reads.clear()
    chat_id = start_uat()
    page.wait_for_function("() => /Rate this answer/.test(document.querySelector('.msgactions')?.innerText || '')", timeout=20000)
    page.unroute('**/api/run', h)
    page.wait_for_timeout(500)
    check('F07 cut after done: answer becomes ratable', 'Rate this answer' in page.inner_text('.msgactions'))
    check('F07 cut after done: approval has its id', page.locator('.approve .actions .btn.plain').first.is_enabled())
    check('F07 cut after done: one run only', len(runs) == 1, str(len(runs)))
    check('F07 cut after done: no error shown', page.locator('.turn .callout.bad').count() == 0)

    # ---- F07 c: the stream ends before `done` (a server restart mid-answer, as the browser sees it).
    h = rewrite_run(lambda bs: [b for b in bs if ev_type(b) not in ('answer', 'done', 'saved')][:8])
    runs.clear(); chat_reads.clear()
    chat_id = start_uat()
    page.wait_for_selector('.turn .callout.bad', timeout=20000)
    page.unroute('**/api/run', h)
    page.wait_for_timeout(800)  # a wrong recovery read would replace the error by now
    err = page.inner_text('.thread')
    check('F07 cut before done: honest failure shown and kept', page.locator('.turn .callout.bad').count() == 1 and 'connection closed before the answer finished' in err, err[:300])
    check('F07 cut before done: no rating offered', 'Rate this answer' not in page.inner_text('.msgactions'))
    check('F07 cut before done: no recovery read claimed', not any(u.endswith(f'/api/chats/{chat_id}') for u in chat_reads), str(chat_reads))
    if page.locator('.turn .callout.bad .linkbtn').count():
        page.click('.turn .callout.bad .linkbtn')  # Try again
    page.wait_for_function("() => /Rate this answer/.test(document.querySelector('.msgactions')?.innerText || '')", timeout=20000)
    check('F07 cut before done: Try again runs once more and is ratable', len(runs) == 2 and 'Rate this answer' in page.inner_text('.msgactions'), str(len(runs)))

    # ---- F07 d: Stop while the request is in flight.
    held = []
    page.route('**/api/run', lambda route: held.append(route))
    runs.clear(); chat_reads.clear()
    chat_id = start_uat()
    page.wait_for_selector('button[aria-label="Stop the answer"]', timeout=10000)
    page.click('button[aria-label="Stop the answer"]')
    page.wait_for_selector('.msgactions', timeout=10000)
    page.wait_for_timeout(500)
    thread = page.inner_text('.thread')
    check('F07 stop: the answer says Stopped', 'Stopped' in thread, thread[:300])
    check('F07 stop: no error and no rating claimed', page.locator('.turn .callout.bad').count() == 0 and 'Rate this answer' not in page.inner_text('.msgactions'))
    check('F07 stop: no recovery read', not any(u.endswith(f'/api/chats/{chat_id}') for u in chat_reads), str(chat_reads))
    check('F07 stop: composer is back to Send', page.locator('button[aria-label="Stop the answer"]').count() == 0)
    for r in held:
        try: r.abort()
        except Exception: pass
    page.unroute('**/api/run')

    # ---- F09: a rating that resolves after a retry does not mark the new revision.
    chat_id = start_uat()
    wait_rated_state()
    held = []
    page.route('**/api/answers/*/rating', lambda route: held.append(route))
    page.click('.rate label.star:nth-child(6)')
    page.wait_for_timeout(300)
    check('F09: rating request held', len(held) == 1)
    page.click('.msgactions button[aria-label="Retry"]')
    page.wait_for_function("() => /Revision 2/.test(document.querySelector('.msgactions')?.innerText || '')", timeout=20000)
    held[0].continue_()
    page.wait_for_timeout(1000)
    page.unroute('**/api/answers/*/rating')
    acts = page.inner_text('.msgactions')
    check('F09: revision 2 is not marked rated by the late response', 'Rated' not in acts, acts)
    page.reload()
    page.wait_for_selector('.turn .msgactions', timeout=15000)
    acts = page.inner_text('.msgactions')
    check('F09: after reload revision 2 is still unrated', 'Revision 2' in acts and 'Rated' not in acts, acts)

    # ---- F08: missing for another application, found after switching to the chat's application.
    chat_url = page.url
    sign_in(page, 'Ram Kumar')
    page.goto(chat_url)
    page.wait_for_selector('.emptystate', timeout=15000)
    check("F08: another application gets \"doesn't exist\"", "doesn't exist in this application" in page.inner_text('.thread'))
    chat_reads.clear()
    sign_in(page, 'Karim')  # no navigation: the same URL stays open
    page.wait_for_selector('.turn .msgactions', timeout=15000)
    check('F08: the chat loads after switching back, same URL', page.url == chat_url and 'ready for UAT' in page.inner_text('.thread'))
    check('F08: it was requested again in the new scope', any(u.endswith(f'/api/chats/{chat_id}') for u in chat_reads))

    # ---- F10: a slow old-scope recents response does not overwrite the new list.
    held, hold = [], {'user': None}
    def recents(route):
        if hold['user'] and route.request.headers.get('x-horizon-user') == hold['user']:
            held.append(route)
        else:
            route.continue_()
    page.route(re.compile(r'/api/chats$'), recents)
    sign_in(page, 'Ram Kumar')
    page.goto(BASE + '/')
    page.wait_for_selector('.composer textarea')
    hold['user'] = 'u-sayeer'
    sign_in(page, 'Mohd Sayeer')  # Sayeer's recents request is held
    sign_in(page, 'Ram Kumar')    # Ram's goes through
    page.wait_for_timeout(500)
    check('F10: the old-scope recents request was held', len(held) >= 1, str(len(held)))
    for r in held: r.continue_()
    page.wait_for_timeout(1000)
    page.unroute(re.compile(r'/api/chats$'))
    check('F10: the late response did not put the other application\'s chat in recents', page.locator(f'.recent[href="/chat/{chat_id}"]').count() == 0)
    check('F10: still signed in as Ram', 'Ram' in page.inner_text('.mebtn'))

    # ---- F15: an upload during a scope switch goes as the old scope and leaves nothing for the new one.
    sign_in(page, 'Mohd Sayeer')
    page.goto(BASE + '/')
    page.wait_for_selector('.composer textarea')
    held = []
    page.route('**/api/attachments', lambda route: held.append(route) if route.request.method == 'POST' else route.continue_())
    attach_posts.clear()
    page.set_input_files('input[type=file]', [{'name': 'race.md', 'mimeType': 'text/markdown', 'buffer': b'# Race\nUploaded during a switch.'}])
    page.wait_for_timeout(400)
    sign_in(page, 'Ram Kumar')
    for r in held: r.continue_()
    page.wait_for_timeout(1000)
    page.unroute('**/api/attachments')
    users = [r.headers.get('x-horizon-user') for r in attach_posts]
    check('F15: the upload was sent as the person who chose the file', users == ['u-sayeer'], str(users))
    check('F15: the new person\'s composer has no chip', page.locator('.itemchip').count() == 0)

    browser.close()

bad = [c for c in checks if not c[1]]
print(f'\n{len(checks) - len(bad)} of {len(checks)} checks passed; console errors: {json.dumps(errors[:5]) if errors else "none"}')
sys.exit(1 if bad or errors else 0)
