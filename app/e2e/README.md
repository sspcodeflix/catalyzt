# Browser checks

Playwright (Python) scripts that drive the real app against a throwaway server: fresh SQLite
database, no model key (rules routing), the repository's `.myworkspace`.

- `chat_persistence.py`: story → UAT analysis → reload hydrates the chat and artifact → rating gate →
  low-rating feedback form → approval executes and persists → Hexa shows the manual test → teammate
  reads, cannot add → another application sees nothing → a secret is rejected and never shown.
- `drawer_focus.py`: the mobile sidebar is a modal drawer (focus in, Tab trapped, Escape, focus back, inert page).
- `attachments.py`: files upload on selection, show their real state, go with the message by id, survive reload.

```bash
pip install playwright && playwright install chromium
cd app && ./e2e/run.sh
```
Each script prints PASS/FAIL per check and exits non-zero on a failure or a console error.
