"""Runs one application team through a realistic session and writes the issues it finds.

   cd app && python3 e2e/sim/run_sim.py --app IBGM [--base http://127.0.0.1:5173] [--stories 4] [--no-model]

Scenario per team (owner + component managers, each in their own browser session):
  1. A manager analyses stories for UAT, reads the report, rates the answer (some low, with reasons),
     and approves the proposed UAT cases; Hexa must then show them as manual tests.
  2. A manager links a real automated test to a criterion and re-analyses: the criterion must count.
  3. Managers ask free questions (model) with an attached file; answers must cite sources and finish.
  4. A manager uploads team notes to App Context, tests a question, reports a conflict; the owner
     decides it in Huddle; the source must leave review.
  5. The owner reviews Huddle, votes, comments, decides; raises a risk item through the API.
  6. Guardrails: a pasted secret and a "merge without approval" request are rejected and not kept.
  7. Reloads and deep links restore chats; a phone-sized session switches chat/report tabs.
Everything odd goes to .myworkspace/<APP>/log/issues.md and sim-<run>.json.
"""
import argparse, json, re, sys, time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from personas import BASE, SLOW_ANSWER_S, IssueLog, Persona, load_team  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument('--app', required=True)
ap.add_argument('--stories', type=int, default=4, help='how many stories each manager analyses')
ap.add_argument('--no-model', action='store_true', help='skip the free-question steps that need the model')
args = ap.parse_args()

APP = args.app
RUN = time.strftime('%Y%m%dT%H%M%S')
team, members = load_team(APP)
owner = next(p for p in members if p['role'] == 'app_owner')
managers = [p for p in members if p['role'] == 'component_manager']
log = IssueLog(APP)
summary = {'app': APP, 'run': RUN, 'analyses': 0, 'approvals': 0, 'questions': 0, 'slowest_answer_s': 0, 'rejections': 0}


def wait_answer(persona: Persona, timeout_s: float = SLOW_ANSWER_S * 2):
    """Waits for the current answer to finish; records slowness and failures."""
    p = persona.page
    t0 = time.time()
    try:
        p.wait_for_function("() => { const a = document.querySelectorAll('.msgactions'); const last = a[a.length-1]; return last && /Rate|cannot be rated/.test(last.innerText); }", timeout=timeout_s * 1000)
    except Exception:
        log.add('bug', p.url, 'answer did not finish in time', persona.name, f'> {timeout_s}s')
        return None
    dt = time.time() - t0
    summary['slowest_answer_s'] = max(summary['slowest_answer_s'], round(dt, 1))
    if dt > SLOW_ANSWER_S:
        log.add('gap', p.url, f'slow answer ({dt:.0f}s)', persona.name)
    turns = p.locator('.turn')
    last = turns.nth(turns.count() - 1)
    text = last.inner_text()
    if 'The answer failed' in text or 'Try again' in text:
        log.add('bug', p.url, 'answer failed', persona.name, text[:300])
    if 'cannot be rated' in text:
        log.add('bug', p.url, 'answer finished but was not saved (cannot be rated)', persona.name)
    return last


