Develop Horizon-lite into Catalyzt

Current architecture decision: keep SQLite for this release. This supersedes the earlier PostgreSQL migration recommendation. Prepare a straightforward future migration path, but do not migrate databases or add scalable infrastructure now.

Act as the implementation engineer for this existing repository. Deliver working, tested changes in stages, not only a plan or mockup. Preserve useful code and existing data. Work locally; this brief does not authorize a production deployment, publishing, paid provider calls, or destructive migration of the original database.

Repository: /home/soumya/Documents/AI_Projects/Horizon-lite
Brand reference: /home/soumya/Documents/AI_Projects/Horizon-lite/docs/brand/catalyzt-reference.png
The reference PNG is already included in the project. Open and inspect that file before recreating the logo; no separate image upload is needed when working in this checkout. It is the Catalyzt concept sheet with the C/spark mark, wordmark, tagline and colour variants, not the earlier Horizon sunrise concept.
If this is opened in another checkout, map these paths to its root. In the handoff ZIP, catalyzt-reference.png is bundled beside this brief; use that copy if the repository is unavailable.
Review baseline: commit f394ab5, 8 November 2026. The baseline was rechecked when this handoff was prepared. The previous review passed 124 tests across 10 files and a production build; these tests were not rerun just to prepare this brief. Line numbers below refer to that baseline. Revalidate each finding against the current checkout.

Read project instructions, including AGENTS.md and its RTK.md reference, README.md, DESIGN.md, DATA_MODEL.md, PROGRESS.md and SIMULATION_PLAN.md. Check the current working tree and respect unrelated changes. The project is a React/TypeScript/Vite app with a TypeScript API currently hosted inside Vite and a better-sqlite3 database. Phase 3 is unfinished. The findings below are current defects and incomplete flows, not claims about when they were introduced.

1. PRODUCT AND BRAND

Product name: Catalyzt
Tagline, exactly: Confidence to ship.
Purpose: an AI assistant for quality and reliability engineering, spanning test analysis, test authoring, execution, CloudOps, security, application context and team decisions. Preserve human approval before changes, source-backed answers, explicit application/workspace scope, and honest capability states.

Rename user-facing Horizon branding to Catalyzt: application title, navigation brand, home copy, logo, favicon, metadata and current documentation. Preserve historical records and external identifiers. For environment variables, localStorage keys, API headers and CI secrets, either preserve the existing names with documented compatibility or introduce a versioned migration/alias. Do not do a blind global replacement that breaks configuration, sessions or saved links. The project folder and Git remote do not need renaming.

2. LOGO RECREATION PROMPT

Use /home/soumya/Documents/AI_Projects/Horizon-lite/docs/brand/catalyzt-reference.png as the visual source of truth. Inspect the stored image, then recreate its logo faithfully; do not invent a different concept or substitute a prompt-only interpretation. Preserve the reference PNG unchanged and create the editable production assets as separate files. A text-only generation can approximate this image but cannot guarantee an exact match.

The mark is a bold, open, geometric capital C, with a broad circular stroke and angled terminals. A single crimson triangular needle/spark floats at the open right side and points visually toward the upper right. Match the reference proportions, opening, negative space, angle and spacing. It must read as a C, not a power button, loading spinner or generic four-point AI star.

Use a substantial title-case sans-serif wordmark reading exactly "Catalyzt" (C-a-t-a-l-y-z-t). Match the reference's bold proportions and distinctive z, with careful optical spacing. Place the exact tagline "Confidence to ship." beneath the wordmark, aligned with its left edge and visually quieter.

Colours: crimson #C8102E, ink #17181C, warm paper #FBFAF8; use white for reversed versions. Use flat fills and crisp edges: no gradients, texture, shadows, 3D effects, decorative circuitry or added symbols.

Deliver a clean editable SVG mark and horizontal lockup, transparent PNG exports, light/dark/one-colour versions, a favicon and app-icon assets. Keep the tagline out of tiny icons. Test the mark at 16, 24, 32 and 48px, and inspect both light and dark UI. Include the wordmark font/license or convert a legally usable font to paths for the distribution SVG, retaining an editable source. Do not embed the reference PNG inside an SVG and call it vector artwork. Do not claim trademark clearance.

Integrate the final assets into the existing app and provide a compact preview. If the execution environment lacks image generation, recreate the supplied simple geometry as SVG and state any fidelity limitations; do not claim you generated an image with a tool you did not use.

3. ARCHITECTURE DECISION

Required current target: keep React/TypeScript, extract a standalone Node.js/TypeScript API, and retain SQLite with better-sqlite3 as the authoritative application database. Use a modular monolith on a single host with a persistent local disk. No PostgreSQL migration, Python rewrite, distributed database, external broker or microservices in this release.

The API must start independently of Vite in production. Keep Vite for frontend development/build and use a development API proxy. Preserve and test the HTTP and SSE contracts while separating identity/access, conversations, approvals, evidence, context, integrations and jobs. Reuse the existing workflow, guardrails and shared answer reducer instead of duplicating their behavior.

Use relational tables and constraints for applications, memberships, chats, messages, answer revisions, ratings, approvals, tests, criteria, results, documents and decisions. Use validated JSON text for structured artifact bodies/event payloads where appropriate; keep core relationships relational. Add versioned SQLite schema migrations, indexes justified by query patterns and reproducible local setup. Keep database-specific SQL behind small domain repository interfaces so business logic and HTTP contracts can survive a later database migration. Do not build an unused second database adapter or a generic database framework.

Verify WAL mode on a supported local filesystem, enable foreign-key enforcement on every connection before transactions, and configure a bounded busy timeout. Keep write transactions short; do not hold them across model/network calls or document processing. Document durability and checkpoint settings and test contention, SQLITE_BUSY handling, restart recovery and backups with the actual bundled SQLite runtime. WAL still allows only one writer at a time; it is not a multi-host deployment mechanism. Do not share the database over a network filesystem or replicate application instances against one file.

Use tenant-aware keys and composite foreign keys so child records cannot reference a parent from another application. Generated proposal identities must include full application, story and stable criterion identity. Make answer revisions and action payloads immutable. Execute local approved mutations, decision state and audit writes atomically with idempotency protection. Use a transactional outbox and idempotent execution for future external side effects.

Derive identity from authenticated sessions in shared deployment. Keep the preview identity picker behind an explicit development-only setting; never trust client-selected user IDs in production. Authorize application and component access server-side. Enforce application isolation in repositories, constraints and authorization tests; retaining SQLite does not defer any ownership or approval fix.

For long document processing, scans and imports, persist job state in SQLite and use bounded local execution with retries and idempotency. If a separate worker process is needed, run it on the same host and use atomic job claiming, leases and recovery; keep expensive work outside database transactions. Use persistent local files for original uploads and large binaries, with ownership metadata in SQLite and a small storage interface for a future shared store. Do not introduce Redis, Kafka, Kubernetes, cloud object storage or external vector infrastructure now. Add embedding/retrieval capabilities only when implemented and tested; never report fabricated success.

Python or a different database may be considered later if measured workload or deployment requirements justify them and the user authorizes that scope. For now, preserve the TypeScript workflow, guardrails and event contracts; do not introduce a second backend or database.

4. SQLITE HARDENING AND FUTURE MIGRATION READINESS

