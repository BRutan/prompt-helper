# prompt-helper

Context-efficient source-file snapshots and diffs. Paste a **UTF-8 source file or multi-file SOURCE_DIR / FILE dump** into a web textbox, starting with a mandatory extension-appropriate `Path:` comment. prompt-helper stores the original file once, tracks later versions, and returns only changed hunks with old/new line numbers. Identical submissions do not create revisions. There are **three service-local Dockerfiles and three Compose services** sharing the `prompt-helper-backend` network.

## Repository layout

Each container owns its Dockerfile, `Dockerfile.dockerignore`, and everything needed for its build context. Docker Compose and Make commands remain at the repository root.

```text
prompt-helper/
├── docker-compose.yml
├── Makefile
├── .env.example
├── frontend/
│   ├── Dockerfile
│   ├── Dockerfile.dockerignore
│   ├── package.json
│   ├── index.html
│   ├── nginx.conf
│   ├── tsconfig.json
│   ├── vite.config.ts
│   └── src/
├── backend/
│   ├── Dockerfile
│   ├── Dockerfile.dockerignore
│   ├── go.mod
│   ├── cmd/server/
│   └── internal/
└── db/
    ├── Dockerfile
    ├── Dockerfile.dockerignore
    └── schema.sql
```

The Compose builds use `context: ./frontend`, `context: ./backend`, and `context: ./db` respectively, with `dockerfile: Dockerfile` for each. Docker automatically selects each adjacent `Dockerfile.dockerignore` to filter that service's build context. For example, `node_modules` stays out of frontend builds and DB backups stay out of database builds. No parent-directory sources are copied into another service image.

## Architecture

| Service | Container | Technology | Responsibility |
|---|---|---|---|
| frontend | `prompt-helper-frontend` | TypeScript, JavaScript, Vite (build), Nginx (serve) | Client-side validation; source textbox; guttered changes; copy-for-LLM button; extension filtering |
| backend | `prompt-helper-backend` | Go 1.23, native Git histogram diff | Independent header validation, SHA-256 deduplication, line-based diff computation, HTTP API |
| db | `prompt-helper-db` | PostgreSQL 17 | Original baseline, latest materialized content, immutable versioned patches, extension index |

Only the frontend is bound to a host port (`127.0.0.1:5173` by default). The backend and PostgreSQL remain internal to the bridge network. The filename is **an identifier**; the application never reads/writes the named file in the host filesystem. Content is not executed. The backend never sends code to external AI APIs.

## Prerequisites and setup

- Docker Engine / Docker Desktop with Compose v2 and GNU Make.
- For development without Docker: Go 1.23+, Node 22+, PostgreSQL 17+, Git installed on backend host.

```sh
cp .env.example .env
# Update PROMPT_HELPER_DB_PASSWORD in .env before any shared deployment.
make build-up
# Visit http://localhost:5173
```

This directory reorganization does not rename Compose services, the Docker network, or the database volume; `make build-up` preserves existing history. The database schema is initialized when its named volume is created for the first time. If you modify `db/schema.sql` on an existing volume, **apply the SQL migration yourself**; restarting the DB won't replay initialization. `make clean CONFIRM=1` removes all stored content and history.

## Lifecycle commands

```sh
make build                 # build frontend + backend + db images
make up                    # start all three, wait for health
make down                  # stop/remove containers; keep db volume
make build-up              # rebuild then start
make down-up               # recreate the whole stack

make build-frontend        # individual service variants
make up-frontend
make down-frontend         # stop only this service
make build-up-frontend
make down-up-frontend

make build-backend
make up-backend
make down-backend
make build-up-backend
make down-up-backend

make build-db
make up-db
make down-db
make build-up-db
make down-up-db

make build NO_CACHE=1
make status
make logs SERVICE=backend
make clean CONFIRM=1      # permanently deletes PostgreSQL volume
```

Every service uses the same named Compose bridge network `prompt-helper-backend`. The backend resolves the DB using the hostname `db`; Nginx proxies `/api/` to `backend:8080`. Both endpoints are otherwise unexposed.

## Required file headers

The first line must be the comment header below, optionally preceded by an executable `#!` shebang. **Whitespace between the comment leader, `Path:`, and pathname is mandatory.** Supply a directory-qualified pathname, with extension or recognized special filename.

```typescript
// Path: src/components/ContentView.tsx
export const title = 'hello';
```

```python
# Path: jobs/random_transaction/example.py
print('hello')
```

```sql
-- Path: db/migrations/001.sql
SELECT 1;
```

```css
/* Path: src/styles/layout.css */
body { margin: 0; }
```

```html
<!-- Path: web/index.html -->
<div>hello</div>
```

Files without a valid header are rejected **by both the browser and Go server**. Supported families include TypeScript/JavaScript, Swift, Go, Rust, Python, shell, Java/C/C++, SQL, CSS, HTML/XML, Markdown, YAML, TOML, HCL, and other explicit mappings in `backend/internal/header/header.go` (browser mapping in `frontend/src/main.ts`). Strict `.json` is intentionally unsupported: JSON has no valid comment form; use `.jsonc` if a comment header is required. A normal `README.md` must use `<!-- Path: docs/README.md -->`. Repository-relative and clean absolute paths are accepted but never accessed as filesystem paths.

## UI workflow

1. Paste a complete source file with the appropriate `Path:` header.
2. Click **Store & compare** (or press Cmd/Ctrl+Enter).
3. On first submission: the entire baseline is stored and displayed with new-side line numbers.
4. On subsequent submissions: only changed hunks and three context lines on either side are shown; old/new line numbers appear on the left. SHA-256 matches return `unchanged` without adding a revision.
5. Click **Copy for LLM** to copy the concise, line-numbered changes including path, version and hash. For an unchanged file, the copy is a single line.
6. Use the recent-files panel and extension filter to browse stored current files. Click a file to populate the textbox.

