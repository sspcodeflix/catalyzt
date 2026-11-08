# Running Catalyzt on one host

Catalyzt is a modular monolith: one Node process serves the API and the built front end, with one
SQLite database and one folder of uploaded files on the same host's persistent disk. There is no
second service to run. This note says how to start it, what it needs, where its data lives, and how
to back it up, restore it and upgrade it.

## Build and start

```bash
cd app
npm install
npm run build        # the front end, to dist/
npm run build:api    # the API, to server-dist/main.mjs (esbuild bundle; node_modules stay external)
HORIZON_IDENTITY_HEADER=x-forwarded-email npm start
```

`npm start` runs `node server-dist/main.mjs`. It applies pending schema migrations, loads the
workspace (`.myworkspace`), marks anything left "running" by a previous process as stopped, and
listens on `127.0.0.1:8787`. Put a reverse proxy in front for TLS and sign-in; do not expose the
port directly.

In development, `npm run dev` keeps serving the API inside Vite as before. To develop against the
standalone API instead: `npm run api` in one terminal and `HORIZON_API_URL=http://127.0.0.1:8787 npm run dev`
in another; Vite then proxies `/api` and nothing else changes.

## Environment

Read from the process environment, then from `app/.env` for anything not set (the file is
git-ignored). Names kept from the Horizon era for compatibility (`HORIZON_*`, `x-horizon-*` headers, `hz-*` browser keys); a Catalyzt alias can be added later
without breaking existing deployments.

| Variable | Default | Meaning |
|---|---|---|
| `HORIZON_PORT` | `8787` | Listening port |
| `HORIZON_HOST` | `127.0.0.1` | Bind address. Keep it local; the proxy terminates TLS |
| `HORIZON_DB_PATH` | `data/horizon.db` | The SQLite file. Local disk on this host; never a network share |
| `HORIZON_FILES_DIR` | `data/attachments` | Original uploads (attachments, App Context files) |
| `HORIZON_WORKSPACE` | `.myworkspace` or `../.myworkspace` | Team configuration, backlogs, manual tests |
| `HORIZON_STATIC` | `dist` | The built front end. Empty string: serve the API only |
| `HORIZON_IDENTITY_HEADER` | none | **Shared deployments:** the header the sign-in proxy sets with the signed-in email (for example `x-forwarded-email`). Browser-chosen identities are ignored |
| `HORIZON_DEV_IDENTITY` | none | `1` enables the "Sign in as" picker (the browser names the person). Development only |
| `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_BASE_URL` | none | The model. Without a key, requests are routed by rules and answered without a model |
| `GITHUB_TOKEN` | none | Raises the GitHub rate limit for Hexa scans; needed to download CI artifacts |
| `HEXA_INGEST_TOKEN` | none | Bearer token CI uses to push results to `/api/hexa/results` |
| `HEXA_INGEST_TOKEN_<APP>` | none | A token valid for one application only; that application then accepts only its own |
| `HORIZON_RETRIEVAL` | `hybrid` | App Context retrieval: `hybrid` runs a local embedding model and reranker on the CPU in this process; `keyword` uses no models |
| `HORIZON_MODELS_DIR` | `data/models` | Where the two ONNX models are cached (about 46 MB, downloaded once from huggingface.co on first use) |
| `HORIZON_MODELS_OFFLINE` | none | `1` forbids downloads: copy `data/models` from a host that has them, or the server stays keyword-only and says so |
| `HORIZON_RERANK`, `HORIZON_EMBED_MODEL`, `HORIZON_RERANK_MODEL` | `on`, MiniLM models | Turn the reranker off, or name other transformers.js models (a change of embedding model re-embeds every passage) |

The server refuses to start with neither `HORIZON_IDENTITY_HEADER` nor `HORIZON_DEV_IDENTITY=1`,
so a production process cannot accidentally trust the browser.

## Identity and authorisation

Behind the proxy, the person is whoever the identity header names, looked up by email in the
workspace's people. Unknown emails get 403. Application membership and roles (`app_owner`,
`component_manager`, `security_champion`, `member`) come from the workspace and are checked on the
server for every request: a chat, approval, test or attachment of another application answers 404
(not disclosed); the wrong role answers 403.

## Data on disk