Preserve existing SQLite data. Rehearse schema changes against a consistent backup in a disposable environment. Provide versioned, tested schema upgrades that preserve identities, timestamps, relationships and history. Audit pre-existing ID collisions and ambiguous links; report them for resolution rather than silently merging or dropping records. Use a SQLite-supported snapshot/backup mechanism for a live WAL database rather than copying only its main file while writes continue. Document and test restore into a separate database.

Validate row counts, scoped ownership, foreign-key integrity, representative records and application workflows after upgrades and restore. Use disposable file-backed SQLite databases for WAL, multi-connection contention, persistence and migration tests; in-memory databases remain useful for pure unit tests. Do not hide errors by falling back to localStorage.

Write a short future-migration design note covering stable IDs, data ownership, repository/storage boundaries, SQLite-specific SQL, export/import validation, backups and a staged cutover. PostgreSQL can remain a future candidate, not an installed dependency or current deliverable. Defer its adapter, import implementation, infrastructure and database-specific tests until that migration is authorized. Revisit the decision when measured lock contention, write latency, data/backup demands, multi-host deployment or high-availability requirements justify it; do not invent a universal user-count threshold.

5. CONFIRMED REVIEW FINDINGS TO FIX

F01 / P1 — Cross-application chat writes.
Location: /home/soumya/Documents/AI_Projects/Horizon-lite/app/server/api.ts:273
The run endpoint accepts chat/message/answer IDs without validating their application and relationship. An ABCD request using an IBGM chat ID appended messages to IBGM. Reject foreign or mismatched IDs before execution and enforce ownership in database operations.

F02 / P1 — UAT proposal ID collisions.
Locations: /home/soumya/Documents/AI_Projects/Horizon-lite/app/src/lib/uat.ts:41 and /home/soumya/Documents/AI_Projects/Horizon-lite/app/server/db.ts:1067
ABCD-1001 and IBGM-1001 both generate UAT-1001-1. The second upsert overwrites the first application's title and mixes links. Use scoped stable identity and ownership-safe conflict handling.

F03 / P1 — Approval bypass.
Location: /home/soumya/Documents/AI_Projects/Horizon-lite/app/server/api.ts:453
The legacy /api/hexa/manual/from-uat route writes caller-supplied cases without a saved approval, rating or approving-role check. The current browser still calls it. Remove the bypass and execute through a validated server approval.

F04 / P1 — Mutable evidence behind earlier approvals.
Locations: /home/soumya/Documents/AI_Projects/Horizon-lite/app/server/db.ts:1125 and /home/soumya/Documents/AI_Projects/Horizon-lite/app/server/api.ts:362
Artifacts are overwritten under a stable chat/artifact ID. An earlier approval can therefore execute a later revision's payload. Bind decisions to an immutable revision and exact action snapshot; explicitly handle superseded pending approvals.

F05 / P1 — Rejected credentials remain in titles.
Locations: /home/soumya/Documents/AI_Projects/Horizon-lite/app/server/workflow.ts:163 and :198
Prompt-derived titles are saved before the input guard; secret rejection clears message text only. A synthetic password remained in the title. Guard/sanitize messages, titles and derived metadata before persistence and model transmission. Test combined rejection conditions, including overlong input containing a secret. Never log test secrets as proof.

F06 / P1 — Readiness uses stale passes and hides failures.
Location: /home/soumya/Documents/AI_Projects/Horizon-lite/app/server/db.ts:994
Coverage reads cached per-test last_result without selecting a target build and checks for a pass before failure. Compute evidence against explicit repository, branch, commit/build and runs. An old pass cannot cover a test missing from the target build; relevant failures must remain visible. Define skipped, unknown, incomplete and manual results explicitly.

F07 / P1 — Assistant answers are not persisted by normal browser requests.
Locations: /home/soumya/Documents/AI_Projects/Horizon-lite/app/src/lib/chatStore.ts:254 and :332; /home/soumya/Documents/AI_Projects/Horizon-lite/app/server/api.ts:302
The client omits answerId, and returns on done before the later saved event. Send the required identity, consume persistence acknowledgement and retain revision/approval IDs. Use the shared reducer and align durable completion semantics.

F08 / P1 — Reloaded chats do not hydrate.
Location: /home/soumya/Documents/AI_Projects/Horizon-lite/app/src/pages/Chat.tsx:26
There is no existing-chat fetch on route entry. Reloading an analysis shows an API-placeholder message and a missing artifact. Hydrate transcripts and artifacts from the server, with separate loading, missing, access-denied and failure handling that does not disclose foreign resources.

F09 / P1 — Ratings and decisions remain browser state.
Location: /home/soumya/Documents/AI_Projects/Horizon-lite/app/src/lib/chatStore.ts:357
Ratings mutate memory; approvals are locally marked decided before legacy execution. Use revision-specific server rating/decision APIs. Capture required low-rating reasons/comments and show success only after the server confirms it. Preserve the current rating-before-approval policy unless the user explicitly changes it; optional feedback was a design suggestion, not an approved policy change.

F10 / P1 — Old responses overwrite the newly selected application's data.
Location: /home/soumya/Documents/AI_Projects/Horizon-lite/app/src/lib/ticketStore.ts:60
Resetting state does not cancel/invalidate pending requests. A delayed OLD_APP response overwrote NEW_APP. Key caches by user/application/workspace, cancel old requests and reject stale completions. Audit recents, context, inventory and session loading for the same pattern.

F11 / P1 — Context processing simulates success.
Location: /home/soumya/Documents/AI_Projects/Horizon-lite/app/src/lib/contextData.ts:103
File metadata and timers produce Ready and invented chunk counts without processing bytes; retrieval remains empty and the singleton lacks application isolation. Implement real scoped persistence, extraction, retrieval and source-version citations. Unsupported formats/connectors must remain explicitly unavailable, not simulated successes. Persist related Huddle conflicts and decisions and enforce excluded-chunk rules.

F12 / P1 — Partial repository scans remove valid tests.
Locations: /home/soumya/Documents/AI_Projects/Horizon-lite/app/server/hexa.ts:51 and /home/soumya/Documents/AI_Projects/Horizon-lite/app/server/db.ts:701
Failed reads are skipped, then unseen tests are marked removed. A scan reading zero of one files removed three valid tests. Record scan completeness and preserve unread paths; reconcile removals only where complete successful enumeration/processing establishes them. Pin reads to a resolved commit, and verify commit-SHA versus tree-SHA handling. The SHA concern was a follow-up to verify, not a reproduced finding.

F13 / P2 — Explicit authoring becomes analysis.
Location: /home/soumya/Documents/AI_Projects/Horizon-lite/app/server/workflow.ts:274
Known-ticket UAT routing ignores the explicitly selected authoring capability. Route authoring requests to the authoring path while retaining ticket evidence; test explicit composer choices.

F14 / P2 — Repeat analysis loses pending proposal approvals.
Location: /home/soumya/Documents/AI_Projects/Horizon-lite/app/server/db.ts:995
Draft proposals count as existing tests, so the next analysis produces no approval and can say “0 tests manual.” Keep proposals distinct from accepted tests and retain actionable drafts across repeated analyses. A regenerated answer receives a new revision, its own rating, and an approval bound to its immutable payload; explicitly supersede earlier pending approvals. Retrying delivery of the same approval decision remains idempotent and returns its recorded outcome.

