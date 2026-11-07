"""F15: a file attached in the composer is uploaded first, shown with its real state, sent by id, and kept on the message after reload."""
import json, re, sys
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
    page = b.new_context(viewport={'width': 1360, 'height': 900}).new_page()
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.goto(BASE + '/')
    page.wait_for_selector('.mebtn')
    page.click('.mebtn'); page.click('[role=menuitemradio]:has-text("Mohd Sayeer")'); page.wait_for_timeout(600)
    page.wait_for_selector('.composer textarea')
    page.set_input_files('input[type=file]', [
        {'name': 'notes.md', 'mimeType': 'text/markdown', 'buffer': b'# Notes\nStatements export as PDF nightly.'},
        {'name': 'design.pdf', 'mimeType': 'application/pdf', 'buffer': b'%PDF-1.4 fake'},
    ])
    page.wait_for_function("() => [...document.querySelectorAll('.itemchip')].length === 2 && ![...document.querySelectorAll('.itemchip')].some(c => c.innerText.includes('uploading'))", timeout=15000)
    chips = re.sub(r'\s+', ' ', page.inner_text('.composer .items'))
    check('readable file shows as a plain chip', 'notes.md' in chips and 'notes.md · ' not in chips)
    check('PDF shows as kept, not readable', 'design.pdf · kept, not readable' in chips, repr(chips))
    page.fill('.composer textarea', 'What do the notes say about statements?')
    page.keyboard.press('Enter')
    page.wait_for_url(re.compile(r'/chat/[0-9a-f-]+'), timeout=15000)
    page.wait_for_selector('.turn .msgactions', timeout=20000)
    tags = page.inner_text('.msgtags')
    check('message shows both attachments', 'notes.md' in tags and 'design.pdf' in tags)
    check('message marks the PDF as not readable', 'design.pdf · not readable' in tags)
    run = page.inner_text('.thread')
    check('run shows the attachment step', 'attached file' in run.lower(), run[:300])
    page.reload()
    page.wait_for_selector('.turn .msgactions', timeout=20000)
    tags = page.inner_text('.msgtags')
    check('after reload: attachments still on the message', 'notes.md' in tags and 'design.pdf · not readable' in tags)
    b.close()

bad = [c for c in checks if not c[1]]
print(f'\n{len(checks) - len(bad)} of {len(checks)} checks passed; console errors: {json.dumps(errors[:5]) if errors else "none"}')
sys.exit(1 if bad else 0)
