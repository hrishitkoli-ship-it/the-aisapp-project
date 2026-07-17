# Aisapp (AI Collaborative Hub)

A local-first PWA for managing coding projects alongside multiple external AI agents. No cloud login required — agents authenticate with per-project bearer tokens. The human approves/rejects AI proposals via the browser UI.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — start the server (port 8080, served at `/`)
- Required secrets: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`

## Stack

- pnpm workspaces, Node.js 18+
- Backend: Express 4, plain CommonJS JS
- Frontend: Vanilla HTML/CSS/JS, PWA (no build step)
- DB: Turso (libSQL via `@tursodatabase/serverless`)
- Auth: token-based (SHA-256 hashed, shown once on creation)

## Where things live

- `artifacts/api-server/backend/` — Express app, routes, middleware, db store
- `artifacts/api-server/frontend/` — Vanilla PWA (HTML, CSS, JS)
- `artifacts/api-server/backend/db/store.js` — All database operations (Turso)
- `artifacts/api-server/backend/app.js` — Express app definition (CSP hash lives here)

## Architecture decisions

- Two URL namespaces: `/api/projects/...` (human, browser) and `/api/ai/...` (AI agents, token-required)
- File writes are conflict-checked via `expectedVersion` — returns 409 on stale write
- Assignment approvals are structurally absent from the AI namespace (human-only by design)
- Device identity is embedded in every token prefix (first 12 chars after `aisapp_`)

## Product

Shared surface for multi-agent coding sessions: read/write project files, register AI sessions in a roster, propose function assignments for human approval, log activity, and send cross-session work requests.

## User preferences

_Populate as you build._

## Gotchas

- `TURSO_DATABASE_URL` must be `libsql://...` format — the server converts it to `https://` for the serverless SDK (strip trailing quotes if copy-pasted)
- CSP `script-src` hash in `backend/app.js` must be recomputed if the inline `<script>` in `frontend/index.html` changes — use `crypto.createHash('sha256').update(content,'utf-8').digest('base64')`
- The `@tursodatabase/serverless` package (not `@libsql/client`) is required for HTTP/edge environments
- Package has `"type": "module"` removed — the aisapp backend is CommonJS

## Pointers

- See `SKILL.md` in repo root for the AI agent integration guide (endpoints, token format, session registration)
- See `backend/db/schema.sql` for the Turso schema
