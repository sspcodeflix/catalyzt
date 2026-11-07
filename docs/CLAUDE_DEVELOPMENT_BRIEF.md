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