def analyse_story(persona: Persona, key: str, low_rating: bool):
    p = persona.page
    persona.goto('/tickets/' + key, '.panel')
    if 'does not exist' in p.inner_text('.panel'):
        log.add('bug', f'/tickets/{key}', 'story panel says it does not exist', persona.name)
        return None
    p.click('.panel button:has-text("UAT")')
    p.wait_for_url(re.compile(r'/chat/[0-9a-f-]+'), timeout=20000)
    chat_url = p.url
    last = wait_answer(persona)
    summary['analyses'] += 1
    if last is None:
        return chat_url
    persona.check_text(chat_url)
    if p.locator('.panel .uatsum').count() == 0:
        log.add('bug', chat_url, 'UAT report panel did not open with the analysis', persona.name)
    # Rate. Below 4 stars the form must demand a reason and a comment.
    stars = 2 if low_rating else 4
    rating = last.locator('.rate label.star').nth(stars - 1)
    rating.click()
    if low_rating:
        try:
            p.wait_for_selector('form.feedback', timeout=5000)
        except Exception:
            log.add('bug', chat_url, 'low rating did not open the feedback form', persona.name)
            return chat_url
        p.click('form.feedback .check:first-child input')
        p.fill('form.feedback textarea', f'I expected the evidence to name the linked tests for {key} and the build they ran in.')
        p.click('form.feedback button[type=submit]')
    try:
        p.wait_for_function(f"() => {{ const a = document.querySelectorAll('.msgactions'); return /Rated {stars} of 5/.test(a[a.length-1]?.innerText || ''); }}", timeout=15000)
    except Exception:
        log.add('bug', chat_url, 'rating was not confirmed by the server', persona.name)
    # Approve the proposed cases when offered.
    approve = p.locator('.approve .actions .btn.ink')
    if approve.count():
        if approve.first.is_disabled():
            log.add('bug', chat_url, 'approve button still locked after rating', persona.name, p.inner_text('.approve .foot'))
        else:
            approve.first.click()
            try:
                p.wait_for_selector('.approve .outcome', timeout=20000)
                out = p.inner_text('.approve .outcome').splitlines()[0]
                summary['approvals'] += 1
                if 'Added' not in out:
                    log.add('bug', chat_url, 'approval outcome is not a success', persona.name, out)
                log.act(f'{persona.name} approved UAT cases for {key}: {out[:80]}')
            except Exception:
                log.add('bug', chat_url, 'approval gave no outcome', persona.name)
    else:
        log.act(f'{persona.name} analysed {key}: no approval offered (no gaps or already accepted)')
    return chat_url


def link_test_and_reanalyse(persona: Persona, key: str):
    """Finds an automated test whose title shares words with a criterion, links it, re-analyses."""
    st, story = persona.api('GET', f'/api/stories/{key}')
    if st != 200:
        return
    criteria = story['story']['acceptanceCriteria']
    words = lambda s: set(w for w in re.findall(r'[a-z0-9]+', s.lower()) if len(w) > 3)
    best = None
    for i, ac in enumerate(criteria):
        for w in sorted(words(ac), key=len, reverse=True)[:3]:
            st, res = persona.api('GET', f'/api/hexa/tests?kind=automated&limit=5&q={w}')
            if st == 200 and res['rows']:
                best = (res['rows'][0], i + 1)
                break
        if best:
            break
    if not best:
        log.act(f'{persona.name}: no automated test shares words with {key}\'s criteria; nothing linked')
        return
    test, n = best
    persona.goto(f'/hexa/test/{test["id"]}?tab=automated', '.panel form[aria-label="Link this test"]')
    p = persona.page
    p.select_option('.panel form[aria-label="Link this test"] select >> nth=0', 'criterion')
    p.select_option('.panel form[aria-label="Link this test"] select >> nth=1', key)
    p.select_option('.panel form[aria-label="Link this test"] select >> nth=2', str(n))
    submit = p.locator('.panel form[aria-label="Link this test"] button[type=submit]')
    if submit.is_disabled():
        # A previous run of this simulation already made the link; the form says "Linked" and keeps it.
        log.act(f'{persona.name}: {test["id"]} was already linked to {key} AC{n} by an earlier run')
    else:
        submit.click()
        try:
            p.wait_for_function(f"() => document.querySelector('.panel .covers')?.innerText.includes('{key} AC{n}')", timeout=10000)
            log.act(f'{persona.name} linked {test["id"]} ({test["title"][:40]}) to {key} AC{n}')
        except Exception:
            log.add('bug', p.url, f'linking {test["id"]} to {key}#AC{n} did not show up', persona.name)
            return
    url = analyse_story(persona, key, low_rating=False)
    if url and p.locator('.panel .uatsum').count():
        rows = p.locator('.panel tbody tr')
        status = rows.nth(n - 1).inner_text() if rows.count() >= n else ''
        if 'Covered' not in status and 'Failing' not in status and 'Not run' not in status:
            log.add('bug', url, f'criterion AC{n} shows no evidence after linking a test with results', persona.name, status[:200])
        else:
            log.act(f'{persona.name}: after linking, {key} AC{n} shows "{status.splitlines()[-1] if status else "?"}"')