F15 / P2 — Composer files disappear on submission.
Location: /home/soumya/Documents/AI_Projects/Horizon-lite/app/src/components/Composer.tsx:235
Only filenames are retained and no attachment IDs/content are sent. Upload actual bytes, validate scope, expose processing/errors, and send attachment IDs. Do not display a usable attachment chip for content the model cannot access.

F16 / P2 — Mobile drawer focus is unmanaged.
Location: /home/soumya/Documents/AI_Projects/Horizon-lite/app/src/components/AppShell.tsx:10
Opening the drawer leaves focus behind it; the next Tab reaches the background theme button. Use a modal dialog primitive or implement focus entry, containment, Escape, restoration and inert background behavior.

F17 / P2 — Documented CI payload omits a required field (additional source-verified issue).
Locations: /home/soumya/Documents/AI_Projects/Horizon-lite/docs/hexa-github-action.yml and /home/soumya/Documents/AI_Projects/Horizon-lite/app/server/api.ts:190
The example push body omits app, which the API requires. Add explicit application configuration and test the sample payload end to end. Scope ingestion credentials and deduplication by application/repository/run/attempt as appropriate; repeated delivery must not duplicate results, and reruns must have defined semantics.

6. UI IMPLEMENTATION

Preserve the warm paper surfaces, restrained crimson accent, IBM Plex typography and desktop conversation/evidence split. Implement these refinements against real behavior:

- Persistent application/workspace selector in global chrome; readable names with IDs secondary. All page data and actions reflect that scope.
- Shorter homepage greeting and practical entry points: Analyse a story, Investigate a failed run, Review a proposed change. Use real recent work or setup guidance instead of invented metrics.
- Clear navigation: Hexa · Tests and Huddle · Decisions, or equivalent plain labels.
- Distinct not-connected, loading, no-data, no-results and error states, with appropriate next actions.
- Remove inactive Share/notification controls or implement them. Never show a permanent fake unread count, fabricated sync version, readiness, chunk count or integration claim.
- Clickable source citations opening the exact source version/passage; show evidence build/commit and freshness. Distinguish routing confidence from correctness.
- Mobile Chat/Report tabs or a dedicated report view instead of stacking the report below the entire conversation. Preserve scroll state and return navigation.
- Accessible drawer, keyboard navigation, visible focus, labels, readable support text and comfortable touch targets. Test desktop/mobile and both themes.
- Approval cards clearly identify application, target, revision, exact proposed changes and resulting action. Keep approval and rating state server-authoritative.

7. REGRESSION TESTS AND COMPLETION CRITERIA

Track F01–F17 in a matrix: reproduction, implementation, automated test and result. Preserve current test coverage and add tests that assert outcomes, not implementation details.

Required scenarios:
- Cross-application reads/writes and mismatched parent IDs are rejected; identical ticket numbers in different applications remain independent.
- Two simultaneous approvals produce one mutation and audit outcome; retries return the recorded outcome. Unauthorized roles and stale/superseded approvals cannot execute.
- New revisions cannot alter an old approval's payload. Local mutation failures roll back without claiming success.
- Guarded secrets never reach stored messages, titles, metadata, telemetry or model requests.
- Chat refresh/deep links restore answers, artifacts, citations, ratings and decisions. Reconnect recovers the same run without another model call. Distinguish explicit Stop from connection loss; server restarts do not leave permanent running states.
- Allocate revision numbers/message order safely under concurrency. Commit durable terminal state before announcing saved completion.
- Slow old-scope responses cannot repopulate the new scope.
- Current-build missing/failed/skipped evidence cannot be covered by an older pass. Repeat analysis preserves draft/approved distinctions.
- Truncated scans and failed reads retain valid inventory; a complete successful scan can remove genuinely absent tests.
- Actual attachment content reaches authorized retrieval, persists after restart and stays isolated by application/workspace/chat. Ready requires usable content. Conflicting excluded chunks remain excluded until an authorized persisted decision.
- Explicit authoring stays authoring. Low ratings persist required feedback and can feed real Huddle patterns.
- Execute the CI example against the API: valid/invalid credentials, missing application, malformed JUnit, replay, reruns, older delivery, upload limits and failed-test result collection.
- Run SQLite constraint, multi-connection contention, schema-upgrade, restart and backup/restore tests, including file-backed WAL cases, plus browser tests for story → analysis → evidence → rating → approval → inventory → reload.
- Use fake providers and disposable databases in automated tests; do not require paid model calls or mutate existing user data.

8. DELIVERY ORDER AND OUTPUTS

Stage A: inspect baseline, reproduce findings, fix isolation, identity collisions, secret persistence and approval integrity with regression tests.
Stage B: stabilize HTTP/SSE contracts, extract the standalone API, harden SQLite configuration and schema migrations, and verify backups/restore. Document future migration boundaries without implementing another database. Preserve behavior and data.
Stage C: finish server-backed chats, ratings, approvals, scoped caches, context, attachments and Huddle; fix readiness, scans, routing and CI ingestion.
Stage D: apply Catalyzt branding and UI refinements, complete browser/keyboard verification and local production startup checks.

Keep each stage runnable and document any change to sequence. Continue authorized local development through verification; ask only for genuinely missing access or consequential product decisions. If an external connector cannot be configured, complete the local implementation/tests and clearly mark the unverified integration.

Deliver working code, SQLite schema migrations and backup/restore tooling, local setup configuration, regression tests, source logo assets/exports, updated README and a finding-to-test matrix. Include the future-migration design note. Document authentication, environment variables, persistent data paths, backups/restore and the single-host deployment boundary. Report exactly what passed, what remains incomplete and what was not externally validated. Do not call a feature complete solely because its UI renders.

