"""Huddle across testing, reliability and security (docs/HUDDLE.md, slice 1): "Raise with the team" from a chat
answer creates a Concern linked to the chat; the domain chips and "Waiting on me" filter the list; an action is
added with an owner and a due date and completed, which closes the decided item; a reliability decision is made by
an SRE lead and refused for someone without the role; a concern is answered. Axe on the new forms.

The workspace gives nobody the sre_lead role, so this script grants it to Karim (IBGM) in the throwaway database
(E2E_DB, set by run.sh), the way a team.json "roles" entry would."""
import json, os, pathlib, re, sqlite3, sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get('E2E_BASE', 'http://127.0.0.1:5199')
DB = os.environ.get('E2E_DB')
AXE = pathlib.Path(__file__).resolve().parents[1] / 'node_modules' / 'axe-core' / 'axe.min.js'
checks = []
def check(name, ok, detail=''):
    checks.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail and not ok else ''))

errors = []
def new_page(browser, user, theme='light', width=1360):
    session = json.dumps({'userId': user, 'appId': 'IBGM', 'workspace': None})
    ctx = browser.new_context(viewport={'width': width, 'height': 900 if width > 600 else 844}, reduced_motion='reduce')
    ctx.add_init_script(f"try {{ localStorage.setItem('hz-session', {json.dumps(session)}); localStorage.setItem('hz-theme', '{theme}'); }} catch (e) {{}}")
    page = ctx.new_page()
    # 403s are expected below (refusals); other console errors fail the script.
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and '404' not in m.text and '403' not in m.text else None)
    return page

def api(page, user, method, path, body=None):
    return page.evaluate("""async ([user, method, path, body]) => {
      const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'x-horizon-user': user, 'x-horizon-app': 'IBGM' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    }""", [user, method, path, body])

def axe(page, name):
    if not page.evaluate("() => !!window.axe"):
        page.add_script_tag(path=str(AXE))
    v = page.evaluate("""async () => (await axe.run(document, { resultTypes: ['violations'] })).violations
      .filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => v.id + ': ' + v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(', '))""")
    check(f'axe: {name} has no serious or critical violations', not v, '; '.join(v))

def open_list(page, path='/huddle'):
    page.goto(BASE + path)
    page.wait_for_function("() => !document.querySelector('.hlist[aria-busy=\"true\"]')", timeout=15000)

if not DB:
    print('FAIL E2E_DB is not set (run through e2e/run.sh)'); sys.exit(1)