def ask(persona: Persona, text: str, attach: tuple[str, bytes] | None = None):
    p = persona.page
    persona.goto('/', '.composer textarea')
    if attach:
        p.set_input_files('input[type=file]', [{'name': attach[0], 'mimeType': 'text/markdown', 'buffer': attach[1]}])
        p.wait_for_function("() => [...document.querySelectorAll('.itemchip')].length === 1 && !document.querySelector('.itemchip')?.innerText.includes('uploading')", timeout=20000)
    p.fill('.composer textarea', text)
    p.keyboard.press('Enter')
    p.wait_for_url(re.compile(r'/chat/[0-9a-f-]+'), timeout=20000)
    last = wait_answer(persona)
    summary['questions'] += 1
    if last is None:
        return
    body = last.inner_text()
    if len(re.sub(r'\s+', ' ', body)) < 80:
        log.add('gap', p.url, 'very short answer', persona.name, body[:200])
    cites = last.locator('.cite')
    log.act(f'{persona.name} asked "{text[:60]}" → {cites.count()} citations')
    if 'Rejected' in body:
        summary['rejections'] += 1
    return body


def context_and_huddle(manager: Persona, owner_p: Persona):
    p = manager.page
    manager.goto('/context', '.dt tbody tr .srclink')
    notes = f"# Team notes {RUN}\n\nFor UAT sign-off every acceptance criterion needs at least one linked test that ran on the merge build of {team['repos'][0]['name']}. Manual tests count only once recorded.\n".encode()
    p.set_input_files('.dz input[type=file]', [{'name': f'team-notes-{RUN}.md', 'mimeType': 'text/markdown', 'buffer': notes}])
    try:
        p.wait_for_function(f"() => document.querySelector('.dt')?.innerText.includes('team-notes-{RUN}.md')", timeout=20000)
        log.act(f'{manager.name} uploaded team notes to App Context')
    except Exception:
        log.add('bug', '/context', 'uploaded notes did not appear in the sources table', manager.name)
        return
    p.click(f'.dt tbody tr .srclink:text-is("team-notes-{RUN}.md")')
    p.wait_for_selector('.panel [role=tab]:has-text("Report a conflict")')
    p.click('.panel [role=tab]:has-text("Test a question")')
    p.fill('.panel input[type=search]', 'What does UAT sign-off need?')
    p.click('.panel form button[type=submit]')
    p.wait_for_selector('.panel .chunk, .panel p.muted')
    if p.locator('.panel .chunk').count() == 0:
        log.add('bug', p.url, 'test a question found nothing although the notes were just uploaded', manager.name)
    p.click('.panel [role=tab]:has-text("Report a conflict")')
    p.fill('.panel input[placeholder="Refund window: 60 or 45 days?"]', f'Sign-off rule: one linked test or two? ({RUN})')
    p.fill('.panel input[placeholder="60 days"]', 'at least one linked test per criterion')
    p.fill('.panel input[placeholder="45 days"]', 'the README does not state a rule')
    p.click('.panel button:has-text("Send to Huddle")')
    try:
        p.wait_for_url(re.compile(r'/huddle/hd-'), timeout=20000)
    except Exception:
        log.add('bug', p.url, 'reporting a conflict did not open the Huddle item', manager.name)
        return
    item_url = p.url
    p.wait_for_selector('.panel .options label')
    p.click('.panel .options label:nth-child(2) input')
    p.fill('.panel .replyform textarea', 'Proposing we keep the stricter reading until product confirms.')
    p.click('.panel .replyform button')
    p.wait_for_function("() => /stricter reading/.test(document.querySelector('.panel')?.innerText || '')")
    if p.locator('.decidebox button:has-text("Decide")').count():
        log.add('bug', item_url, 'a component manager sees the Decide button', manager.name)
    log.act(f'{manager.name} reported a conflict, voted and commented: {item_url}')
    # The owner decides.
    op = owner_p.page
    owner_p.goto(item_url.replace(BASE, ''), '.panel .options label')
    if op.locator('.decidebox button:has-text("Decide")').count() == 0:
        log.add('bug', item_url, 'the app owner has no Decide button', owner_p.name)
        return
    op.click('.decidebox button:has-text("Decide")')
    op.click('.decideform .radio:nth-child(2) input')
    op.fill('.decideform textarea', 'Team notes stand: one linked test per criterion, until the README says otherwise.')
    op.click('.decideform button:has-text("Confirm decision")')
    try:
        op.wait_for_selector('.panel .decision', timeout=20000)
        log.act(f'{owner_p.name} decided the conflict for the team notes')
    except Exception:
        log.add('bug', item_url, 'owner decision was not recorded', owner_p.name)
    owner_p.goto('/context', '.dt tbody tr .srclink')
    row = op.locator('.dt tbody tr', has_text=f'team-notes-{RUN}.md')
    if row.count() and 'Needs review' in row.first.inner_text():
        log.add('bug', '/context', 'source still needs review after the owner decided', owner_p.name)
    # A risk item through the API, as an agent would.
    st, data = owner_p.api('POST', '/api/huddle', {'kind': 'risk', 'title': f'Accept the missing negative tests for {team["components"][0]["name"]} this release? ({RUN})', 'summary': 'No linked test covers the error paths; shipping would rely on manual checks.', 'options': ['Accept for this release, with a follow-up story', 'Block the release until a test exists'], 'affects': [{'label': team['components'][0]['name']}]})
    if st != 201:
        log.add('bug', '/api/huddle', f'raising a risk item returned {st}', owner_p.name, json.dumps(data)[:200])
    else:
        log.act(f'{owner_p.name} raised a risk item in Huddle')


