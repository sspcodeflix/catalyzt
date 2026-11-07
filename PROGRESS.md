# Progress

Two tracks share this repository: the overnight simulation plan ([SIMULATION_PLAN.md](SIMULATION_PLAN.md))
and the development brief ([docs/CLAUDE_DEVELOPMENT_BRIEF.md](docs/CLAUDE_DEVELOPMENT_BRIEF.md)), which
took over on 8 November 2026 with the finding list F01–F17. The finding-by-finding matrix is
[docs/FINDINGS.md](docs/FINDINGS.md).

## Brief stages

| Stage | Status | Notes |
|---|---|---|
| A. Isolation, identity collisions, secret persistence, approval integrity | done | F01–F05, F13, F14. API test harness (`server/api-harness.ts`). |
| B. HTTP/SSE contracts kept, standalone API, SQLite hardening, backups | done | `server/main.ts`, identity modes, `server/sqlite.test.ts`, `scripts/backup.ts`, `scripts/restore-check.ts`, `docs/DEPLOYMENT.md`, `docs/MIGRATION_NOTE.md`. |
| C. Server-backed chats, ratings, approvals, scoped caches, context, attachments, Huddle; readiness, scans, routing, CI ingestion | done | F06–F12, F14–F17. App Context and Huddle on the server with real passages and persisted decisions. |
| D. Catalyzt branding, UI refinements, browser and keyboard verification, local production start | done | Assets in `app/public/brand/`, preview in `docs/brand/`; `e2e/branding.py`; standalone start checked. |

Verification at the end of stage D: 185 unit and API tests (14 files), 5 browser scripts with 73
checks, type-check, front-end and API bundles built, the bundle started without Vite and probed.

## Known limits (stated, not hidden)
- Retrieval in App Context is keyword overlap; there are no embeddings. PDF, Word, images and ZIP uploads are kept but not read. Confluence and a knowledge fabric are not connected; the UI and API say so.
- Not externally validated: a real GitHub Actions push to `/api/hexa/results` (the payload and semantics are tested against the API), a real sign-in proxy (the header mode is tested with synthetic requests), model-written answers (tests stub the model; the key in `app/.env` is only used when you run the app).
- The wordmark uses Montserrat (OFL), the closest licensed face available offline; the reference sheet's exact typeface is unknown. No trademark clearance is claimed.

## Simulation plan phases (paused while the brief was implemented)

| Phase | Status | Notes |
|---|---|---|
| 0. Decisions, initial commit | done | `dc7f20f`, local only. |
| 1. Workspace, assignments, clones, backlogs, manual tests | partial | IBGM backlog and manual tests committed (`f394ab5`). ABCD and WIMT backlog writers were stopped before they wrote anything; their backlogs are still to be written. |
| 2. Remove dummy data; multi-app; roles; Sign in as | done | `c6f6b2b`. |
| 3. Persist chats, App Context, Huddle; feedback form | done | Through the brief's stages A–C. |
| 4. Local CI runner; UAT readiness from real results; linking | done (runner), evidence delivered | `app/scripts/ci-runner.ts` with `.myworkspace/<APP>/ci.json` targets runs each clone's tests in Docker and posts JUnit to the live server. Delivered: ABCD 3 runs (ach 2,211 Go tests at PR #1922; microservices-demo 19), WIMT 1 run (petclinic 20, all modules), IBGM 1 run (piggymetrics 2: the Maven build stops at auth-service under Java 11, see `IBGM/log/ci-runs.md`). ghostfolio is a heavy target (`--heavy`). Tests are linked to criteria from the Hexa test panel (new link form) or by the simulation personas. |
| 5. Simulation: three team agents in parallel | in progress | `app/e2e/sim/run_sim.py` plays a team (owner and managers in separate sessions) against the live server with the model on `deepseek-flash`. IBGM: dry run and model run done, 6 analyses, approvals, linked evidence, context upload, conflict decided, risk raised, guardrails, phone session. ABCD and WIMT follow once their backlogs land (agents writing them). |
| 6. Fix, re-run, ISSUES.md, docs | in progress | [ISSUES.md](ISSUES.md): S01 (approval ids never reached a fresh answer; fixed), S02 (piggymetrics CI stopped by JaCoCo on Java 11; configuration), S03 (specialists had no Hexa facts; fixed with cited Hexa sources). |

## Notes
- **DeepSeek:** the key is in `app/.env` with `DEEPSEEK_MODEL=deepseek-v4-pro`. Tests and browser checks run without a key (rules routing), so they cost nothing.
- **Application names:** ABCD is Ram's Portfolio, IBGM is Nabih's Portfolio, WIMT is Jacques's Portfolio; workspaces are repository names.
- **Identity:** the "Sign in as" picker is development-only (`HORIZON_DEV_IDENTITY=1`); a shared deployment names people through the sign-in proxy's header (`HORIZON_IDENTITY_HEADER`).
- **Names kept:** environment variables (`HORIZON_*`), request headers (`x-horizon-*`), browser keys (`hz-*`), the database file and the repository folder keep their names for compatibility; the product is Catalyzt everywhere people read it.

## Commits (newest first)
- Stage D: Catalyzt branding and UI refinements
- `633f0d6` F11 App Context and Huddle on the server
- `944a18c` Stage B: standalone API, identity modes, SQLite tests, backup and restore tooling, docs
- `0e5ff56` F15 attachments; Hexa stale-scope guard
- `2a9ebe4` F06, F12, F16, F17
- `6b66a3b` Stage A and browser-side chat persistence (F01–F05, F07–F10, F13, F14)
- `f394ab5` IBGM backlog and manual tests
- `1f6e31f`, `1cf35bf` Phase 3 WIP; seeds emptied
- `c6f6b2b` Phase 2
- `dc7f20f` Initial
