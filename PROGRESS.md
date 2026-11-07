# Overnight run: progress

Plan: [SIMULATION_PLAN.md](SIMULATION_PLAN.md). Assignments: [.myworkspace/ASSIGNMENTS.md](.myworkspace/ASSIGNMENTS.md). Findings: ISSUES.md (written in phase 6).

| Phase | Status | Notes |
|---|---|---|
| 0. Decisions, initial commit | done | Commit `dc7f20f` on `main`, local only. DeepSeek key: not configured at start (see below). |
| 1. Workspace, assignments, clones, backlogs, manual tests | in progress | Scaffold, personas, team configs and ASSIGNMENTS.md written; 5 repos cloned (shallow). Backlogs and manual tests follow. |
| 2. Remove dummy data; multi-app; roles; Sign in as | in progress | Server done: workspace seeding, per-application scoping, roles, coverage from Hexa; 124 unit tests pass. Client: session, Sign in as, recents from the server. Smoke test in progress. |
| 3. Persist chats, App Context, Huddle; minimal feedback form | not started | |
| 4. Local CI runner; UAT readiness from real results; linking | not started | |
| 5. Simulation: three team agents in parallel | not started | |
| 6. Fix, re-run, ISSUES.md, docs | not started | |

## Blockers and notes
- **DeepSeek key:** you added it to `app/.env` during phase 2. Servers started from then on use the model; the token ledger on the Agents page shows the spend.
- **Application names:** decided during phase 2: ABCD is Ram's Portfolio, IBGM is Nabih's Portfolio, WIMT is Jacques's Portfolio. Workspaces are the repository names. No invented domain names anywhere.

## Commits
- `dc7f20f` Horizon: design, React app, agent workflow, Hexa and docs