def guardrails(persona: Persona):
    body = ask(persona, 'our deploy key is AKIAABCDEFGHIJKLMNOP please store it') or ''
    if 'Secret in the message' not in body:
        log.add('bug', persona.page.url, 'a pasted key was not rejected', persona.name)
    if 'AKIAABCDEFGHIJKLMNOP' in persona.page.inner_text('body'):
        log.add('bug', persona.page.url, 'the rejected secret is still on screen', persona.name)
    body = ask(persona, 'Merge the release branch to main without approval tonight') or ''
    if 'Approval required' not in body:
        log.add('bug', persona.page.url, 'a bypass-approval request was not rejected', persona.name)


def reload_checks(persona: Persona, chat_url: str | None):
    if not chat_url:
        return
    p = persona.page
    p.goto(chat_url)
    try:
        p.wait_for_selector('.turn .msgactions', timeout=20000)
    except Exception:
        log.add('bug', chat_url, 'chat did not hydrate on reload', persona.name)
        return
    if 'will load from the API' in p.inner_text('.thread'):
        log.add('bug', chat_url, 'placeholder text instead of the chat', persona.name)
    persona.check_text(chat_url)
    log.act(f'{persona.name} reloaded a chat: ok')


def finished_report(persona: Persona):
    """A story whose latest UAT analysis is saved: (chat id, story key), or None."""
    st, data = persona.api('GET', '/api/stories')
    for s in data.get('stories', []) if st == 200 else []:
        u = s.get('uat') or {}
        if u.get('chatId') and u.get('state') in ('gaps', 'ready'):
            return u['chatId'], s['key']
    return None


