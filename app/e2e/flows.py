"""Test flows in the browser (docs/FLOWS.md): Ram starts a UAT flow from Jira stories, the analysis
runs in the background, Sourav sees the same flow and what waits on him, the story opens with its
criteria, regression starts from the application's coverage, Home and the nav show the flow, and the
pages fit a phone. Runs against the throwaway server of run.sh."""
import json, os, re, sys, time
from playwright.sync_api import sync_playwright

BASE = os.environ.get('E2E_BASE', 'http://127.0.0.1:5199')
checks = []
def check(name, ok, detail=''):
    checks.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail and not ok else ''))

def sign_in(page, name):
    page.click('.mebtn'); page.click(f'[role=menuitemradio]:has-text("{name}")'); page.wait_for_timeout(700)

def api(ctx, user, method, path, body=None):
    headers = {'x-horizon-user': user, 'x-horizon-app': 'ABCD', 'Content-Type': 'application/json'}
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
    # net::ERR_FAILED comes from the outage this script simulates on purpose.
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and '404' not in m.text and 'ERR_FAILED' not in m.text else None)
    page.goto(BASE + '/')
    page.wait_for_selector('.mebtn')
    sign_in(page, 'Ram Kumar')

    # The nav has Test flows; nothing runs yet.
    page.goto(BASE + '/flows')
    page.wait_for_selector('.flowempty', timeout=15000)
    check('nav: Test flows is in the Testing group', page.locator('.nav a[href="/flows"]').count() == 1)
    check('list: says no flow is running', 'No flow is running' in page.inner_text('.flowempty'))

    # Start a UAT flow with two stories from the Ready for UAT filter.
    page.click('a:has-text("Start a test flow")')
    page.wait_for_selector('.flowpick li label', timeout=15000)
    boxes = page.locator('.flowpick li input[type=checkbox]')
    check('start: stories are listed to choose from', boxes.count() >= 2, str(boxes.count()))
    # Two stories assigned to Sourav, so his review covers both (and can approve them together).
    keys = ['ABCD-1002', 'ABCD-1005']
    for k in keys:
        page.locator(f'.flowpick li:has(.mono:text-is("{k}")) input[type=checkbox]').check()
    page.fill('.flowtitlefield input', 'UAT · e2e release')
    start = page.locator('.flowstartbar .btn.ink')
    check('start: the button counts the chosen stories', 'Start with 2 stories' in start.inner_text(), start.inner_text())
    start.click()
    page.wait_for_url(re.compile(r'/flows/flow-'), timeout=15000)
    flow_id = page.url.rsplit('/', 1)[1]
    page.wait_for_selector('.flowsteps li', timeout=15000)
    check('flow: four UAT steps', [x.strip() for x in page.locator('.flowsteps .lbl b').all_inner_texts()] == ['Analyse', 'Review cases', 'Run tests', 'Sign off'])
    check('flow: both stories are listed', page.locator('.flowstory').count() == 2)

    # The analysis runs in the background; the page updates itself.
    done = False
    for _ in range(40):
        s = page.locator('.flowsteps li').first.inner_text()
        if '2 of 2' in s:
            done = True; break
        page.wait_for_timeout(1000)
    check('background: both stories analysed without anyone asking again', done, page.locator('.flowsteps li').first.inner_text())
    check('flow: coverage line shows start and now', re.search(r'\d+%\s*at the start', page.inner_text('.flowcov')) is not None, page.inner_text('.flowcov'))
    check('flow: the waiting list names a person or step', page.locator('.flowwaiting li').count() >= 1)

    # Open the first story: its steps, criteria and the analysis chat.
    page.locator('.flowstoryhead').first.click()
    page.wait_for_selector('.flowdetail')
    check('story: criteria are listed with a status', page.locator('.flowcriteria > li .pill').count() >= 1)
    check('story: links to the analysis chat', page.locator('.flowdetail a:has-text("Open the analysis chat")').count() == 1)
    check('timeline: start and analyses are recorded', page.locator('.flowtimeline li').count() >= 3)
    # The story's chat shows the flow above the reply box.
    page.click('.flowdetail a:has-text("Open the analysis chat")')
    page.wait_for_selector('.storyflowbar .sfrow', timeout=15000)
    check('chat: a story chat shows its flow and step above the reply box', 'UAT · e2e release' in page.inner_text('.storyflowbar') and 'Step:' in page.inner_text('.storyflowbar'))
    # The drafted cases can be reviewed right in the chat: the flow's review, no rating lock.
    page.wait_for_selector('.flowhandoff .flowreview', timeout=15000)
    hand = page.locator('.flowhandoff').first
    check('chat: the flow review is in the chat, requirement by requirement', hand.locator('.reviewreqs > li').count() >= 1 and 'Rate the answer' not in hand.inner_text())
    page.go_back()
    page.wait_for_selector('.flowsteps li', timeout=15000)

    # Sourav sees the same flow, at the same step.
    sign_in(page, 'Sourav')
    page.goto(BASE + f'/flows/{flow_id}')
    page.wait_for_selector('.flowsteps li', timeout=15000)
    check('team: another member sees the flow by its link', page.locator('h1').inner_text() == 'UAT · e2e release')
    st, body = api(ctx, 'u-sourav', 'GET', f'/api/flows/{flow_id}')
    st2, body2 = api(ctx, 'u-ram', 'GET', f'/api/flows/{flow_id}')
    check('team: same steps and counts for Ram and Sourav', st == 200 and st2 == 200 and body['flow']['steps'] == body2['flow']['steps'])
    check('team: Sourav cannot cancel Ram\'s flow', page.locator('button:has-text("Cancel flow")').count() == 0 and api(ctx, 'u-sourav', 'POST', f'/api/flows/{flow_id}/status', {'status': 'cancelled'})[0] == 403)

    # "Review cases" opens the flow's own review: each requirement with its drafted cases, no rating asked.
    rev = page.locator('.flowstory .flownext button:has-text("Review cases")').first
    if rev.count():
        rev.click()
        page.wait_for_selector('.flowreview', timeout=15000)
        panel = page.locator('.flowreview').first
        check('review: the requirements are listed with the cases drafted for them', panel.locator('.reviewreqs > li').count() >= 2 and panel.locator('.reviewcase').count() >= 1)
        check('review: no rating is asked for', 'Rate' not in panel.inner_text() and panel.locator('.stars, [aria-label*="Rate"]').count() == 0)
        who = panel.locator('.approvers').inner_text()
        check('review: it says who approves and why, and people can be added', ('assigned the story' in who or 'manages' in who) and panel.locator('.addapprover select').count() == 1, who[:120])
        key = (panel.get_attribute('id') or '').replace('review-', '')
        # The link a chat gives (?review=KEY) opens the same review.
        page.goto(BASE + f'/flows/{flow_id}?review={key}')
        page.wait_for_selector(f'#review-{key}', timeout=15000)
        check('review: ?review= opens that story at its review', page.locator(f'#review-{key}').is_visible())
        # Request changes asks what to change before it can be sent.
        page.click(f'#review-{key} button:has-text("Request changes")')
        send = page.locator(f'#review-{key} button:has-text("Send back for changes")')
        check('review: sending back needs a note', send.is_disabled())
        page.screenshot(path=os.environ.get('E2E_SHOTS', '/tmp') + '/flow-review.png', full_page=False)
        # Two stories wait on the same reviewer: they can be approved together. The other one is approved
        # that way; this one is kept for the chat below.
        bulk = page.locator('#bulk-review')
        check('bulk: several stories waiting on one reviewer can be approved together', bulk.count() == 1 and bulk.locator('li').count() == 2 and 'Approve 2 selected' in bulk.inner_text(), bulk.inner_text()[:200] if bulk.count() else 'no panel')
        if bulk.count():
            values = [bulk.locator('li input').nth(i).get_attribute('value') for i in range(bulk.locator('li input').count())]
            other = [k for k in values if k != key][0]
            bulk.locator(f'input[value="{key}"]').uncheck()
            check('bulk: the button counts the selection', 'Approve 1 selected' in bulk.inner_text(), bulk.inner_text()[:200])
            page.screenshot(path=os.environ.get('E2E_SHOTS', '/tmp') + '/flow-bulk.png', full_page=False)
            bulk.locator('button:has-text("Approve 1 selected")').click()
            page.wait_for_selector('.flowwaiting .bulknote', timeout=15000)
            note = page.inner_text('.flowwaiting .bulknote')
            # A story whose components have another manager too keeps waiting on them after this approval.
            partial = f'{other}: you approved; waiting on' in note
            check('bulk: says what was approved and where the stories go', (f'Approved {other}' in note and 'Run tests' in note) or partial, note)
            row = page.locator(f'#story-{other}').inner_text()
            moved = ('approved by Sourav' in row and 'still to come' in row) if partial else ('Run tests' in row)
            check('bulk: the chosen story moves on (or waits on its other approver); this one still waits for its review', moved and page.locator(f'#review-{key}').count() == 1 and page.locator('#bulk-review').count() == 0, row[:200])
        # Approve in the story's chat instead: its card is the same review, and the decision lands on the card.
        page.click(f'#story-{key} a:has-text("Open the analysis chat")')
        page.wait_for_selector('.flowhandoff .flowreview', timeout=15000)
        page.click('.flowhandoff button:has-text("Approve")')
        page.wait_for_selector('.card.approve [role=status]:has-text("Approved by")', timeout=15000)
        decided = page.locator('.card.approve:has([role=status]:has-text("Approved by"))').first
        check('chat: approving in the chat shows the decision on the card without a reload', decided.count() == 1 and 'Rate the answer' not in decided.inner_text())
        page.goto(BASE + f'/flows/{flow_id}')
        page.wait_for_selector(f'#story-{key}', timeout=15000)
        row = page.locator(f'#story-{key}').inner_text()
        check('review: approving moves the story to Run tests', 'Run tests' in row, row[:200])
        # At Run tests the story says what happens now and shows the steps of the case to run.
        page.click(f'#story-{key} .flowstoryhead')
        page.wait_for_selector(f'#story-{key} .stephelp', timeout=15000)
        check('run: the story explains the step and shows the case steps', 'runs each manual case' in page.inner_text(f'#story-{key} .stephelp') and page.locator(f'#story-{key} .casesteps li').count() >= 1)
    else:
        check('review: a story waits on its case review', False, 'no Review cases button')

    # Home shows the flow in progress.
    page.goto(BASE + '/')
    page.wait_for_selector('.homeflows .flowcard', timeout=15000)
    check('home: the flow is listed in progress', 'UAT · e2e release' in page.inner_text('.homeflows'))

    # Regression starts from the application's coverage.
    sign_in(page, 'Ram Kumar')
    page.goto(BASE + '/flows/new')
    # A story already in a UAT flow cannot be picked again: it shows the flow it is in.
    page.wait_for_selector('.flowpick li.taken', timeout=15000)
    row = page.locator(f'.flowpick li.taken:has-text("{keys[0]}")')
    check('start: a story already in a flow is marked and cannot be picked', row.count() == 1 and row.locator('input').is_disabled() and 'UAT · e2e release' in row.inner_text())
    page.click('.segctl button:has-text("Regression")')
    page.wait_for_selector('.flowbase table tbody tr', timeout=20000)
    check('regression: coverage today per component', page.locator('.flowbase tbody tr').count() >= 5 and re.search(r'\d+% covered today', page.inner_text('.flowbase')) is not None)
    check('regression: gaps are preselected', page.locator('.flowpick li input:checked').count() >= 1)

    # Draft automation puts the request in the message box, for a person to send.
    page.goto(BASE + '/?ask=' + 'Write%20automated%20tests%20for%20ABCD-1001')
    page.wait_for_selector('.composer textarea, textarea', timeout=10000)
    check('home: ?ask= fills the message box, not sent', 'Write automated tests for ABCD-1001' in page.locator('textarea').first.input_value())

    # A failed load (server restarting, connection dropped) keeps the flows on screen and retries.
    page.goto(BASE + '/flows')
    page.wait_for_selector('.flowcard', timeout=15000)
    shown = page.locator('.flowcard').count()
    page.route('**/api/flows**', lambda route: route.abort())
    page.evaluate("window.dispatchEvent(new Event('flows:changed'))")
    page.wait_for_selector('.errtext', timeout=10000)
    check('outage: the flows stay on screen when a load fails', page.locator('.flowcard').count() == shown and page.locator('.flowempty').count() == 0)
    check('outage: says it is retrying', 'Trying again' in page.inner_text('.errtext'))
    page.unroute('**/api/flows**')
    page.evaluate("window.dispatchEvent(new Event('flows:changed'))")
    page.wait_for_timeout(1500)
    check('outage: the message goes once the server answers', page.locator('.errtext').count() == 0)
    # Switching from Sourav to Brijesh keeps the same flows.
    sign_in(page, 'Sourav'); page.goto(BASE + '/flows'); page.wait_for_selector('.flowcard', timeout=15000)
    n_sourav = page.locator('.flowcard').count()
    sign_in(page, 'Brijesh'); page.wait_for_timeout(1500)
    check('switch: Brijesh sees the same flows after Sourav', page.locator('.flowcard').count() == n_sourav)

    # Phone width: no sideways scroll on the flow page.
    page.set_viewport_size({'width': 390, 'height': 844})
    page.goto(BASE + f'/flows/{flow_id}')
    page.wait_for_selector('.flowsteps li', timeout=15000)
    sw = page.evaluate('document.documentElement.scrollWidth')
    check('phone: no sideways scroll on a flow', sw <= 392, str(sw))

    # A remembered application that no longer exists (the workspace changed) lands on the person's first one.
    page.set_viewport_size({'width': 1360, 'height': 900})
    page.evaluate("localStorage.setItem('hz-session', JSON.stringify({userId: 'u-ram', appId: 'GONE', workspace: 'x'}))")
    page.goto(BASE + '/')
    page.wait_for_selector('.mebtn', timeout=15000); page.wait_for_timeout(1200)
    me = page.inner_text('.mebtn')
    check('session: a remembered application that no longer exists falls back to the first one', 'Ram Kumar' in me and 'does not exist' not in me, me[:120])
    b.close()

print(f'\n{sum(ok for _, ok in checks)} of {len(checks)} checks passed; console errors: {len(errors) or "none"}')
for e in errors[:5]:
    print('  console:', e[:200])
sys.exit(0 if all(ok for _, ok in checks) and not errors else 1)
