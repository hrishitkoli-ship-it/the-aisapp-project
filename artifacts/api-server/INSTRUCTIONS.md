# Aisapp — AI Collaborative Hub

A lightweight, self-hosted coordination layer between human project owners and autonomous AI agents. It tracks AI sessions, file edits, task assignments, and security events in real time — all from a single PWA served by a plain Node.js backend backed by Turso (libSQL).

---

## Architecture

```
artifacts/api-server/
├── backend/
│   ├── server.js          # HTTP server, binds to $PORT
│   ├── app.js             # Express app, CSP, rate limiting, static serving
│   ├── db/
│   │   └── store.js       # All Turso DB operations (projects, sessions, activity, files)
│   └── routes/
│       ├── projects.js    # CRUD for projects (human-facing)
│       ├── sessions.js    # Human router (read + dismiss) + AI router (full CRUD)
│       ├── files.js       # File read/write/delete (human + AI)
│       ├── activity.js    # Activity feed (append + read)
│       └── assignments.js # Task assignment flow (propose / approve / reject)
├── frontend/
│   ├── index.html         # PWA shell; inline SW registration (CSP hash in app.js)
│   ├── css/               # Component stylesheets
│   └── js/
│       ├── router.js      # Hash-based SPA router
│       ├── roster.js      # AI Session Roster — polls /api/projects/:id/sessions
│       ├── activity.js    # Activity Timeline — polls /api/projects/:id/activity
│       └── pages/
│           ├── workspace.js   # File tree + editor
│           ├── assignments.js # Assignment board
│           └── ...
└── api/                   # (legacy) Vercel serverless function shim
```

**Database:** Turso (libSQL). Connection URL must use `https://` — the `@tursodatabase/serverless` SDK does not accept `libsql://`. The `store.js` sanitiser strips stray quotes and rewrites the prefix automatically.

**Auth model:** Two router stacks share the same Express app:
- `/api/projects/:id/…` — human-facing (protected by `projectToken` cookie)
- `/api/ai/:id/…` — AI-facing (protected by `Bearer` token in the `Authorization` header)

---

## Running locally (Replit)

The workflow command is:
```
pnpm --filter @workspace/api-server run dev
```
which resolves to `node --watch backend/server.js`.

Required secrets (set via Replit Secrets):
- `TURSO_DATABASE_URL` — your Turso database HTTPS URL
- `TURSO_AUTH_TOKEN` — your Turso auth token
- `SESSION_SECRET` — used for cookie signing

---

## QoL improvements — Round 1

All changes are in `frontend/js/` and `backend/routes/`.

| Feature | Files changed |
|---|---|
| **Ctrl/Cmd+S to save** | `workspace.js` — self-cleaning `keydown` listener; removes itself when `mountEl` leaves the DOM |
| **Word wrap toggle** | `workspace.js` — "Wrap / No wrap" button toggles `is-wrap` CSS class on the textarea in-place (cursor position preserved) |
| **Dirty indicator** | `workspace.js` — orange dot in the editor header appears as soon as content diverges from last-saved; cleared on save |
| **Dismiss stale sessions** | `roster.js` + `sessions.js` — stale cards show a "Dismiss" button; `DELETE /api/projects/:id/sessions/:sessionId` added to the human router |
| **Activity type filter** | `activity.js` — filter chips (All / Files / Sessions / Assignments / Alerts); client-side from cached `allEntries`, polling is unaffected |
| **Stale count in header** | `roster.js` — session count badge now shows e.g. `3 sessions · 1 stale` |

---

## QoL improvements — Round 2

| Feature | Files changed |
|---|---|
| **Auto-save after 3 s** | `workspace.js` — debounced `setTimeout` in `oninput`; cancelled on explicit save or navigation |
| **Tab → 2 spaces** | `workspace.js` — `keydown` handler intercepts Tab, inserts two spaces, dispatches synthetic `input` event so all downstream state stays in sync |
| **Ln / Col status bar** | `workspace.js` — monospace indicator in the action row; updates on every click and keyup |
| **⌘S / ⌃S hint on Save** | `workspace.js` — `<kbd>` element inside the Save button; `textContent` updates use a `saveBtnLabel` span so the button text can change without destroying child nodes |
| **Copy file path button** | `workspace.js` — clipboard icon in editor header; title briefly changes to "Copied!" for 1.5 s feedback |
| **Escape to close file** | `workspace.js` — Escape goes back to the file tree only when there are no unsaved changes (dirty files are left alone) |
| **Dismiss all stale** | `roster.js` — "Clear stale (N)" button appears in the roster header when stale sessions exist; fires parallel DELETE requests then refreshes |
| **Auto-updating timestamps** | `roster.js` + `activity.js` — `setInterval` ticks every 30 s, updates all `[data-ts]` spans from their `data-ts` attribute without re-fetching |

---

## CSP note

The Content Security Policy in `backend/app.js` contains a `sha256-` hash for the inline `<script>` in `frontend/index.html` that registers the service worker. **If you change that inline script, recompute the hash:**

```bash
node -e "
const crypto = require('crypto');
const fs = require('fs');
const html = fs.readFileSync('frontend/index.html', 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
const hash = crypto.createHash('sha256').update(match[1]).digest('base64');
console.log('sha256-' + hash);
"
```

Then update the `script-src` directive in `app.js`.

---

## Pushing to GitHub

The project uses a GitHub PAT stored as `GITHUB_PAT` in Replit Secrets. To push:

```bash
git remote set-url origin "https://${GITHUB_PAT}@github.com/hrishitkoli-ship-it/the-aisapp-project.git"
git push origin main
```

Vercel picks up the push automatically and redeploys within ~60 seconds.