| Path | What | Durability |
|---|---|---|
| `data/horizon.db` (+ `-wal`, `-shm`) | Everything structured: people, chats, answer revisions, ratings, approvals, stories, tests, runs, results, attachments metadata and text, audit log | WAL journal, `synchronous=NORMAL` |
| `data/attachments/<APP>/<id>` | Uploaded bytes | Plain files, written beside and renamed into place |
| `data/models/` | The embedding and reranking models (ONNX, quantised) | A cache: deleting it costs one download (or set `HORIZON_MODELS_OFFLINE=1` and copy it in). Passage vectors live in the database (`chunk_embeddings`) and are rebuilt in the background if missing |
| `.myworkspace/` | Configuration and seed data, in Git | Re-seeded at every start; existing rows are never removed |

SQLite settings on every connection: `journal_mode=WAL` (readers never block the writer),
`foreign_keys=ON`, `synchronous=NORMAL` (durable against an application crash; the WAL is synced at
each checkpoint, so an OS crash can lose the last few committed transactions, which is the usual
trade-off for this mode), `busy_timeout=5000` (a second writer waits up to 5 s instead of failing
at once). Write transactions are short and never span a model or network call. WAL allows one writer
at a time: run **one** server process per database file, and do not point two hosts at one file.
On shutdown (SIGTERM/SIGINT) the server stops accepting requests, checkpoints the WAL into the
main file and closes the database.

## Backups and restore

```bash
cd app
npm run backup                             # data/horizon.db -> data/backups/horizon-<stamp>.db
npm run backup -- /path/db /path/backups   # other locations
```

The backup uses SQLite's online backup API, so it is a consistent snapshot even while the server
writes. Copying `horizon.db` alone while WAL is active is not safe. Back up `data/attachments`
right after the database, so every attachment row has its file. The script checks the copy with
`integrity_check` and prints row counts; exit code 2 means do not trust the copy.

To rehearse a restore without touching the live database:

```bash
npm run restore-check -- data/backups/horizon-<stamp>.db data/attachments
```

It copies the backup to a scratch file, opens it the way the server does (applying any pending
migrations), and checks integrity, foreign keys, schema version, cross-application references, and
that every attachment still has its file. Exit code 1 lists the problems.

To restore: stop the server, move the current `horizon.db`, `-wal` and `-shm` aside, copy the backup
to `HORIZON_DB_PATH`, restore the attachments folder from the same time, start the server. The first
start applies migrations if the backup predates the current schema.

## Upgrades

1. `npm run backup` (and copy the attachments folder).
2. Deploy the new build; `npm run build && npm run build:api`.
3. Start. Migrations run inside a transaction each; a failed migration leaves the previous version
   in place and the server does not start. Never edit a shipped migration; add a new one.
4. `npm run restore-check` against the pre-upgrade backup proves the backup still restores into the
   new schema.

## Limits of this deployment

- One host, one process, one database file. No horizontal scaling, no failover; recovery is "restore
  the backup on a new host". The migration note says when that stops being enough.
- The server does not terminate TLS or sign people in. Both belong to the proxy in front.
- Long work (repository scans, result ingestion) runs inside the process with recorded state in
  SQLite; a restart marks it stopped and the person runs it again. Embedding passages for App
  Context also runs inside the process (a few milliseconds per passage on one CPU core); a restart
  simply continues with the passages that have no vector yet.
- Retrieval is bounded: an FTS5 index supplies the lexical candidates and the application's current
  vectors are held in memory (about 1.5 KB per passage) for the semantic ones; a question loads a
  few hundred passages at most. The vector pass is still a scan over the application's vectors in
  memory: about 75 ms for 50,000 passages on one core, and it blocks the event loop for that long
  (see the load profile below). An approximate index (for example sqlite-vec) is the next step if a
  single application grows well past that. The first request after a start pays the model load
  (one to two seconds) and the first vector pass pays the matrix build (about half a second at
  50,000 passages).
- Retention is not automatic. Runs and results, model calls, answer revisions, audit events,
  uploads, retired passage versions and vectors of a model no longer configured all accumulate.
  Nothing references the rows a cleanup would remove except history views, so the policy is an
  operational decision: when a quota is set, delete oldest-first per application, never a row an
  answer, approval or evaluation still cites (citations, approvals and artifacts are the references
  to keep), and vacuum into a new file during a maintenance window. Until then, watch the sizes
  the load profile and `restore-check` report.

