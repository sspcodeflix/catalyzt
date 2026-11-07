"""Simulated people driving Catalyzt the way a team would, one browser context per person.

Each persona signs in through the development picker, works in their own application, and does
what their role allows: managers analyse stories, rate answers, approve proposed UAT cases, link
tests, upload context and attach files; owners decide Huddle items and approve too. Everything a
persona sees that looks wrong (console errors, failed requests, slow or empty answers, text such as
"undefined", counts that do not add up, actions that silently do nothing) is recorded as an issue.
"""
import json, os, pathlib, re, time
from dataclasses import dataclass, field

from playwright.sync_api import Browser, Page

ROOT = pathlib.Path(__file__).resolve().parents[3]
WS = ROOT / '.myworkspace'
BASE = os.environ.get('SIM_BASE', 'http://127.0.0.1:5173')
SLOW_ANSWER_S = float(os.environ.get('SIM_SLOW_S', '90'))

BAD_TEXT = re.compile(r'\b(undefined|NaN|\[object Object\]|null null|Invalid Date)\b')


@dataclass
class Issue:
    severity: str  # bug | gap | nit
    where: str
    what: str
    persona: str
    detail: str = ''
    at: str = field(default_factory=lambda: time.strftime('%Y-%m-%dT%H:%M:%S'))


class IssueLog:
    def __init__(self, app: str):
        self.app = app
        self.items: list[Issue] = []
        self.actions: list[str] = []
        self.seen: set[str] = set()

    def add(self, severity: str, where: str, what: str, persona: str, detail: str = ''):
        key = f'{where}|{what}'
        if key in self.seen:
            return
        self.seen.add(key)
        self.items.append(Issue(severity, where, what, persona, detail[:600]))
        print(f'   ISSUE [{severity}] {where}: {what}' + (f' ({detail[:120]})' if detail else ''))

    def act(self, text: str):
        self.actions.append(f'{time.strftime("%H:%M:%S")} {text}')
        print(f'   {text}')

    def write(self, run_id: str, summary: dict):
        log_dir = WS / self.app / 'log'
        log_dir.mkdir(parents=True, exist_ok=True)
        p = log_dir / 'issues.md'
        header = not p.exists()
        with p.open('a') as f:
            if header:
                f.write(f'# Issues found while simulating {self.app}\n\nEach run appends a section. Severity: bug (wrong or broken), gap (missing or unclear), nit (polish).\n')
            f.write(f'\n## Run {run_id}\n\n')
            f.write('Summary: ' + json.dumps(summary) + '\n\n')
            if not self.items:
                f.write('No issues recorded.\n')
            for i in self.items:
                f.write(f'- **{i.severity}** · {i.where} · {i.what} (by {i.persona}, {i.at})' + (f'\n  {i.detail}' if i.detail else '') + '\n')
            f.write('\n<details><summary>Actions</summary>\n\n' + '\n'.join(f'- {a}' for a in self.actions) + '\n\n</details>\n')
        (log_dir / f'sim-{run_id}.json').write_text(json.dumps({'summary': summary, 'issues': [i.__dict__ for i in self.items], 'actions': self.actions}, indent=2))


def load_team(app: str):
    team = json.loads((WS / app / 'team.json').read_text())
    people = json.loads((WS / 'personas.json').read_text())['people']
    members = [p for p in people if p['app'] == app]
    return team, members


class Persona:
    def __init__(self, browser: Browser, app: str, person: dict, log: IssueLog, mobile: bool = False):
        self.app = app
        self.person = person
        self.name = person['name']
        self.role = person['role']
        self.log = log
        viewport = {'width': 390, 'height': 844} if mobile else {'width': 1360, 'height': 900}
        self.ctx = browser.new_context(viewport=viewport)
        self.page: Page = self.ctx.new_page()
        self.page.set_default_timeout(20000)
        self.mobile = mobile
        self.page.on('console', self._console)
        self.page.on('response', self._response)
        self.page.on('pageerror', lambda e: self.log.add('bug', self.page.url, f'page error: {str(e)[:160]}', self.name))

    # ---- observation ------------------------------------------------------------------------
    def _console(self, msg):
        if msg.type == 'error' and 'the server responded with a status of 404' not in msg.text:
            self.log.add('bug', self.page.url, f'console error: {msg.text[:160]}', self.name)

    def _response(self, res):
        if res.status >= 500:
            self.log.add('bug', res.url, f'server error {res.status}', self.name)
        elif res.status in (400, 409, 413) and '/api/' in res.url:
            self.log.add('gap', res.url, f'request refused with {res.status}', self.name, 'May be a correct refusal; check the action that caused it.')

    def check_text(self, where: str):
        try:
            text = self.page.inner_text('body')
        except Exception:
            return
        m = BAD_TEXT.search(text)
        if m:
            self.log.add('bug', where, f'placeholder text "{m.group(0)}" on screen', self.name)

    # ---- navigation --------------------------------------------------------------------------
    def sign_in(self):
        p = self.page
        p.goto(BASE + '/')
        if self.mobile:
            p.click('button[aria-label="Open sidebar"]')
            p.wait_for_selector('.sidebar.open .mebtn')
            p.click('.sidebar.open .mebtn')
        else:
            p.wait_for_selector('.mebtn')
            p.click('.mebtn')
        p.click(f'[role=menuitemradio]:has-text("{self.name}")')
        p.wait_for_timeout(800)
        p.wait_for_function("() => !document.querySelector('.entry')?.innerText.includes('Loading')", timeout=20000)
        who = p.inner_text('.mebtn') if not self.mobile else ''
        if not self.mobile and self.name not in who:
            self.log.add('bug', '/', f'sign in as {self.name} did not take (shows "{who[:40]}")', self.name)
        self.log.act(f'{self.name} ({self.role}) signed in to {self.app}')
        self.check_text('home')

    def goto(self, path: str, wait: str | None = None):
        self.page.goto(BASE + path)
        if wait:
            self.page.wait_for_selector(wait)
        self.check_text(path)

    # ---- API as this persona (same headers the browser sends) ----------------------------------
    def api(self, method: str, path: str, body=None):
        headers = {'x-horizon-user': self.person['id'], 'x-horizon-app': self.app, 'Content-Type': 'application/json'}
        res = self.ctx.request.fetch(BASE + path, method=method, headers=headers, data=json.dumps(body) if body is not None else None)
        try:
            data = res.json()
        except Exception:
            data = None
        return res.status, data

    def close(self):
        self.ctx.close()
