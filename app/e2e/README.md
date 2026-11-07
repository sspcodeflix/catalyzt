# Browser checks

Playwright (Python) scripts that drive the real app against a throwaway server: fresh SQLite
database, no model key (rules routing), the repository's `.myworkspace`.

- `chat_persistence.py`: story → UAT analysis → reload hydrates the chat and artifact → rating gate →
  low-rating feedback form → approval executes and persists → Hexa shows the manual test → teammate
  reads, cannot add → another application sees nothing → a secret is rejected and never shown.
- `drawer_focus.py`: the mobile sidebar is a modal drawer (focus in, Tab trapped, Escape, focus back, inert page).
- `attachments.py`: files upload on selection, show their real state, go with the message by id, survive reload.

- `context_huddle.py`: App Context sources from the repositories, honest connector states, uploads read or kept, a
  reported conflict excluded until the owner decides, citations that open the passage.
- `branding.py`: Catalyzt title, mark and wordmark, scope switcher, real home entry points, phone chat/report tabs;
  writes screenshots to `docs/brand/`.

```bash
pip install playwright && playwright install chromium
cd app && ./e2e/run.sh
```
Each script prints PASS/FAIL per check and exits non-zero on a failure or a console error.

## Simulation (`sim/`)
`run_sim.py --app <APP>` plays one team against a running server (default `http://127.0.0.1:5173`, set
`SIM_BASE`): the owner and the component managers each get their own browser session and do what their
role allows, from UAT analyses, ratings and approvals to App Context uploads, a reported conflict, Huddle
votes and decisions, attachments, guardrail checks, reloads and a phone-sized session. Anything odd is
appended to `.myworkspace/<APP>/log/issues.md`; `--no-model` skips the free questions that need the model.