Architecture reference notes (for the handoff author and implementer):
- SQLite is the required current database; future migration depends on measured needs and a later user decision. See [SQLite's deployment guidance](https://www.sqlite.org/whentouse.html).
- Vite preview is not a production API server. See [Vite deployment documentation](https://vite.dev/guide/static-deploy).
- WAL requires same-host storage and still permits only one writer at a time. See [SQLite WAL documentation](https://www.sqlite.org/wal.html).
- Set connection behavior explicitly and verify it. See [SQLite PRAGMA documentation](https://www.sqlite.org/pragma.html).
- Use a consistent live-database backup and test restore. See [SQLite backup documentation](https://www.sqlite.org/backup.html).


---

## Follow-up review — 8 November 2026, Asia/Dubai (UTC+04:00)

Scheduled review started at **04:08 GST**. This is an independent verification of the implementation, not a restatement of `docs/FINDINGS.md` or `PROGRESS.md`.

**Result: 6 of F01–F17 are Fixed; 11 are Partially fixed; none are classified Open or Unverified as a whole.** The original happy paths have improved substantially. Passing tests do not close the reproduced residual defects below. Five additional findings are recorded as **F18–F22**. Residual cases of an existing finding retain that finding's ID to avoid duplicates.

### Reviewed state and boundaries

- Reviewed commit: **`ceb814edbb8ad09ade0c3a19e927542b18954973`**. The earlier review baseline was `f394ab5`.
- Working tree at capture, **04:09:28 GST**: modified `.myworkspace/IBGM/log/issues.md`, `app/package.json`, `app/package-lock.json`; untracked `.myworkspace/ABCD/log/backlog-notes.md`, `.myworkspace/ABCD/manual-tests.csv`, `.myworkspace/ABCD/stories.json`, `.myworkspace/IBGM/log/review-shots/`, `.myworkspace/IBGM/log/sim-20261108T030717.json`, `.myworkspace/WIMT/log/`, `.myworkspace/WIMT/manual-tests.csv`, `.myworkspace/WIMT/stories.json`. These belong to the existing development work and were preserved.
- Tests/builds used a stable source snapshot at `/tmp/catalyzt-followup-20261108-0408`, including the uncommitted package changes. The snapshot excluded real databases, `.env` files, uploaded data, and workspace simulation data. Fixture databases, upload stores and fake providers were used for reproductions. No paid model call, external GitHub mutation, real-data write, checkout/reset/revert, or application-source edit was performed.
- **Keep React/TypeScript, standalone Node.js/TypeScript and SQLite/better-sqlite3.** The current implementation follows that direction. PostgreSQL, a Python backend rewrite and distributed infrastructure remain deferred. Python browser-test scripts are test tooling, not a backend migration.
- File/line references below refer to this reviewed snapshot. Concurrency/hash verification and the final working-tree check are recorded at the end of this append.

### F01–F17 status matrix

| ID | Status | Verified behavior, current evidence, and remaining work |
|---|---|---|
| F01 | **Fixed** | Cross-application/foreign-owner chat writes and mismatched parent IDs are rejected. `app/server/api.ts:351–360`, `app/server/db.ts:515–519`. API regressions and an independent middleware harness returned 404 for a foreign-application chat and 409 for a mismatched message, without adding the attempted turn. |
| F02 | **Fixed** | Proposal identity includes the full story/criterion and application. `app/src/lib/uat.ts:53`, `app/server/db.ts:1248`. Tests and a separate reproduction produce distinct ABCD-1001/IBGM-1001 proposal/database IDs without multiplying proposals on re-analysis. |
| F03 | **Fixed** | The legacy manual-from-UAT route returns 404; decisions use the frozen server payload and require a saved rating and approving role. `app/server/api.ts:481–484,719`. Missing-rating/role checks and concurrent/idempotent decision tests pass. Component-level authorization is a separate defect, F19. |
| F04 | **Fixed** | Server-allocated revisions, per-revision artifacts, frozen approval payloads and expiry of superseded pending approvals are implemented. `app/server/db.ts:1297–1342,1470–1482`. Reproduction retains r1 and r2 and two artifact rows; existing tests cover immutable payload, supersession and transactional rollback. Historical App Context citations have a separate versioning defect, F20. |
| F05 | **Partially fixed** | Current message/title and combined overlong-secret cases are protected before persistence (`app/server/workflow.ts:165–179`); synthetic-secret dump checks pass. Assistant history and uploaded/retrieved text bypass the same boundary (`workflow.ts:217,322–337`; `app/server/attachments.ts:137–145`; `app/server/context.ts:438–451`). Fake-provider checks confirmed recognized synthetic credentials reaching model request bodies; details below. |
| F06 | **Partially fixed** | Individual latest-run missing/skipped results, reruns and failure-before-pass logic now pass tests. However `app/server/db.ts:1114–1115,1158` selects a single workflow run per repository. A passing unit run can hide an integration failure on the same commit and change the criterion to passing. |
| F07 | **Partially fixed** | Browser requests send `answerId` and read through `saved`. Fresh browser analysis/rating/approval survives reload. `app/src/lib/chatStore.ts:370–387` still treats `done` as sufficient and silently ignores a later lost `saved` acknowledgement; the answer remains without a revision ID and cannot be rated until reload. No automatic reconciliation was observed. |
| F08 | **Partially fixed** | Normal deep links hydrate persisted transcript, artifact, rating and decision, verified in the browser. `app/src/pages/Chat.tsx:40–42` omits session/application identity from hydration dependencies. An isolated compiled-component reproduction of missing-chat in B → switch to owning app A starts no new lookup and remains loading. |
| F09 | **Partially fixed** | Rating/decision endpoints persist results and enforce low-rating feedback and approval gating (`app/server/api.ts:447–484`); browser reload and concurrent decision checks pass. A delayed r1 rating response updates whichever revision is currently displayed (`app/src/lib/chatStore.ts:417–418`), so r2 can incorrectly appear rated. |
| F10 | **Partially fixed** | The original delayed stories response is discarded; most stores now use a session epoch. `app/src/lib/chatStore.ts:53–55` checks the epoch before awaiting the JSON body, then assigns without checking again. A delayed old-scope body restores the old person's recent-chat titles after the new list has loaded. |
| F11 | **Partially fixed** | Real bytes/passages, application/workspace retrieval, unsupported-format states, persisted Huddle votes/comments/decisions, owner gating and conflict exclusion are covered by passing context/Huddle/API tests. Browser shows real fixture passages and explicit Confluence/Fabric unavailability. `app/server/context.ts:292–305` still replaces cited source versions (F20), and the UI still claims live/periodic Jira syncing for the local fixture-backed feed (F22). |
| F12 | **Partially fixed** | Failed reads and truncated listings retain inventory; commit SHA is now distinguished from tree SHA. The file-size filter at `app/server/github.ts:210` hides existing oversized paths from `app/server/hexa.ts:84`; `app/server/db.ts:815` then removes their tests as if the files were deleted. A 300 KB fixture file reproduced three removed tests. |
| F13 | **Fixed** | Both explicit-authoring regression tests pass; the selected authoring capability gets ticket evidence and is no longer forced into UAT analysis (`app/server/workflow.ts:286`). Auto mode ignoring its resolved authoring intent is recorded separately as F21. |
| F14 | **Fixed** | Proposed cases are excluded from existing coverage and accepted manual tests are preserved (`app/server/db.ts:1142,1241–1250`). The HTTP regression verifies repeated analysis retains its proposal/approval, then approval and another analysis recognize the accepted manual test. F04 checks also verify revision-bound approval supersession. |
| F15 | **Partially fixed** | Bytes are uploaded, server-scoped attachment IDs are passed to runs, and unreadable formats are disclosed. Existing attachment/API tests pass. `app/src/lib/attachments.ts:28–34` reads the file before resolving request identity; a scope switch during FileReader processing uploads it as the next person/application. |
| F16 | **Partially fixed** | On a 390 px viewport, opening the drawer focuses Close, Shift+Tab wraps inside, background is inert, and closing restores focus to Open sidebar. Widening to 1200 px while it is open leaves the entire main area inert with the close button/scrim hidden. `app/src/components/AppShell.tsx:14–31`, `app/src/global.css:22,93,95–99`. Confirmed in the browser. |
| F17 | **Partially fixed** | The CI example includes `app`; scoped token checks, duplicate delivery and attempt 2 pass API checks. `docs/hexa-github-action.yml:69–76` omits authoritative run timing. `app/server/api.ts:257` and `app/server/db.ts:968` substitute arrival time, so a delayed older example-shaped run replaces the newer target build. |

### Residual defects under the existing IDs

**F05 / P1 — Apply the secret boundary to all material entering storage or a model.** A safe current prompt with a recognized synthetic credential in browser-supplied *assistant* history reached both router and specialist requests: `workflow.ts:217` filters only user turns, and `app/server/prompts.ts:149` forwards assistant history. Separately, upload a Markdown file containing a generated password-like token through `addAttachments` or `addUploads`; it becomes `ready`, is stored unchanged, and a safe question about the file forwards the token to the fake provider. Root reproduction reported `guardRecognizes=true`, both stored flags true and `fakeProviderReceivedSecret=true`, without printing the token. Guard all history roles, readable attachment bytes, repository/context passages and derived metadata before persistence/transmission. Prefer server-owned conversation history. Regressions must inspect database/blob/model boundaries and log only booleans or counts.

**F06 / P1 — Aggregate evidence for a build across its relevant workflows.** In one repository/branch/commit, record integration test A failing, then unit test B passing a minute later; both tests are linked to the same criterion. `targetBuild` selects only the unit run, A becomes “missing”, and `coverageFor` reports passing. Select the intended commit and the relevant workflows' latest attempts, preserving failure precedence; explicitly represent incomplete evidence. An unrelated workflow's success must not erase a failure on the same build. Extend the existing four F06 regressions with this multi-workflow case.

**F07 / P2 — Reconcile completion when the SSE persistence acknowledgement is lost.** Feed the real store `text → done → connection failure`, omitting `saved`. The harness ends with `status=done`, no revision ID and zero recovery GETs; rating is disabled. Track execution completion separately from persisted completion and fetch the saved run/chat when the stream ends without its acknowledgement. Recover the same run without another model call. Also verify connection loss versus explicit Stop and process-restart behavior; a normal reload passing does not prove reconnect recovery.

**F08 / P2 — Re-run hydration when application identity changes.** Resolve a chat as missing while app B is selected, then switch to app A, where it exists. With `loaded=true` and `chat=undefined` on both sides, the effect's dependencies do not change and no request starts. Include the settled application/session epoch in the loader's dependencies. Test this transition in addition to opening a deep link in an already-correct application.

**F09 / P2 — Apply a rating response only to its exact revision and scope.** Begin a rating POST for r1, Retry into r2, then resolve the original POST. The server rated r1 correctly, but the browser marks r2 as rated 5. Capture revision and epoch and verify both before updating the store; prevent or explicitly handle concurrent retry/rating saves. The server approval gate still protects execution, but the displayed state and enabled client gate are wrong.

**F10 / P1 — Check scope after the whole response has been read.** Resolve old `/api/chats` headers, pause its `json()`, switch scope and load the new recents, then finish the old body. Old-scope chat titles replace the new list. Parse first, then check the captured epoch immediately before assignment. Audit all asynchronous response-body and mutation completions, not just fetch completion. The original ticket-store reproduction now passes and should remain covered.

**F12 / P1 — Preserve paths skipped because of size.** Stub GitHub's complete tree with one existing 300 KB test file and one readable small file. The large file is filtered out before `listedPaths` is constructed; the scan reports `complete=true`, zero failed files, and removes three existing tests from that still-present file. Keep the full eligible path inventory separate from readable candidates; represent skipped/oversized files and prohibit deletion based on those omissions. Test a small file growing beyond the 256 KB limit.

**F15 / P1 — Bind upload preparation to the initiating scope.** Start FileReader as person/application A, switch to B before its callback, then complete the read. The actual upload helper calls `http` with B's identity. Capture the epoch before reading and reject before sending or applying a response if it changed. Clear/remount composer attachment state on scope changes (`app/src/pages/Home.tsx:68` currently keeps it mounted). Test both a person change and an application change, including delayed upload responses.

**F16 / P2 — Clear mobile modal state when crossing the desktop breakpoint.** Open the drawer at 390 px and widen to 1200 px. DOM inspection confirmed `main[inert]` remains true; the accessibility tree exposes only the sidebar while CSS hides the close controls. Listen for breakpoint changes and close/reset the drawer, preserving sensible focus. Keep the now-passing mobile entry, trap and restoration behavior.

**F17 / P1 — Send and validate authoritative run/attempt timing.** Deliver example-shaped run 9002/commit `bbbbbbbb`, then delayed older run 9001/commit `aaaaaaaa`, neither with `startedAt`. The target switches to 9001 because ingestion time becomes run time. Include authoritative workflow run/attempt timing in the sample, validate it server-side, and define a safe missing-timestamp policy. Arrival order must not establish build recency. Re-run the example payload test with late deliveries, not only hand-built payloads that already supply timestamps.

### New findings

**F18 / P1 — A malformed static URL crashes the standalone API process.**

- **Impact:** An unauthenticated malformed request can terminate the one process serving the whole application.
- **Evidence/reproduction:** The actual bundled `server/main.ts` was run with a disposable database/static index and socket binding mocked. Passing `GET /%` to its request listener produced `URIError: URI malformed` and Node exited 1. `app/server/main.ts:94` discards the asynchronous middleware promise; `:101–102` decodes the path without a catch. The non-API callback is invoked before the API's error-handling block (`app/server/api.ts:203`).
- **Remedy/verification:** Return 400 for malformed URL encoding, handle rejected handler promises and file-stream failures, and assert a subsequent health request still succeeds after malformed requests. This does not require an architecture or database change.

**F19 / P1 — Component managers can approve another manager's component changes.**

- **Impact:** The application role grants broader approval authority than the component ownership model intends. `SIMULATION_PLAN.md:14` explicitly limits a component manager to changes to their components.
- **Evidence/reproduction:** In the fixture, assign `checkoutservice` to Ram and leave Sourav managing only `frontend`. Sourav can still rate and approve the checkout story's proposal: API 200, one manual test created, Sourav recorded as approver. `app/server/api.ts:481–484` checks the application role only, never the frozen action's component targets against `components.manager_id`.
- **Remedy/verification:** Authorize every target component from the frozen payload before execution. App owners may retain application-wide approval. Define safe handling for unowned or multi-component targets and test allowed ownership, foreign ownership and mixed ownership; the denied action must write neither tests nor a successful approval outcome.

**F20 / P1 — Historical App Context citations silently point to replacement evidence.**

- **Impact:** A saved answer can label a citation “v1” while its link opens v2 text, so the evidence that supported the answer can no longer be inspected.
- **Evidence/reproduction:** Retrieve the fixture's 45-day refund passage at v1, change both local source documents to 365 days, then `syncSource`. The old `/context/source/ABCD-repo-shop#chunk-2` link now resolves to the 365-day text. `app/server/context.ts:139–140` omits a version in the link; `:292–305` deletes and recreates chunks under the same IDs. `app/server/workflow.ts:337` persists the old version label but that mutable link.
- **Remedy/verification:** Preserve immutable source versions/chunks, bind citations to their exact version and passage, and expose that historical version in the source view. Test a saved answer's citation after sync, after changed chunk ordering and after restart. The approval payload immutability verified under F04 does not solve this separate source-history problem.

**F21 / P2 — Auto mode discards a resolved authoring intent for UAT tickets.**

- **Impact:** A normal natural-language request to write automation receives a readiness analysis instead.
- **Evidence/reproduction:** Ask “Write UAT automation for ABCD-1001” in Auto; the fake router returns `capability: authoring`, but the workflow runs UAT analyst and no Authoring agent. `app/server/workflow.ts:286–287` treats every Auto request as `analysisWanted`, regardless of the resolved intent.
- **Remedy/verification:** Use the resolved capability to decide whether the UAT analysis shortcut applies while preserving an explicitly selected agent. Keep the passing F13 explicit-picker tests and add an Auto-mode router-authoring regression.

**F22 / P2 — Jira's displayed live-sync/freshness claims exceed the implemented connector.**

- **Impact:** Users can treat local fixture/cache data as current external Jira evidence.
- **Evidence/reproduction:** On the disposable fixture with no Jira connector, App Context shows “synced every 15 min” and “Stories are retrieved live from the Jira feed.” `app/server/context.ts:309–311,368` generates these claims, and `app/src/pages/AppContext.tsx:317` repeats the periodic-sync text. `app/server/api-context.ts:60` identifies Jira as `dummy`; `app/server/api.ts:703–705` only calls `markSynced` and returns local rows. No connector fetch happens on that route. `POC_PLAN.md:72` describes the local dummy implementation.
- **Remedy/verification:** Clearly label the local/workspace Jira source and its actual import/refresh time. Do not advance an external-sync freshness claim when only reading local rows. Display a periodic/live integration claim only when an implemented connector has successfully synchronized. Verify the no-connector UI independently of the eventual real integration.

### Tests, UI observations and limitations

- **Existing tests:** `npm --prefix app test -- --no-cache` — **192 passed across 15 files** (7.23 s), including SQLite migration/constraint/contention/recovery cases, API authorization/approval tests, context/Huddle tests and workflow/provider stubs. Expected input-guard rejection messages were the only reported test stderr. Local HTTP binding required sandbox escalation; tests then completed. No dependency download or paid model call was needed.
- **Builds:** `npm run build` passed (157 modules; JS 463.79 kB, 145.12 kB gzip; CSS 66.00 kB, 11.26 kB gzip). `npm --prefix app run build:api` passed (285.5 kB bundle). Neither reported a build warning. Outputs were confined to the temporary snapshot.
- **Independent checks:** executable fake-provider/middleware/store harnesses reproduced the residuals and new findings above. These are targeted checks, not extra tests counted in the 192. Reproduction files remain in `/tmp/catalyzt-evidence-repro.ts`, `/tmp/catalyzt-frontend-followup.cjs`, `/tmp/catalyzt-chat-hydration-followup.cjs`, and the snapshot's `app/.review-root.ts` and `app/.review-server/`. Their essential setup, observed results and remedies are recorded above so the brief does not depend on temporary files surviving.
- **Browser verification:** ran the built standalone API on loopback with `/tmp/catalyzt-review-ui.sqlite`, seeded only from test fixtures, and model access disabled. A fresh UAT analysis acquired usable rating/approval controls, a five-star rating and approval persisted, and reload restored the answer, report and recorded outcome. The 390 px phone report used Chat/Report navigation and fit the viewport without document-level horizontal overflow. Drawer focus entry/wrap/restore passed; the desktop-transition failure was reproduced. Browser tab and test server were closed afterward, and the viewport override was reset.
- **Design observations, not defects:** the Catalyzt C/crimson-needle mark, wordmark and “Confidence to ship.” tagline are integrated into the home/navigation experience. Global scope selection, concrete entry cards and phone report separation make the product easier to understand. Keep this direction. The licensed-font approximation is already documented; exact reference-font fidelity and trademark clearance are not asserted. The home view still has a fairly dense set of capability cards below the primary actions; reducing that density is optional polish, not a release blocker.
- **Limits:** the existing Python browser suite's claimed 73 checks was not rerun as a suite; the browser checks above are this review's direct evidence. This was not a complete screen-reader, contrast or both-theme accessibility audit. No real SSO proxy, Jira/Confluence connector, GitHub Actions delivery, live provider, production workload or production restore was exercised. SQLite tests passing do not prove workload capacity. Automatic SSE replay/reconnect and full crash recovery remain incomplete/unverified beyond the specific tests and reproductions stated above.
- **Next development order:** fix F18/F19 and the remaining P1 secret/isolation/evidence/scan issues first; then finish chat recovery/rating/hydration races, responsive drawer state and honest connector wording. Add outcome-based regression tests for each reproduction, rerun the suite/build/browser paths, and update completion claims to match verified behavior. Keep all changes within the existing TypeScript/SQLite architecture.

- **Uncommitted workspace validation:** read-only parsers checked ABCD (16 stories, 9 manual tests, 48 steps) and WIMT (16 stories, 9 manual tests, 42 steps). No workspace warnings, duplicate keys, wrong project prefixes, empty criteria, CSV parser errors, unknown story/component references or invalid criterion links were found. Manifest/lock specifications and direct dependency entries match; the added `@huggingface/transformers` resolves to installed/locked 3.5.2. Backlog factual correctness and the embedding/model-download path were not exercised.

- **Final concurrency check — 2026-11-08 04:18:37 GST:** HEAD is still `ceb814edbb8ad09ade0c3a19e927542b18954973`. All 189 captured source/document/config files match their pre-review hashes; no code change was detected during review. The working-tree state remained the capture state above before this append. The brief was re-read and its original bytes verified immediately before appending; only this dated appendix was added. No pre-existing content was replaced. The only intended project edit from this review is `docs/CLAUDE_DEVELOPMENT_BRIEF.md`.


---

## Data-model and scalability review — 8 November 2026, Asia/Dubai

**Assessment:** the relational model is a useful foundation, but scalability has not yet been established. Keep **SQLite/better-sqlite3 and the TypeScript backend** for this release. Fix the integrity issues and bound the work performed per request before increasing the workload. A database replacement alone would not correct the evidence model, cross-application identities, unbounded reads or CPU-heavy matching.

Reviewed **`77af06d6bdb29347a375b36213d10f86f4fe8b24`**, including the new hybrid retrieval implementation and migration 11. Line references and measurements below refer to that reviewed commit. This is a focused data-model review, not a fresh closure assessment of every earlier F01–F22 item. Existing observations F06 and F20 are referenced below rather than assigned duplicate IDs. All experiments used disposable databases, synthetic content or fake embedding providers; no live database, paid provider, model download or application-source change by this reviewer was involved. Claude made concurrent source edits near the end of review, recorded below.

### What is already sound

- Relational entities for applications, membership, conversations, answer revisions, ratings, approvals, tests/results and Huddle decisions give the product a coherent foundation.
- Revision-bound artifacts and frozen approval payloads, with local execution and decision recording in one transaction, are worth retaining.
- WAL, an explicit busy timeout, foreign-key enforcement, transactional versioned migrations, online backups and disposable restore tests are implemented. These are useful operational foundations, not proof of production capacity.
- Uploaded bytes are separated from relational metadata through a blob-store interface. Keep that boundary so storage can change later without rewriting the domain model.

### New actionable findings: F23–F28

**F23 / P1 — Requirement identity is not application-scoped and normal seeding creates cross-application links.**

- **Evidence:** `app/server/schema.ts:42–44` makes `requirements.id` globally unique. `app/server/db.ts:1668–1669` inserts a requirement with `INSERT OR IGNORE`, then links the story to that ID without checking its application.
- **Reproduction/impact:** Give an IBGM fixture story requirement `FR-0231`, already present in ABCD. The IBGM story links to the requirement whose `application_id` is ABCD. This is a normal seeding-path defect, not merely a hypothetical direct-SQL bypass. Repeated external numbers will become more likely as teams and integrations are added.
- **Remedy:** Separate durable internal identity from display/external identifiers. Use a scoped unique external key such as `(application_id, source_system, external_id)` and link by the internal requirement ID. Migrate existing relationships without merging applications. Regression: two applications use the same requirement number, retain different records and links, and reject a foreign-application association.

**F24 / P2 — Retrieval loads and ranks the whole application's corpus for every question.**

- **Evidence:** `app/server/context.ts:533–559` loads every passage and its vector for an application; workspace/status filtering happens afterward at `:618`. `app/server/retrieval.ts:313,328,335–340` scores and sorts the complete candidate collection before selecting the small reranking set. Returning four passages does not bound the work.
- **Reproduction/impact:** With synthetic 1,032-character passages and keyword mode, the actual `retrieveContext` call returned four passages but took **12–22 ms at 1,000 passages**, **113–126 ms at 10,000**, and **607–646 ms at 50,000** across four calls per size. Essentially all that time elapsed before the first asynchronous yield. Other requests and SSE processing sharing the Node event loop can be delayed. These were in-memory fixture measurements, without model inference, HTTP overhead or production contention.
- **Remedy:** Apply application/workspace/eligibility filters in SQL and retrieve a bounded candidate set before loading passage bodies/vectors. Use SQLite FTS5 for indexed lexical candidates; define and test a bounded semantic candidate strategy that preserves useful recall. Keep expensive ranking/inference off the HTTP event loop and cap concurrent work. A lexical-only prefilter must not silently remove the semantic matches that hybrid retrieval was introduced to find. Verify both relevance quality and latency as the corpus grows.

**F25 / P2 — Re-indexing during embedding can persist an obsolete vector as current.**

- **Evidence:** `app/server/retrieval.ts:402–414` reads chunk text, awaits embedding, then writes under the original chunk ID without rechecking its text hash/version. `app/server/context.ts:312–319` deletes changed chunks and reuses the same `<source>#<sequence>` IDs. The foreign key checks existence, not whether the content is still the content embedded.
- **Reproduction/impact:** Pause a fake embedder after it receives the fixture's old refund text, change the document, run `syncSource`, then release the embedder. The job finishes with two vector rows, **one whose `text_sha` differs from the current chunk text**, after one embedding call. The pending-job query sees a vector row and does not repair it. Retrieval can rank current content using an obsolete vector while reporting it embedded.
- **Remedy:** Bind embeddings to immutable chunk/source versions, model identity and content hash. Before writing, compare the expected hash/version with the current row; discard obsolete results and queue the new content. Pending selection and retrieval must reject stale hashes, with vector dimension/byte-length validation. Regression: pause embedding, re-index, resume, and verify every stored/used vector matches its exact content version.

**F26 / P2 — A negative page size bypasses the test-list limit.**

- **Evidence:** `app/server/api.ts:534` and `app/server/db.ts:704` apply `Math.min` without a positive lower bound. `limit=-1` reaches SQLite's unlimited `LIMIT` behavior.
- **Reproduction/impact:** Against 25,000 synthetic tests, `limit=50` returned 50 rows in roughly **3.8 ms**; `limit=-1` returned all 25,000 in **205 ms**, synchronously, before serialization. The API's intended 200-row cap can therefore be bypassed.
- **Remedy:** Validate finite integer limits and offsets at the API boundary and enforce bounds again in the repository. Reject or normalize negative, fractional and non-finite values; keep a hard maximum. Use cursor pagination for growing ordered lists. Regression: malformed limits never return more than the configured cap.

**F27 / P2 — An upgrade leaves legacy approvals pending with an unusable payload.**

- **Evidence:** `app/server/schema.ts:612` adds `payload` with default `{}` without backfilling or expiring old pending approvals. `app/server/sqlite.test.ts:150` currently expects that empty payload.
- **Reproduction/impact:** Upgrade a disposable v6 database containing a pending UAT approval and its valid one-case artifact through `openDb` to v11. Foreign-key validation passes and the artifact survives, but the approval remains `pending` with `payload: {}`; the current handler cannot execute it. Schema integrity passing does not establish business-state migration correctness.
- **Remedy:** Backfill only when the exact historical action can be reconstructed safely and verified; otherwise expire the approval explicitly with a reason and a re-analysis path. Add upgrade tests that assert usable or explicitly retired workflow states, not just column presence and row counts.

**F28 / P2 — Restore validation overlooks uploaded App Context blobs.**

- **Evidence:** `app/scripts/restore-check.ts:62–64` checks storage keys only from `attachments`, excluding non-null `context_sources.storage_key` values.
- **Reproduction/impact:** A disposable backup with an uploaded context source, its blob missing, and an explicitly supplied empty files directory exits **0**, with no problems or missing-file warnings. A restore can be declared successful while original knowledge-source files are absent.
- **Remedy:** Validate both chat-attachment and App Context storage references, including file existence and available size/hash metadata. Report “file validation not performed” distinctly when no file directory was supplied. Regression: a missing context blob makes the restore check fail, while a complete database-plus-files restore passes.

### Required model and access-pattern hardening

These requirements include reproduced model gaps and measured growth risks. They do not assert a new HTTP exploit or assign a capacity guarantee.

| Area | Current evidence | Required direction |
|---|---|---|
| Tenant relationships | Disposable DB accepted an ABCD chat with an IBGM workspace, an IBGM run with an ABCD test, and an ABCD test linked to an IBGM criterion; `foreign_key_check` reported no violations. See `schema.ts:50,413,518`, `db.ts:1100`. The fixed F01 HTTP route remains a separate protection. | For relationships joining independently scoped parents, enforce same-application identity with composite foreign keys/unique keys and repository checks. Keep single-parent children normalized. Replace important polymorphic reference strings with typed relationships or an explicit validated association layer. Test jobs/imports directly, not only HTTP handlers. |
| Historical evidence — existing F20 | Current `context.ts:312–319` still removes old passages and reuses IDs; `db.ts:1319` persists a citation link/version label without a durable historical chunk relationship. Re-indexing v1 to v2 removes all v1 passages. | Model `context_source → source_version → chunk → embedding`, with citations referencing the exact immutable version/chunk. Retention must preserve evidence used by answers, approvals and evaluations. |
| Build evidence — existing F06 | `db.ts:1113–1117,1160` selects a single run for a repository and reads results only from it. | Represent repository/build identity separately from workflow runs and attempts: `build → workflow/job → attempt → test_result`. Select the target commit/branch explicitly, combine the required workflows' latest attempts, and retain failed/missing/skipped distinctions. Define the expected workflow set so incomplete CI cannot appear complete. |
| Story hydration | `api.ts:390` loads the whole story backlog for each chat request; `api.ts:352` hydrates it merely to count on Home. `db.ts:297–299,480–483` performs child queries per story. A file-backed fixture with 10,003 stories took **67 ms** to hydrate. | Fetch only requested/detected story keys, use a count query for counts, batch dependent reads and paginate backlog lists. |
| Conversation/Huddle growth | `db.ts:1361–1417` loads the full chat and performs queries per answer. `huddle.ts:159` loads every item and `:116–129` loads options/votes/comments/links per item. | Load recent message/item summaries first, use stable cursors and fetch detailed history on demand. Keep answer revision and approval identity stable across pages. |
| Usage reporting | `db.ts:658–674` repeatedly aggregates history; `agentsStore.ts:123` polls usage every four seconds. At 100,000 model-call rows, a fixture query took **88 ms** and delayed a zero-delay timer about **90 ms**. | Use application/time-scoped queries and incremental summaries or bounded caches; do not recompute all-history breakdowns for every viewer/poll. |
| Result ingestion | `ingest.ts:75` calls `results.ts:29,35`, repeatedly filtering the candidate inventory. Matching 1,000 synthetic results against 25,000 candidates took **484–736 ms** before database writes. | Build name/suite/path lookup maps once per import while preserving ambiguity rules. Put substantial parsing/matching in bounded worker work; keep SQLite transactions short. |
| Query-aligned indexes | `EXPLAIN QUERY PLAN` shows full scans and temporary sorts for application-scoped scan/upload histories (`db.ts:829,1214`). Target-build lookup also needs sorting after its existing application/repository filter. | Add composite indexes justified by actual predicates and stable ordering, including application and time/ID fields where appropriate. Verify plans and write overhead on representative data. Avoid indexing every column speculatively. |
| History, files and models | Runs/results, model calls, revisions, audit events, uploads and old embedding-model rows accumulate. | Define application quotas and retention/archive policies, orphan-file cleanup and old-model cleanup. Preserve referenced evidence and required audit records; garbage collection must be reference-aware. Measure DB, WAL and blob growth. |
| Future migration boundary | `HorizonDb` is `ReturnType<typeof openDb>` (`db.ts:260`), with synchronous methods and `db.raw` SQL used by context, Huddle and retrieval. `docs/MIGRATION_NOTE.md` understates the work implied by “same signatures.” | Introduce explicit domain repository interfaces, required tenant parameters and transaction contracts. Keep database-specific SQL/PRAGMAs behind the SQLite implementation. Plan asynchronous I/O boundaries for a future client/server adapter; do not add another backend/database now. |

Do not add organization-wide tenancy or distributed infrastructure merely for hypothetical scale. If external Jira/source IDs can overlap across connectors, scope those external IDs by application and connector/source while keeping stable internal IDs. Short display identifiers should not be the sole durable uniqueness mechanism for large inventories (`db.ts:253–257` currently truncates test identity hashes).

### Scalability acceptance criteria for Claude

1. Fix F23–F28 and the existing F06/F20 evidence-model gaps with migrations and outcome-based regression tests. Preserve current user data and approval history.
2. Keep the application on one host with SQLite WAL and better-sqlite3. Cap requests, uploads and background concurrency; keep transactions short and exclude model/network work from them. SQLite WAL permits concurrent readers with a writer but still has **one writer at a time**, and its shared-memory design requires the same host. [SQLite WAL documentation](https://www.sqlite.org/wal.html).
3. Establish a repeatable, disposable load-test profile covering multiple applications, large result history, long chats and concurrent ingestion/retrieval. Include the measured 50,000-passage, 25,000-test and 100,000-model-call cases as regression profiles, not as claimed production capacity. Add larger result-history cases before an actual deployment needs them.
4. Report p50/p95/p99 API latency, event-loop delay, peak memory, transaction duration, busy/timeout rates, queue backlog, DB/WAL/blob growth and backup/restore duration under mixed workloads. Agree response-time and recovery objectives before declaring scalability complete; a user-count claim alone is insufficient.
5. Validate an indexed lexical candidate path using the installed SQLite build and its maintenance/consistency rules. FTS5 provides indexed full-text retrieval within SQLite; using it does not require a new service. [SQLite FTS5 documentation](https://www.sqlite.org/fts5.html). Evaluate relevance/recall alongside performance, especially for synonym-only semantic matches.
6. Keep future external actions idempotent and durably tracked. Before adding external side effects, define a SQLite-backed job/outbox record with operation identity, status, attempts and retry scheduling so process failure does not duplicate actions. No external broker or microservices are required for this stage.
7. Revisit a client/server database only when measured write contention, recovery/backup limits, or a real multi-host availability requirement justifies it. Preserve the user's decision to defer PostgreSQL, Python rewrites and distributed infrastructure. [SQLite deployment guidance](https://www.sqlite.org/whentouse.html).

### Verification and limits

- **40 existing tests passed across four files:** SQLite 6, context 15, Hexa 10 and ingestion 9, in 2.26 seconds, with no warnings. These targeted tests were run from an isolated source snapshot with cache writes disabled. The full build/suite was not repeated for this documentation-only review.
- Schema/upgrade reproductions used disposable databases; current F20 was rechecked against the latest implementation. Scale measurements used synthetic data: the retrieval test was in-memory, other database timings used file-backed WAL with warm caches, and the result-matching measurement was CPU-only. These are observations of individual operations on this machine, not production throughput, user capacity or a completed concurrent load test.
- The controlled embedding race used a fake provider; no model or external endpoint was contacted. No real embedding/reranker inference time is included in the retrieval numbers.
- Temporary evidence is under `/tmp/catalyzt-model-scale.ts`, `/tmp/catalyzt-schema-review-77/`, and the workflow review's `/tmp` snapshot. The reproduction details above are sufficient to recreate the checks if temporary files are removed.
- `DATA_MODEL.md` still says “10” migrations while the reviewed commit has 11; Claude added migration 12 during this review. Update it and `docs/MIGRATION_NOTE.md` after the model fixes so their integrity, retrieval and portability claims match the implementation.

### Concurrent development observed before append

The final pre-append check caught new uncommitted work in `app/scripts/ci-runner.ts`, `app/server/api.ts`, `app/server/db.ts`, `app/server/evidence.ts`, `app/server/ingest.ts`, `app/server/schema.ts` and `app/src/pages/Hexa.tsx`. The reviewed diff adds CI report paths/framework metadata, component-aware test lookup, cross-chat proposal supersession, stale-workspace cleanup and a migration 12 framework backfill. The schema/database/API/ingestion changes were inspected to distinguish them from the recorded findings; they do not introduce the scoped requirement identity, embedding hash checks, positive page-size validation or legacy-approval migration required above. The 40-test result and timing measurements apply to the reviewed committed snapshot, **not** these concurrent edits. Those edits and existing simulation logs were preserved; no application source was modified by this reviewer. Re-run the targeted tests and benchmarks against Claude's final changes before closing findings.

**Append verification — 2026-11-08 08:14:00 GST:** HEAD remained `77af06d6bdb29347a375b36213d10f86f4fe8b24`. Concurrent source edits were present as described above; evidence was kept tied to the reviewed commit. The brief was re-read immediately before this append, and all original bytes were preserved. The only project edit made by this reviewer is this appendix.

At the exact append check, additional concurrent edits had also appeared in `app/server/api.test.ts` and `docs/hexa-github-action.yml`; those last-arriving changes were not reviewed or included in the test results above.