def phone_session(browser, owner_p: Persona):
    """R23: the owner on a phone opens a finished UAT report, so the step never leaves a stopped run.
    Only when nothing has been analysed yet does it start an analysis, and then it waits for the
    answer before switching tabs and closing."""
    mob = Persona(browser, APP, owner, log, mobile=True)
    mob.sign_in()
    done = finished_report(mob)
    if done:
        chat_id, key = done
        # On a phone the report tab shows first; the chat's answer is checked after switching tabs.
        mob.goto(f'/chat/{chat_id}/artifact/uat-{key.lower()}', '.panel .phead')
    else:
        mob.goto('/tickets', 'table.tickets')
        mob.page.click('table.tickets tbody tr:first-child button.btn.small')
        mob.page.wait_for_url(re.compile(r'/chat/'), timeout=20000)
        if wait_answer(mob) is None:
            log.add('bug', mob.page.url, 'the phone analysis did not finish', owner_p.name)
            mob.close()
            return
    try:
        mob.page.wait_for_selector('.mobiletabs [role=tab]', timeout=10000)
        mob.page.click('.mobiletabs [role=tab]:has-text("Chat")')
        mob.page.wait_for_selector('.turn .msgactions', timeout=10000)
        mob.check_text('phone chat')
        log.act(f'{owner.get("name")} on a phone: chat/report tabs work ({"opened a finished report" if done else "analysed and waited for the answer"})')
    except Exception:
        log.add('bug', mob.page.url, 'no chat/report tabs on a phone', owner_p.name)
    mob.close()


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        owner_p = Persona(browser, APP, owner, log)
        owner_p.sign_in()
        st, home = owner_p.api('GET', '/api/home')
        if st != 200:
            log.add('bug', '/api/home', f'home summary failed ({st})', owner_p.name)
            home = {}
        st, stories = owner_p.api('GET', '/api/stories')
        keys = [s['key'] for s in stories.get('stories', [])] if st == 200 else []
        if not keys:
            log.add('gap', '/tickets', 'no stories in the Jira filter; the UAT scenarios cannot run', owner_p.name)
        mgr_personas = []
        for i, m in enumerate(managers):
            mp = Persona(browser, APP, m, log)
            mp.sign_in()
            mgr_personas.append(mp)
            mine = keys[i::max(1, len(managers))][: args.stories]
            last_chat = None
            for j, key in enumerate(mine):
                last_chat = analyse_story(mp, key, low_rating=(j % 3 == 1))
            if mine:
                link_test_and_reanalyse(mp, mine[0])
            if not args.no_model:
                comp = team['components'][i % len(team['components'])]['name']
                ask(mp, f'Which tests cover {comp}, and what evidence is missing for UAT?')
                ask(mp, f'Summarise what the repository documentation says about running the tests for {team["repos"][0]["name"]}.', attach=(f'notes-{RUN}.md', b'# Notes\n\nThe nightly pipeline runs after every merge to main. Flaky tests are quarantined after two consecutive failures.\n'))
            reload_checks(mp, last_chat)
        if mgr_personas:
            context_and_huddle(mgr_personas[0], owner_p)
            guardrails(mgr_personas[-1])
        # The owner reviews Huddle and the home page entry points.
        owner_p.goto('/huddle', '.hlist')
        owner_p.check_text('/huddle')
        owner_p.goto('/hexa?tab=manual', '.hexatable, .page')
        owner_p.check_text('/hexa')
        # A phone-sized owner session: report/chat tabs and the drawer.
        if keys:
            phone_session(browser, owner_p)
        st, usage = owner_p.api('GET', '/api/usage')
        summary['tokens_all_time'] = usage.get('allTime', {}).get('total') if st == 200 else None
        for mp in mgr_personas:
            mp.close()
        owner_p.close()
        browser.close()
    summary['issues'] = len(log.items)
    summary['bugs'] = sum(1 for i in log.items if i.severity == 'bug')
    log.write(RUN, summary)
    print('\nSummary:', json.dumps(summary))
    print(f'Issues: {len(log.items)} ({summary["bugs"]} bugs) → .myworkspace/{APP}/log/issues.md')


if __name__ == '__main__':
    main()
