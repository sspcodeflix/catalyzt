# Overnight run: progress

Plan: [SIMULATION_PLAN.md](SIMULATION_PLAN.md). Assignments: [.myworkspace/ASSIGNMENTS.md](.myworkspace/ASSIGNMENTS.md). Findings: ISSUES.md (written in phase 6).

| Phase | Status | Notes |
|---|---|---|
| 0. Decisions, initial commit | done | Commit `dc7f20f` on `main`, local only. DeepSeek key: not configured at start (see below). |
| 1. Workspace, assignments, clones, backlogs, manual tests | in progress | Scaffold, personas, team configs and ASSIGNMENTS.md written; 5 repos cloned (shallow). Backlogs and manual tests being written by three agents, one per team, from the cloned repositories. |
| 2. Remove dummy data; multi-app; roles; Sign in as | done | 124 unit tests and a 27-check browser smoke test pass; first real DeepSeek answer recorded (deepseek-v4-pro, 1,408 tokens). |
| 3. Persist chats, App Context, Huddle; minimal feedback form | in progress | Server side of chat persistence done (see Handoff). App Context and Huddle: a background agent is moving them to the server; their placeholder seeds are already emptied. |
| 4. Local CI runner; UAT readiness from real results; linking | not started | |
| 5. Simulation: three team agents in parallel | not started | |
| 6. Fix, re-run, ISSUES.md, docs | not started | |

## Blockers and notes
- **DeepSeek key:** you added it to `app/.env` during phase 2, with `DEEPSEEK_MODEL=deepseek-v4-pro`. That model costs about four times deepseek-flash, so expect $8 to $15 for the night rather than $2 to $4. Setting `DEEPSEEK_INTENT_MODEL=deepseek-flash` would put the routing calls on the cheap model. The Agents page shows the actual spend.
- **Application names:** decided during phase 2: ABCD is Ram's Portfolio, IBGM is Nabih's Portfolio, WIMT is Jacques's Portfolio. Workspaces are the repository names. No invented domain names anywhere.

## Handoff: where phase 3 stands (for whoever continues, in this session or the next)

Done, server side (committed as "Phase 3 WIP"):
- `app/src/lib/answerReducer.ts`: one reducer turns workflow events into an answer; the browser renders with it and the server stores with it.
- `POST /api/run` now reduces the events, saves the final answer as a revision (`answer_revisions`, `citations`, `artifacts`, `approvals` with ids) when the browser sends `chatId`, `messageId` and `answerId`, and emits a final `saved` event with the revision id and approval ids.
- `GET /api/chats/:id` returns a chat with messages, latest revisions, my rating and approval states. `POST /api/answers/:revisionId/rating` stores a rating (below 4 stars needs a reason and a comment of 10+ characters). `POST /api/approvals/:id/decision` enforces the rating gate and the owner/component-manager rule server-side and carries out `add_uat_cases` itself.
- `db.lowRatingPatterns(app)` finds low-rating reasons shared 3+ times in 7 days, for the feedback-pattern Huddle rule.

Next, in order:
1. `app/src/lib/chatStore.ts`: rewrite `runAnswer` on `applyEvent`/`answerBlocks`/`finishAnswer`; send `answerId` in the run request; keep reading events after `done` so the `saved` event arrives; add `loadChat(id)` from `GET /api/chats/:id`; make `rateAnswer` and `decideApproval` call the server (remove the client-side `carryOut`); drop the local rating gate in favour of the server's.
2. `app/src/components/chat/AssistantTurn.tsx`: below 4 stars show a small feedback form (reasons per capability from DESIGN.md plus "what did you expect", 10+ characters) before the rating is sent; approvals need `approval.id` (saved) and a rating.
3. `app/src/pages/Chat.tsx`: when a chat is not in memory, load it from the server; show a clear message when it does not exist in this application.
4. When the App Context/Huddle agent reports: in the rating route, call `raiseHuddleItem` for each new low-rating pattern (kind `feedback`, raised by "Horizon"); in `server/workflow.ts`, call `retrieveContext(db, app, text)` before the specialist writes and add the chunks to the prompt as numbered sources, emitting them as citations.
5. Smoke-test: reload keeps a chat; a second sign-in sees the same chat; rating gate and approval work from the database; Huddle and App Context start empty per portfolio.
6. Commit "Phase 3", then phase 4 (local CI runner, linking UI, UAT from results) and phase 5 (the three team simulations).

Background agents started in this session: three backlog writers (one per team) and the App Context/Huddle persistence agent. They belong to this conversation; a brand-new session would lose them. To change the model, use `/model` in this conversation and continue.

## Commits
- `dc7f20f` Horizon: design, React app, agent workflow, Hexa and docs
