# Horizon-lite

Design for **Horizon**, an AI assistant for quality and reliability engineering: test analysis, test authoring, execution, CloudOps and security, with a person in the loop.

- `DESIGN.md`: the experience, navigation, rules and open questions.
- `design/tokens.css`: light and dark design tokens.
- `DATA_MODEL.md`: the data model. `POC_PLAN.md`: the CloudOps and security remediation POC.
- `design/mockups.html`: every mock-up screen (`?scene=home|analysis|authoring|feedback|execution|cloudops|security|context|contextdetail|itemchat|huddle&theme=light|dark`).
- `design/screenshots/`: the rendered PNGs.
- `app/`: the web app (React, TypeScript, Vite). It imports `design/tokens.css` directly, so the app and the mock-ups share one set of tokens.

## Render the mock-ups
```bash
cd design
npm install                      # bundled IBM Plex fonts
pip install playwright && playwright install chromium
python3 render.py                # writes design/screenshots/
```

## Run the app
From the repo root (or from `app/`):
```bash
npm install                      # installs app/ and design/
npm run dev                      # http://localhost:5173 (API inside the Vite dev server)
npm run build                    # type-checks, then builds to app/dist/
```

### Run it as a service (no Vite)
```bash
cd app
npm run build && npm run build:api            # dist/ and server-dist/main.mjs
HORIZON_IDENTITY_HEADER=x-forwarded-email npm start   # behind a sign-in proxy
HORIZON_DEV_IDENTITY=1 npm start                      # or: the development "Sign in as" picker
```
One host, one process, one SQLite file. Environment, data paths, backups and upgrades are in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md); `npm run backup` and `npm run restore-check` are the
backup tools. The future-migration note is [docs/MIGRATION_NOTE.md](docs/MIGRATION_NOTE.md).

### Tests
```bash
cd app
npm test                         # unit and API tests (vitest)
./e2e/run.sh                     # browser checks (Playwright for Python) against a throwaway server
```
The review findings and what fixed them: [docs/FINDINGS.md](docs/FINDINGS.md).

### Connect DeepSeek (optional)
```bash
cp app/.env.example app/.env     # then set DEEPSEEK_API_KEY
npm run dev
```
The key is read only by the server-side `/api` layer (`app/server/`) and never reaches the browser. Optional: `GITHUB_TOKEN` raises the GitHub rate limit for Hexa repo scans, and `HORIZON_DB_PATH` moves the SQLite database (default `app/data/horizon.db`, created on first run), and `HEXA_INGEST_TOKEN` lets CI push test results to Hexa (see `docs/hexa-github-action.yml`). `DEEPSEEK_BASE_URL` can point at any OpenAI-compatible endpoint, such as a self-hosted model. Without a key, the app runs on rules.

So far: every screen in the sidebar works. Home, chat (live agent tree, citations, side panel, rating, approvals), Search, Jira Stories (dummy Jira in SQLite with create and refine), Hexa (test case inventory with GitHub repo scans), Agents (live agent activity and token usage), App Context and Huddle. Every message goes through the agent workflow and guardrails in `app/server/workflow.ts`. The data model is in `DATA_MODEL.md`, and the CloudOps and security POC plan in `POC_PLAN.md`. `npm --prefix app test` runs the unit tests.

`reference/` holds an earlier design hand-off kept locally for comparison; it is not committed.

All names and numbers in the mock-ups are placeholders.
