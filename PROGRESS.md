# Progress

Two tracks share this repository: the overnight simulation plan ([SIMULATION_PLAN.md](SIMULATION_PLAN.md))
and the development brief ([docs/CLAUDE_DEVELOPMENT_BRIEF.md](docs/CLAUDE_DEVELOPMENT_BRIEF.md)), which
took over on 8 November 2026 with the finding list F01–F17. The finding-by-finding matrix is
[docs/FINDINGS.md](docs/FINDINGS.md).

## Brief stages

| Stage | Status | Notes |
|---|---|---|
| A. Isolation, identity collisions, secret persistence, approval integrity | done | F01–F05, F13, F14. Commit `6b66a3b`. API test harness (`server/api-harness.ts`). |
| B. HTTP/SSE contracts kept, standalone API, SQLite hardening, backups | done | `server/main.ts`, identity modes, `server/sqlite.test.ts`, `scripts/backup.ts`, `scripts/restore-check.ts`, `docs/DEPLOYMENT.md`, `docs/MIGRATION_NOTE.md`. |
| C. Server-backed chats, ratings, approvals, scoped caches, attachments; readiness, scans, routing, CI ingestion | mostly done | F06–F10, F12, F15–F17 done. **Open: F11** (App Context and Huddle on the server with real extraction and retrieval; the low-rating → Huddle rule). |
| D. Catalyzt branding, UI refinements, browser and keyboard verification, local production start | not started | Logo reference: `docs/brand/catalyzt-reference.png`. |

## Simulation plan phases (paused while the brief is implemented)

| Phase | Status | Notes |
|---|---|---|
| 0. Decisions, initial commit | done | `dc7f20f`, local only. |
| 1. Workspace, assignments, clones, backlogs, manual tests | partial | IBGM backlog and manual tests committed (`f394ab5`). ABCD and WIMT backlog writers were stopped before they wrote anything; their backlogs are still to be written. |
| 2. Remove dummy data; multi-app; roles; Sign in as | done | `c6f6b2b`. |
| 3. Persist chats, App Context, Huddle; feedback form | chats done; context and Huddle open | See F11. |
| 4. Local CI runner; UAT readiness from real results; linking | not started | Readiness against a target build (F06) and CI ingestion semantics (F17) are in place for it. |
| 5. Simulation: three team agents in parallel | not started | Agents will use the Huddle API once F11 lands. |
| 6. Fix, re-run, ISSUES.md, docs | not started | |

## Notes
- **DeepSeek:** the key is in `app/.env` with `DEEPSEEK_MODEL=deepseek-v4-pro`. Tests and browser checks run without a key (rules routing), so they cost nothing.
- **Application names:** ABCD is Ram's Portfolio, IBGM is Nabih's Portfolio, WIMT is Jacques's Portfolio; workspaces are repository names.
- **Identity:** the "Sign in as" picker is development-only (`HORIZON_DEV_IDENTITY=1`); a shared deployment names people through the sign-in proxy's header (`HORIZON_IDENTITY_HEADER`).

## Commits (newest first)
- Stage B: standalone API, identity modes, SQLite tests, backup and restore tooling, docs
- `0e5ff56` F15 attachments; Hexa stale-scope guard
- `2a9ebe4` F06, F12, F16, F17
- `6b66a3b` Stage A and browser-side chat persistence (F01–F05, F07–F10, F13, F14)
- `f394ab5` IBGM backlog and manual tests
- `1f6e31f`, `1cf35bf` Phase 3 WIP; seeds emptied
- `c6f6b2b` Phase 2
- `dc7f20f` Initial
