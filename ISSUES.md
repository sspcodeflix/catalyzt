# Issues found by the simulation

Triage of what the simulated teams hit while using Catalyzt (`app/e2e/sim/run_sim.py`, per-team logs in
`.myworkspace/<APP>/log/issues.md`), plus what the exploratory review added. Each entry says how it was
found, what was wrong, the fix and the test that keeps it fixed. Severity: **bug** (wrong or broken),
**gap** (missing or unclear), **nit** (polish).

| # | Severity | Found by | What happened | Cause | Fix | Regression test | Status |
|---|---|---|---|---|---|---|---|
| S01 | bug | IBGM simulation, dry run (Mohd Sayeer, Karim) | After a fresh UAT analysis the approval stayed locked with "Waiting for the answer to be saved" although the rating had been stored. A page reload unlocked it, which is why the earlier browser check never saw it. | The server numbers approvals by their position in the full block list (run, prose, rest); the browser reducer matched that number against the shorter list after the prose, so the approval never received its id until the chat was reloaded. | `src/lib/answerReducer.ts` matches on the same positions the server uses. | `src/lib/answerReducer.test.ts` (3 tests); `e2e/sim/run_sim.py --app IBGM` now approves in the live flow (4 of 4) | fixed |
| S02 | gap | IBGM local CI | piggymetrics reported only 2 of its tests: the Maven build stopped at auth-service. | JaCoCo 0.7.6 (2016) is attached to the test JVM and crashes on Java 11 (exit 134). | `.myworkspace/IBGM/ci.json` skips JaCoCo (`-Djacoco.skip=true`); rerun delivered as attempt 2. | `server/api.test.ts › F17` covers the attempt semantics; the rerun's results are in `IBGM/log/ci-runs.md` | fixed (configuration) |

## Observations that are not defects
- Readiness for the IBGM stories is "not run" rather than "covered" because the manual tests from the backlog are linked to criteria but no automated test is: linking is a person's decision (Hexa test panel, "Link"), and piggymetrics has only a handful of automated tests.
- Guardrail rejections (a pasted key, "merge without approval") are answered by rules without a model call and never stored; the simulation confirms both.