## Load profile

`npm run load-profile` (add `-- --json` for machine-readable output) builds a disposable database in
a temporary directory and times the hot operations on this machine. It touches no real data, calls no
model, and removes everything it wrote. Sizes are flags (see the script header); the defaults are the
review's regression case for ABCD (50,000 passages with vectors, 25,000 tests with results, 100,000
model calls) plus three more applications with 10,000 passages and 5,000 tests each, one chat of
4,000 messages and 3,000 answer revisions, 100 uploaded files of 256 KB, and 20 JUnit imports of
1,000 results run by a second process (its own connection) while this one keeps retrieving and saving
answers.

Observed on the development machine, 8 November 2026, one run at the defaults while other work was
running on the host (load average 4 to 8). Synthetic passages share one vocabulary and carry random
unit vectors, so the semantic side is representative of cost, not of relevance. These are
observations on this machine, not capacity or user-count claims.

| Operation (ABCD at the regression sizes; 4 applications loaded, 320 MB database) | p50 | p95 |
|---|---|---|
| Retrieval, keyword only | 55 ms | 64 ms |
| Retrieval, hybrid (first call builds the vector matrix: 617 ms) | 88 ms | 180 ms |
| Retrieval, hybrid, interleaved across the 4 applications (first call per 10k-passage app: about 360 ms) | 53 ms | 185 ms |
| Test search (`listTests` with a query) | 14 ms | 17 ms |
| Usage totals (first call 97 ms, then cached) | 0 ms | 0 ms |
| Coverage of a story, UAT states of an application | < 1 ms | < 1 ms |
| Long chat: `addUserMessage`, `saveAnswer` (one transaction each) | 0.1 ms | 0.1 ms (p99 8 ms) |
| Long chat read (`getChatFull`, 4,000 messages, 3,000 revisions) | 36 ms | 46 ms |
| JUnit import of 1,000 results in the second process (parse, match, store) | 65 ms | 104 ms |
| Its write transaction (`ingestRun`) | 6.5 ms | 30 ms |
| Retrieval while the second process ingests (versus alone: 94 / 276 ms) | 94 ms | 296 ms |
| Saving a chat turn while the second process ingests (versus alone: 0.4 / 0.7 ms) | 0.4 ms | 8.9 ms |

| Under mixed load | Observed |
|---|---|
| `SQLITE_BUSY` errors, turns that waited more than 50 ms for the write lock | 0 and 0 (both processes) |
| Share of the ingestion phase the second process held the write lock | 11 % of 1.75 s |
| Event-loop delay during that phase | p50 95 ms, p99 297 ms (a retrieval holds the loop for its whole duration) |
| Peak RSS: this process, the ingestion process | 431 MB, 454 MB (each about 160 MB is the vite-node runtime; the vector matrices of 80,000 passages add about 230 MB) |
| Database, WAL, blob files across the run | 320 → 332 MB; WAL 180 MB after the bulk fill until a `wal_checkpoint(TRUNCATE)` (43 ms) empties it; blobs 0 → 25 MB |
| Online backup (`db.raw.backup`) of 332 MB | 359 ms |
| Restore check: in process (copy, open, integrity, foreign keys), and `npm run restore-check` end to end | 0.7 s and 1.1 s, passed |

Timings varied between runs on the busy host by up to two times at p95 (hybrid p50 88 to 181 ms
across three runs); p50 values were steadier. With the other three applications loaded, ABCD's keyword
retrieval took 55 to 60 ms against 42 to 45 ms with ABCD alone: the full-text candidate query ranks
matches across every application before the application filter applies. Before the bounded
candidates, keyword retrieval at the regression size took about 620 ms (the review's measurement).
Agree response-time and recovery objectives against these observations before calling scalability
done.

`npm run retrieval-eval` measures relevance with the real local models (`HORIZON_MODELS_DIR` set to
the cached models, `HORIZON_MODELS_OFFLINE=1`): 293 fixture passages, 59 labelled questions, keyword,
hybrid and hybrid with reranker, each with the bounded candidates and over every passage. See the
script header for the metrics and `--pad` for adding the cloned repositories' documentation as
distractors.

- Not externally validated here: the GitHub Actions push against a real GitHub workflow (the
  payload and its handling are tested against the API), and a real sign-in proxy (the header mode
  is tested with synthetic requests).
