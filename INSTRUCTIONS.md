# INSTRUCTIONS.md — AI Collaborative Hub

Read this fully before touching any file. This is a **local-first PWA**
(no cloud login, no database server) that lets a human run several AI coding
sessions against one project from a phone. Ironically, this project itself
is being built by multiple AI sessions — you are one of them.

Repo: `hrishitkoli-ship-it/the-aisapp-project` (private)
Stack: Node 18+ / Express / vanilla JS backend, **no frontend yet**.
No native deps (no SQLite, no Docker) — everything must run in Termux.

---

## Current state (as of this write-up)

```
the-aisapp-project/
├── backend/
│   ├── server.js            Entry point, route wiring        ✅ DONE
│   ├── db/store.js          JSON-file datastore + locking     ✅ DONE
│   ├── middleware/auth.js   Human vs AI identity              ✅ DONE
│   ├── routes/
│   │   ├── activity.js      Read-only timeline                ✅ DONE
│   │   ├── files.js         Tree/read/write/delete + conflict ✅ DONE
│   │   ├── instructions.js  Notes/functionalities/assignments ✅ DONE
│   │   ├── projects.js      Create/list/regen-token/delete    ✅ DONE
│   │   └── sessions.js      AI Session Roster                 ✅ DONE
│   └── utils/
│       ├── fileOps.js       Path safety + versioning          ✅ DONE
│       └── tokens.js        Token gen/hash/verify             ✅ DONE
├── frontend/                 ❌ DOES NOT EXIST — this is the gap
├── projects/                 Runtime data, gitignored
├── package.json               express, cors, nanoid only
└── README.md                  Full API reference — READ THIS FIRST
```

**The backend is functionally complete and well-built.** The entire
remaining scope is the frontend PWA, plus hardening/testing/polish. Read
`README.md` in the repo root before writing any code — it documents every
route, the two-identity model, and conflict handling in detail.

---

## Non-negotiable architecture rules (do not violate these)

1. **No native deps.** No SQLite, no Docker, no Python toolchain, no build
   step requiring node-gyp. If you're tempted to add a bundler/framework
   for the frontend, stop — see Session 2 scope below for why vanilla
   JS is the requirement, not a preference.
2. **Two identities, enforced structurally, not just in the UI.** Human
   routes (`/api/projects/...`) need no token. AI routes (`/api/ai/:id/...`)
   require `Authorization: Bearer <token>`. The AI Session Roster is
   read-only for humans and read/write for AI — there is deliberately no
   human-facing write route for it, and no AI-facing approve route for
   assignments. **Do not add routes that blur this line.**
3. **The Function Assignment Gate is human-only by construction.**
   `POST /assignments/:id/approve` exists only on `humanRouter`. Never wire
   it onto `aiRouter`, even behind a permission check — the whole point is
   that no route exists for an AI token to hit.
4. **Path safety.** All file reads/writes go through `safeResolve()` in
   `fileOps.js`. Never bypass it with raw `fs` calls from a route.
5. **Optimistic concurrency.** File writes accept `expectedVersion` and
   return `409` on mismatch rather than silently overwriting. Preserve this
   contract in any new write path.

---

## Lane assignments (5 sessions)

Register yourself in the AI Session Roster as soon as you start
(`POST /api/ai/:projectId/sessions`) with your lane as `function`, and keep
`currentTask` updated via `PATCH` as you work — this is not optional, it's
literally what that endpoint is for and it's how the human tracks you on
mobile.

### Session 1 — Frontend Core (Workspace + file tree UI)
Build `frontend/index.html`, base layout, service worker, PWA manifest.
- File tree browser (`GET /tree`) with expand/collapse
- File content viewer/editor calling `GET/PUT /content/*`
- Conflict UI: on `409`, show a diff-aware warning before allowing
  `force: true` retry — never auto-force
- Client-side router (`#/project/:id/workspace` etc.) — server already
  does the SPA fallback in `server.js`, so hash routing or pushState both
  work; pick one and be consistent
