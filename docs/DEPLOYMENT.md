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
- Vector search is a scan over every vector of the application (cosine over float32 BLOBs); it is
  fast at thousands of passages per application and would want an index (for example sqlite-vec)
  at tens of thousands. The first request after a start pays the model load (one to two seconds).
- Not externally validated here: the GitHub Actions push against a real GitHub workflow (the
  payload and its handling are tested against the API), and a real sign-in proxy (the header mode
  is tested with synthetic requests).