Note: first submission necessarily contains a full baseline; later diffs are useful to an LLM only while it still has that baseline (or a later complete version) in context. Following compaction, explicitly fetch the current version again.

## HTTP API

All routes are reachable via the frontend Nginx on `http://localhost:5173`.

```sh
curl -sS -X POST http://localhost:5173/api/v1/files/diff \
  -H 'Content-Type: application/json' \
  --data '{"content":"// Path: src/hello.ts\nexport const message = '\''hi'\'';\n"}'
```

Routes:

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/files/batch-diff` | `{ "content": "..." }` → split SOURCE_DIR / FILE sections, persist atomically, return combined numbered diff |
| POST | `/api/v1/files/diff` | `{ "content": "..." }` → baseline / updated / unchanged, unified and LLM diff, numbered lines |
| GET | `/api/v1/files?extension=.ts&limit=30` | Latest files, optional extension filter; limit 1–100 |
| GET | `/api/v1/files/current?path=src/hello.ts` | Full current file for context refresh |
| GET | `/api/v1/files/history?path=src/hello.ts` | Most recent 100 revisions, including stored unified patches |
| GET | `/api/v1/health` | Database connectivity |

Response example after a change:

```json
{
  "path": "src/hello.ts",
  "extension": ".ts",
  "status": "updated",
  "version": 2,
  "sha256": "...",
  "previous_sha256": "...",
  "unified_diff": "--- a/src/hello.ts\n+++ b/src/hello.ts\n@@ ...",
  "llm_diff": "FILE src/hello.ts | CHANGES ONLY | OLD_LINE NEW_LINE +/- TEXT\n...",
  "lines": [
    {"kind":"hunk","old_line":null,"new_line":null,"text":"@@ -1,2 +1,2 @@"},
    {"kind":"removed","old_line":2,"new_line":null,"text":"export const message = 'hi';"},
    {"kind":"added","old_line":null,"new_line":2,"text":"export const message = 'hello';"}
  ],
  "additions": 1,
  "deletions": 1
}
```

`unified_diff` is stored in `file_revisions` alongside hash-chain metadata. `llm_diff` and structured lines are generated when a file is submitted and returned immediately. The DB retains the baseline and current contents; each update stores only its patch, not a full copy of every intermediate version. The source extension is indexed. This does **not** automatically intercept Claude Code's internal Read tool; integration requires an explicit API call, MCP adapter, or Claude Code hook.

## Performance and concurrency

- Go API uses a single SHA-256 per candidate and skips diff computation when unchanged.
- Native `git diff --no-index --diff-algorithm=histogram --unified=3` computes efficient line diffs in an isolated temporary directory; temporary input files are deleted after each request. The external `git` process is not an LLM.
- PostgreSQL `files(path)` is unique and `files(extension, updated_at)` is indexed, with `(file_id, version)` indexed in the revision table.
- Transactions use a per-file advisory lock to serialize concurrent writes and prevent divergent versions.
- There is no application-level request-size or file-count cap. Resource limits depend on the host, Docker, the browser, and PostgreSQL; the API request lasts until completion or client cancellation.
- Every new version stores its *full current content once* plus a diff record; unchanged versions add no rows. The first stored baseline is also retained.

## Safety and deployment

The example defaults to **local workstation use**. No authentication is implemented. Do **not** directly publish port 5173 on the internet, because the service exposes all stored source contents and permits writes. For team/multiuser use, add authentication, authorization and TLS, and isolate histories by tenant/project before exposing the frontend. Do not paste credentials, API keys, or private data unless you intend to store them in your local PostgreSQL volume. Replace the default database password.

## Testing

```sh
cd backend
 go test ./internal/header ./internal/patch
cd ..
# With all Go dependencies available:
cd backend && go test ./... && cd ..
# With Node dependencies installed:
cd frontend && npm install && npm run build && cd ..
```

Container builds require network access to download Go modules and npm packages the first time. Offline-only CI must prepopulate dependency caches or vendor modules.

## Multi-file dumps (unrestricted input size)

Paste a concatenated dump containing repeated framed `SOURCE_DIR:` and `FILE:` sections, with an extension-appropriate embedded `Path:` comment at the beginning of each file:

```text
================================================================================
SOURCE_DIR: /Users/example/project/src
FILE: App/ContentView.swift
================================================================================

// Path: src/App/ContentView.swift
struct ContentView {}

================================================================================
SOURCE_DIR: /Users/example/project/src
FILE: App/App.swift
================================================================================

// Path: src/App/App.swift
struct App {}
```

`POST /api/v1/files/batch-diff` with `{ "content": "<whole dump>" }` splits and independently validates each file, then writes revisions atomically (if one fails, none are written). It uses the **absolute concatenation of SOURCE_DIR and FILE** as the database key, preserving nested directory structure. The response returns all file statuses and a single `llm_diff` that begins with the path tree and includes changed file contents/hunks with both line numbers. Unchanged files are not re-sent in the changed hunks. The browser displays the entire combined diff and its Copy for LLM button copies that diff.

The frontend, Nginx, and Go backend have no application-configured maximum input size or maximum files per batch. Available RAM, disk capacity, network, and PostgreSQL limits still apply. The frontend is bound to localhost by default; **do not expose an unrestricted upload endpoint publicly without adding authentication and upstream resource controls**.

Rebuild both the frontend and backend after applying this change:

```sh
make build-up
```
