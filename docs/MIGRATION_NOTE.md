# Keeping a later database migration straightforward

Decision for this release: SQLite with better-sqlite3 is the authoritative database, on one host.
This note records what keeps a later move (PostgreSQL remains the likely candidate) to a mechanical
job rather than a rewrite, and what would justify it. Nothing here is implemented for another
database now, and nothing should be until the move is authorised.

## Stable identities

- Every row has a text id that is meaningful outside SQLite and never depends on `rowid` or
  autoincrement: applications by their workspace id, people by `u-…`, chats, messages and answers
  by the browser's UUIDs, revisions as `<answer id>-r<n>`, approvals as `<revision id>-a<i>`,
  artifacts as `<revision id>/<local id>`, tests as `TC-`/`MT-` hashes of (application, source,
  path or external id), proposals as `UAT-<story key>-<criterion>`, attachments as `att-<uuid>`.
  Only `audit_log`, `guard_events`, `model_calls` and `refinements` use integer keys, and nothing
  references them except `stories.refinement_id`.
- Timestamps are ISO-8601 UTC text. Booleans are 0/1 integers. JSON lives in text columns with a
  known shape (`blocks`, `facts`, `payload`, `target`, `citations`, `intent`).

## Ownership boundaries

- Every top-level table carries `application_id`; child tables reach the application through one
  parent (message → chat, revision → message, approval → revision, result → run). The checks in
  `scripts/restore-check.ts` ("rows that cross an application boundary") are the invariant a
  migration must preserve.
- Who may read or change what is decided in `server/api.ts` from the person, the application and
  the roles. Repositories never infer the application from the row they are asked for, except to
  refuse a write that would cross a boundary (`OwnershipError`).

## Repository and storage boundaries

- All SQL is in `server/db.ts` (plus the App Context, Huddle and retrieval modules, which use
  `db.raw`). HTTP handlers, the workflow, guardrails and the shared answer reducer never build SQL.
- "Same signatures" understates the work, as the data-model review pointed out: `HorizonDb` is
  `ReturnType<typeof openDb>`, every method is synchronous (better-sqlite3), and transactions are
  `db.raw.transaction(fn)`. A client/server database is asynchronous, so the move needs, before any
  SQL is ported: an explicit repository interface per area (people and scope, conversations, Hexa,
  App Context, Huddle, usage) with the application id as a required parameter, `async` methods,
  and a transaction contract (`withTransaction(fn)`) that callers use instead of `db.raw`. The
  SQLite implementation then satisfies that interface first, with the current tests unchanged;
  only after that does a second implementation make sense. Do not start the second implementation
  until the interface exists and the signals below are measured.
- Triggers added in migration 14 (same-application guards) and the FTS5 index of migration 17 are
  SQLite-side invariants; the target database needs the equivalent constraints and a full-text
  index of its own, and the retrieval candidate query is one of the SQL statements to port.
- Uploaded bytes go through `server/storage.ts` (`BlobStore`): local disk today, an object store
  later, without touching callers.
- Business rules that must survive the move are tested through the API harness
  (`server/api.test.ts`) and the workflow (`server/workflow.test.ts`), not through SQL.

## SQLite-specific SQL to replace

`INSERT OR IGNORE`, `ON CONFLICT(...) DO UPDATE ... excluded.col`, `json_extract`, `json_each`,
`json_set`, `strftime`, `PRAGMA` calls, `rowid` as a tiebreaker in ordering, `IS` for nullable
equality, partial unique indexes (`WHERE external_run_id IS NOT NULL`), `user_version` as the schema
version, and `ALTER TABLE ... RENAME` table rebuilds in migrations (SQLite cannot alter a CHECK
constraint). Each has a direct PostgreSQL equivalent; the list is the checklist.

## Export, import and validation

- Export: the online backup (`npm run backup`) is the consistent source; a dump per table in id
  order is the import input.
- Import order follows the foreign keys (applications, users, memberships, workspaces, components,
  stories and children, chats, messages, revisions, citations, artifacts, approvals, ratings,
  workflow_runs, agent_runs, agent_steps, model_calls, guard_events, repo_scans, test_cases, links,
  steps, runs, results, uploads, attachments, context and huddle tables, audit_log).
- Validation is what `restore-check` already does, run against both sides: row counts per table and
  per application, foreign-key check, schema version, cross-application references, attachment
  files present. Add a sample of application workflows end to end (a story → analysis → rating →
  approval → inventory) on the imported copy before cutover.

## Staged cutover (when the time comes)

1. Freeze writes (stop the server; it is one process).
2. Backup, export, import into the new database, run the validation above.
3. Switch the repository implementation and the connection setting; start; smoke the flows.
4. Keep the SQLite file and backups read-only for rollback until the next release.
No dual-writing: with one process and short freezes there is nothing to gain and a lot to get wrong.

## When to revisit

Measured signals, not a user-count threshold: sustained `SQLITE_BUSY` waits in the logs, write
latency that shows in the chat, a database or backup size that makes the backup window a problem,
a requirement for more than one host (availability, geography), or compliance needs the single
host cannot meet. Until one of these is measured, SQLite on one host is the simpler and more
reliable system.