- Service worker: cache app shell, but `service-worker.js` itself must
  never be cached (server already sets `no-cache` header for it — don't
  fight that)

### Session 2 — Frontend: Session Roster + Instructions pages
- AI Session Roster page (Page 2): **read-only view**, poll or manual
  refresh against `GET /api/projects/:id/sessions`. Do not add any write
  UI here — there is no backend route for it and there shouldn't be.
- Instructions & Functionalities page (Page 3): notes editor
  (`PUT /notes`), functionality list (`POST /functionalities`),
  assignment proposals list with **Approve/Reject buttons that only a
  human sees** (`POST /assignments/:id/approve|reject`)
- Activity timeline component (shared, used across pages):
  `GET /api/projects/:id/activity`, render `security_alert` entries
  distinctly (they matter)
- **Vanilla JS only** — no React/Vue/build step. Keep it framework-free
  so `npm start` is still the only setup step on a phone. If you need
  reactivity, hand-roll a tiny observable/pubsub pattern (20-30 lines is
  enough for this scope).

### Session 3 — Project Management UI + onboarding
- Project creation flow: name/description form → `POST /api/projects`,
  **display the returned raw token exactly once** with a clear
  "copy this now, it won't be shown again" warning (mirrors GitHub PAT UX)
- Project list/switcher (home screen)
- Token regeneration flow with a confirmation step (old token dies
  immediately)
- "Add to Home Screen" onboarding hint / PWA install prompt UX
- Project deletion with a destructive-action confirmation (irreversible,
  wipes the whole project folder server-side)

### Session 4 — Security & hardening review
Audit, don't rebuild — the backend patterns are already good. Focus on:
- Confirm every route that touches `req.params.projectId` validates the
  project exists before doing filesystem work (spot-check each router)
- Review `fileOps.js` `safeResolve` against edge cases: symlinks,
  Windows-style paths if this ever runs cross-platform, null bytes,
  extremely long paths
- Rate-limiting / abuse considerations for the AI-facing routes — this is
  explicitly a local/LAN tool per the README, but sanity-check that
  assumption holds (e.g., no accidental `0.0.0.0` exposure beyond intent)
- Verify token comparison stays constant-time (`tokens.js` already uses
  `timingSafeEqual` — check nothing else compares tokens with `===`)
- Confirm `.versions.json` and other sidecar files never leak into
  `buildFileTree()` output (currently filtered by name in `fileOps.js` —
  make sure new sidecar files, if any, get the same treatment)
- Write a short `SECURITY.md` documenting the trust model as-is (no cloud
  auth, device-is-the-boundary) so future sessions don't "fix" it into a
  cloud auth system by mistake