with sync_playwright() as p:
    b = p.chromium.launch()

    # 0. Karim becomes the SRE lead of IBGM.
    con = sqlite3.connect(DB, timeout=10)
    con.execute("INSERT OR IGNORE INTO memberships (user_id, application_id, role) VALUES ('u-karim', 'IBGM', 'sre_lead')")
    con.commit(); con.close()

    # 1. Raise with the team from a finished chat answer.
    sayeer = new_page(b, 'u-sayeer')
    sayeer.goto(BASE + '/')
    sayeer.wait_for_selector('.composer textarea')
    sayeer.fill('.composer textarea', 'Is IBGM-1008 ready for UAT?')
    sayeer.keyboard.press('Enter')
    sayeer.wait_for_url(re.compile(r'/chat/[0-9a-f-]+'), timeout=15000)
    chat_path = sayeer.url.replace(BASE, '')
    sayeer.wait_for_selector('.turn .msgactions button[aria-label="Raise with the team"]', timeout=30000)
    sayeer.click('.turn .msgactions button[aria-label="Raise with the team"]')
    sayeer.wait_for_selector('form.raiseform')
    prefilled = sayeer.input_value('form.raiseform input')
    check('raise form is prefilled with the question', prefilled == 'Is IBGM-1008 ready for UAT?', prefilled)
    check('raise form names the domain from the capability', 'Testing' in sayeer.inner_text('form.raiseform'))
    axe(sayeer, 'chat with the raise form')
    sayeer.fill('form.raiseform input', 'Is IBGM-1008 really ready? The export test is manual only')
    sayeer.fill('form.raiseform textarea', 'Ops says statements failed last week.')
    sayeer.click('form.raiseform button[type=submit]')
    sayeer.wait_for_selector('.callout.raised a', timeout=15000)
    sayeer.click('.callout.raised a')
    sayeer.wait_for_url(re.compile(r'/huddle/hd-'), timeout=15000)
    sayeer.wait_for_selector('.panel .facts', timeout=15000)
    concern_url = sayeer.url
    panel = sayeer.inner_text('.panel')
    check('the concern carries kind, domain, the question and the note', 'Concern' in panel and 'Testing' in panel and 'Question: Is IBGM-1008 ready for UAT?' in panel and 'Ops says statements failed' in panel, panel[:300])
    check('the concern links the chat', sayeer.locator(f'.panel a.pill[href="{chat_path}"]').count() == 1)
    check('a concern has no options to vote on', sayeer.locator('.panel .options').count() == 0)

    # 2. A reliability item, and the domain chips.
    r = api(sayeer, 'u-sayeer', 'POST', '/api/huddle', {'kind': 'capacity_warning', 'title': 'Statement export memory reaches its limit in about 3 h', 'summary': 'Grew 40 MB an hour since the deploy.', 'options': ['Scale to 3 replicas', 'Restart in the quiet hour'], 'links': [{'type': 'deployment', 'ref': 'export@0900', 'label': 'export 09:00 deploy'}]})
    check('a capacity warning is raised in Reliability', r['status'] == 201 and r['body']['item']['domain'] == 'reliability', str(r)[:200])
    cap = r['body']['item']
    open_list(sayeer)
    sayeer.click('.domainchips button:has-text("Reliability")')
    sayeer.wait_for_function("() => document.querySelector('.domainchips button[aria-pressed=true]')?.innerText.startsWith('Reliability') && !document.querySelector('.hlist[aria-busy=\"true\"]')", timeout=10000)
    titles = sayeer.locator('.hlist .hitem b').all_inner_texts()
    check('Reliability shows the capacity warning only', titles == [cap['title']], str(titles))
    check('kind badge in plain words', 'Capacity warning' in sayeer.inner_text('.hlist .hitem .kind'))
    sayeer.click('.domainchips button:has-text("Testing")')
    sayeer.wait_for_function("() => document.querySelector('.domainchips button[aria-pressed=true]')?.innerText.startsWith('Testing') && !document.querySelector('.hlist[aria-busy=\"true\"]')", timeout=10000)
    titles = sayeer.locator('.hlist .hitem b').all_inner_texts()
    check('Testing shows the concern and not the capacity warning', any('IBGM-1008' in t for t in titles) and cap['title'] not in titles, str(titles))
    sayeer.click('.domainchips button:text-is("All")')

    # 3. Sayeer (a component manager, not the SRE lead) cannot decide the reliability item; he adds an action for Karim.
    sayeer.goto(BASE + f"/huddle/{cap['id']}")
    sayeer.wait_for_selector('.panel .options', timeout=15000)
    check('no Decide button without the SRE lead role', sayeer.locator('.decidebox button:has-text("Decide")').count() == 0)
    check('the panel says who decides', 'an SRE lead or an app owner' in sayeer.inner_text('.panel .facts'))
    refused = api(sayeer, 'u-sayeer', 'POST', f"/api/huddle/{cap['id']}/decide", {'optionId': cap['options'][0]['id'], 'reason': 'Scale now'})
    check('the server refuses the decision (403)', refused['status'] == 403 and 'SRE lead' in (refused['body'] or {}).get('error', ''), str(refused))
    sayeer.click('.panel button:has-text("Add an action")')
    sayeer.wait_for_selector('form.actionform select option:has-text("Karim")', state='attached', timeout=10000)
    sayeer.fill('form.actionform input >> nth=0', 'Profile the export heap')
    sayeer.select_option('form.actionform select', 'u-karim')
    sayeer.fill('form.actionform input[type=date]', '2026-12-01')
    axe(sayeer, 'item panel with the action form')
    sayeer.click('form.actionform button[type=submit]')
    sayeer.wait_for_selector('.actionlist li', timeout=10000)
    act = sayeer.inner_text('.actionlist li')
    check('the action shows its owner and due date', 'Profile the export heap' in act and 'Karim' in act and '2026' in act, act)

    # 4. Karim (SRE lead): waiting on me, decides, completes the action; the item closes.
    karim = new_page(b, 'u-karim', theme='dark')
    open_list(karim)
    karim.click('.segctl button:has-text("Waiting on me")')
    karim.wait_for_function("() => document.querySelector('.segctl button[aria-pressed=true]')?.innerText.startsWith('Waiting on me') && !document.querySelector('.hlist[aria-busy=\"true\"]')", timeout=10000)
    waiting = karim.locator('.hlist .hitem b').all_inner_texts()
    check('Waiting on me lists the reliability item for the SRE lead', cap['title'] in waiting, str(waiting))
    karim.goto(BASE + f"/huddle/{cap['id']}")
    karim.wait_for_selector('.decidebox button:has-text("Decide")', timeout=15000)
    axe(karim, 'item panel (dark) for the decider')
    karim.click('.decidebox button:has-text("Decide")')
    karim.click('.decideform .radio:nth-child(3) input')
    karim.fill('.decideform textarea', 'A restart at night is safe; scaling waits for the heap profile.')
    karim.click('.decideform button:has-text("Confirm decision")')
    karim.wait_for_selector('.panel .decision', timeout=15000)
    check('the SRE lead decides the reliability item', 'Karim' in karim.inner_text('.panel .decision') and 'Follow-up' in karim.inner_text('.panel .chips'))
    karim.click('.actionlist button:has-text("Mark done")')
    karim.wait_for_function("() => /Closed/.test(document.querySelector('.panel .chips')?.innerText || '')", timeout=10000)
    check('completing the last action closes the item', 'done by Karim' in karim.inner_text('.actionlist'))

    # 5. The raiser answers the concern.
    sayeer.goto(concern_url)
    sayeer.wait_for_selector('form.answerform textarea', timeout=15000)
    sayeer.fill('form.answerform textarea', 'Ops confirmed the failure was the old queue; the manual export test covers the AC.')
    sayeer.click('form.answerform button[type=submit]')
    sayeer.wait_for_selector('.panel .answer', timeout=10000)
    check('the concern is answered and closed', 'Answered' in sayeer.inner_text('.panel .chips') and 'Mohd Sayeer' in sayeer.inner_text('.panel .answer'))
    sayeer.reload()
    sayeer.wait_for_selector('.panel .answer', timeout=15000)
    check('the answer survives a reload', 'old queue' in sayeer.inner_text('.panel .answer'))

    # 6. Phone width: the list with chips.
    phone = new_page(b, 'u-karim', width=390)
    open_list(phone)
    check('domain chips fit at phone width (no horizontal scroll)', phone.evaluate('() => document.documentElement.scrollWidth <= window.innerWidth + 1'))
    axe(phone, 'Huddle list at 390 px')
    b.close()

bad = [c for c in checks if not c[1]]
print(f'\n{len(checks) - len(bad)} of {len(checks)} checks passed; console errors: {json.dumps(errors[:5]) if errors else "none"}')
sys.exit(1 if bad or errors else 0)