### Session 5 — Testing, docs, and integration
- Smoke-test every route in `backend/routes/` against a fresh project
  (curl scripts are fine, no need for a test framework given project size
  — but check `package.json` in case someone added one; don't add Jest/etc.
  unless it's already there)
- Verify conflict handling end-to-end: two concurrent writes to the same
  file path produce a real `409`, not a race
- Verify the Session Roster / Instructions permission boundaries with
  actual requests: confirm an AI token genuinely gets `404` (route not
  found) hitting an approve endpoint, not just `403`
- Cross-check README.md examples against actual route behavior — fix
  either the docs or the code if they've drifted
- Final integration pass once Sessions 1-3 land: does the frontend
  actually round-trip against the real backend, not just against mocked
  responses each session assumed independently

---

## Coordination protocol

- **Before starting work**, `GET /api/ai/:projectId/files/tree` and check
  `git log` / recent activity — someone may have already touched your lane.
- **Use `expectedVersion`** on every write once you've read a file once.
  Don't skip this because it's "probably fine" — that's the exact scenario
  it exists for with 5 concurrent sessions.
- **Need something outside your lane?** Use
  `POST /api/ai/:projectId/sessions/:targetSessionId/requests` to queue it
  for the right session instead of just doing it yourself and causing
  merge conflicts across lanes.
- **Proposing a new functionality or reassigning scope?** Use
  `POST /instructions/assignments` — it stays `pending` until the human
  approves it in the UI. Don't treat a proposal as approved just because
  it made sense to you.
- If you hit a `409` conflict on a shared file (likely `server.js`,
  `package.json`, or shared frontend CSS), re-read, re-apply your diff on
  top of the current version, and re-submit. Never `force: true` without
  understanding what you'd be overwriting.

## Session Ledger

Running record of what's actually landed, kept up to date by whichever
session last touched something. Not a task list (that's the Lane
assignments section above) — this is "what shipped," so a session
starting cold — or the human checking in from a phone — doesn't have to
diff commit history to know current state.

### Session 3 — Project Management UI + onboarding
**Status: shipped.** `frontend/js/projects.js` + `frontend/css/projects.css`.
Create/list/switch/regenerate/delete, token-reveal modal (shown once,
mirrors GitHub PAT UX), destructive-action confirms, PWA install hint.
Also authored the placeholder `frontend/index.html` (see that file's own
header comment — Session 1 owns replacing it) purely to unblock the
SPA-fallback 500 documented in `KNOWN_ISSUES.md`.

### Session 4 — Security & hardening review
**Status: shipped.** Audited `fileOps.js`/`store.js` path-safety, found
and fixed the `projectDir()` traversal gap on the DELETE route (see
`db/store.js` header comment — confirmed via isolated PoC, not
theoretical). Confirmed token comparison is constant-time throughout.

### Session 5 — Testing, docs, and integration
**Status: shipped.** Full route smoke test (`SESSION5_TEST_REPORT.md`),
conflict-detection end-to-end verification, confirmed the AI→approve
permission boundary genuinely 404s rather than 403s. Two low-priority
findings logged (README gap, non-encoded traversal not logged — both
expected behavior, not bugs).

### Session 2 — Session Roster + Instructions pages
**Status: shipped.** `frontend/js/roster.js`, `frontend/js/instructions.js`,
`frontend/js/activity.js` (shared component), `frontend/css/instructions-roster.css`.

- Roster: strictly read-only per spec, no write UI added to compensate
  for the backend having none. Sessions sorted active-first, stale
  (>10min silent) pushed down. Nested task-queue rendering with
  priority badges.
- Instructions: debounced notes autosave, functionality list, and the
  Function Assignment Gate — Approve/Reject buttons exist *only* on
  this page and call *only* the human-facing routes. No client-side
  permission check added on top, because the backend route boundary
  (approve doesn't exist on `aiRouter` at all) already is the
  boundary — duplicating it client-side would just be more surface
  area to keep in sync.
- Activity timeline: shared across pages, `security_alert` entries
  rendered distinctly (icon + tag + red surface) so a human skimming
  a long feed doesn't have to read every row to notice one. Polling
  pauses on `document.hidden`, resumes + refreshes on return.

Verified against a live local server (not just written): seeded real
sessions/requests/assignments through actual API calls, triggered a
genuine `security_alert` via an actual encoded-traversal attempt,
clicked the real Approve button and confirmed via separate `curl` that
the write persisted and got logged — not just that the DOM updated.

Still open from Session 2's original scope: none. Lane complete.

### Sessions 1 — Frontend Core (Workspace + file tree UI)
**Status: not started.** This is the current gap — `frontend/index.html`
is still Session 3's unblock-only placeholder (see that file's header).
No service worker, no manifest, no file tree/editor, no router. Everything
Session 2 built (`roster.js`, `instructions.js`) is written as a
standalone `init(mountEl, projectId)` module specifically so Session 1
can mount it from whatever router it builds without needing to know
Session 2's internals — see the "Public API" note at the top of each file.

---

---

## Definition of done for the whole project

`npm install && npm start` on a bare Termux install produces a working PWA
that a human can install to their home screen, create a project in, copy an
AI token from, and have all 5 of these lanes' worth of functionality work
against that token — with zero native compilation and zero cloud dependency.
