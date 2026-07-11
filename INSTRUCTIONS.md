# INSTRUCTIONS.md — AI Collaborative Hub

Read this fully before touching any file. This is a **local-first PWA**
(no cloud login, no database server) that lets a human run several AI coding
sessions against one project from a phone. Ironically, this project itself
is being built by multiple AI sessions — you are one of them.

Repo: `hrishitkoli-ship-it/the-aisapp-project` (private)
Stack: Node 18+ / Express / vanilla JS backend, frontend in progress
(Session 1 + Session 3 lanes done; Session 2 still outstanding -- see below).
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
├── frontend/
│   ├── index.html            App shell, PWA meta, script loads ✅ DONE (S1)
│   ├── manifest.json          PWA manifest                     ✅ DONE (S1)
│   ├── service-worker.js      Offline app-shell caching         ✅ DONE (S1)
│   ├── css/
│   │   ├── base.css           Shared tokens, light+dark, shell  ✅ DONE (S1)
│   │   ├── projects.css       Project list/create/manage UI     ✅ DONE (S3)
│   │   └── workspace.css      Tree/editor/diff view             ✅ DONE (S1)
│   ├── js/
│   │   ├── theme.js           Dark/light toggle                 ✅ DONE (S1)
│   │   ├── router.js          Hash router + app-shell chrome     ✅ DONE (S1)
│   │   ├── projects.js        ProjectManager (list/create/token) ✅ DONE (S3)
│   │   └── pages/
│   │       ├── workspace.js   Page 1: tree/editor/conflict UI   ✅ DONE (S1)
│   │       ├── roster.js      Page 2: AI Session Roster          ❌ GAP (S2)
│   │       └── instructions.js Page 3: Instructions/approval gate ❌ GAP (S2)
│   └── icons/                 PWA icons (192/512)                ✅ DONE (S1)
├── projects/                 Runtime data, gitignored
├── package.json               express, cors, nanoid only
└── README.md                  Full API reference — READ THIS FIRST
```

**The backend and Session 1/3's frontend lanes are functionally complete
and tested end-to-end against the real server (not mocked responses) --
see git log for Session 1's verification notes.** The remaining gap is
Session 2's two pages (Roster, Instructions), which the router already
routes to with an honest "not built yet" placeholder rather than a crash,
so the app is fully navigable and usable for Workspace + project management
right now. Read `README.md` in the repo root before writing any code — it
documents every route, the two-identity model, and conflict handling in
detail.

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

**Follow-up (same session, human-requested — rescoped from a one-time
audit to ongoing security & safety work):**

- **Permanent device identity.** 12-char alphanumeric code, generated
  once per device (`db/store.js`'s `getDevice`/`saveDevice`/
  `getOrCreateDeviceCode`), embedded as a fixed prefix in every
  project's token (`aihub_<12-char code><rotatable key>` —
  `utils/tokens.js`). Same code across every project a human creates on
  one device; only the key portion rotates on regenerate. Never
  regenerates itself — only explicit, confirmed deletion
  (`DELETE /api/device`, requires `{ "confirm": true }`) removes it,
  which cascades to deleting every project under it (their tokens embed
  a code that no longer exists anywhere regardless). New file:
  `routes/device.js`. Verified end-to-end against the real server,
  including a live-caught crash bug (see commit history): the delete
  route originally called a non-existent `store` function, AND had no
  try/catch around its async body — Express 4 doesn't auto-catch
  rejected promises from async handlers the way Express 5 does, so that
  typo took the entire server process down, not just that request.
  Fixed in this file; flagged as a likely-present gap in other async
  route handlers across the codebase, not retrofitted everywhere (out
  of scope for this pass).
- **`SKILL.md`** (repo root) — agent-facing guide for authenticating,
  registering in the roster, safe file writes, cross-session requests,
  and the approval-gate boundary. Grounded in the actual route
  inventory (read every route file, not written from memory) and
  validated live — every documented request shape was actually sent
  against the real server. Caught and fixed one real inaccuracy in the
  process: the draft said to source a file's `version` from a *read*
  response; testing showed `GET /files/content/<path>` never returns
  one at all — only a *write* response does. Not yet wired to a
  "downloadable from site settings" UI, since no settings page exists
  anywhere in the frontend yet (checked before writing) — that's open
  frontend work for whichever session builds it.
- **Rate limiting**, once the human confirmed this app is moving toward
  a public Vercel deployment (see `SECURITY.md` §3 for the fuller
  threat-model shift this implies — the short version: `0.0.0.0`
  binding was always intentional for LAN reachability, and is now also
  the exact mechanism by which "public" becomes possible). New file
  `middleware/rateLimit.js`, four tiers (global backstop, IP-keyed
  pre-auth surface limiter, project-keyed post-auth work limiter,
  IP-keyed limiter on specific destructive human routes only) — full
  reasoning in that file's header. Verified live, every tier, by
  actually tripping each one against the real running server, not just
  configured and trusted. Found and fixed a real design bug in the
  process: the pre-auth and post-auth AI limiters stack (same request
  path, in sequence) rather than being alternatives, so the lower of
  the two silently wins — the surface limiter's original 100/min value
  was capping ALL legitimate AI traffic well under the work limiter's
  intended 300/min allowance for the realistic common case (one agent,
  one project, one IP). Caught via live testing (150 requests, one
  valid token, expected all to succeed — only 100 did), not by
  inspection; fixed by raising the surface limiter well above the work
  limiter's ceiling. Two near-miss regressions also happened and were
  caught during this same pass, worth naming plainly rather than
  glossing over: two `str_replace` edits (adding the work limiter into
  `sessions.js` and `files.js`) accidentally matched non-unique
  surrounding text and silently deleted the `GET /` session-list route
  and the `GET /tree` file-listing route respectively. Both caught by
  diffing every touched file against the last commit before trusting a
  clean syntax check, both restored and re-verified live before
  pushing.
- **`SECURITY.md`** (repo root) — the deliverable from this lane's
  *original* scope (see the top of the Non-negotiable rules — "so
  future sessions don't 'fix' it into a cloud auth system by mistake")
  that was never actually written before now. Documents the trust
  model as it originally was, what's verified about it this session,
  and — importantly — the real, NOT-yet-closed gap that going public
  opens up: every human-facing route (`/api/projects/...`,
  `/api/device`) has zero authentication, by original design, for a
  LAN-only tool. Rate limiting slows down abuse of that gap; it does
  not close it. Real authentication on human routes is flagged
  explicitly as an open, undecided, bigger architectural question — not
  something this pass took on, and not something to assume is handled
  just because other hardening landed around it.
- **Turso migration: reference-only groundwork, NOT this lane's
  deliverable.** Before the human confirmed Session 2 owns the actual
  Turso migration, this session built `db/schema.sql` (relational
  schema derived from the current JSON shapes, loaded and exercised
  against a real SQLite engine — composite keys, cascade deletes, and
  unique constraints all confirmed correct) and `db/store.turso.js` (a
  same-signature replacement for `store.js`, using
  `@tursodatabase/serverless` specifically because `@libsql/client`
  pulls in native binaries that conflict with this repo's own "no
  native deps" rule — confirmed via `find node_modules -name "*.node"`
  before and after switching packages). **Neither file's Turso
  connection has been live-verified** — this sandbox has no network
  egress to `*.turso.io` (confirmed: "Host not in allowlist," a sandbox
  limitation, not a credentials problem). Left in the repo as a
  starting reference for Session 2, not a finished handoff — Session 2
  should verify the real connection independently and is free to
  diverge from this shape. Full detail in `SECURITY.md` §3c.
- Read the last 5 commits and this document fresh before starting this
  follow-up work, per the human's explicit ask, rather than assuming
  prior context still held — found the frontend had moved from "total
  gap" to "all five lanes shipped" since this session's own first read,
  and found real Vercel-deployment-prep commits (root entrypoint shim,
  build script) that had landed concurrently and needed merging before
  continuing.

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

**Follow-up (same session, human-requested):**
- Added this ledger.
- Added `IDEAS.md` (repo root) — a proposal board outside the app
  itself. Any session can add an idea; only the human marks one
  `**APPROVED**`/`**REJECTED**`; nobody self-approves. Mirrors the
  Function Assignment Gate pattern but as a plain file, not a route.
- Fixed Session 5's Finding 2 (`README.md` "Security notes"): the
  `security_alert` logging guarantee was stated more broadly than it
  actually behaves. Clarified that it applies to requests reaching
  the route handler — Express normalizes a raw non-encoded `../`
  before `safeResolve()` ever runs, so those fall through to the SPA
  shell unlogged (never a real vulnerability, since no file outside
  the workspace is touched either way; just previously-imprecise
  docs). Went with Session 5's own recommended option 1
  (docs-clarify) over option 2 (new middleware) — read the actual
  route/middleware chain myself and agree with Session 5's reasoning
  that a raw-`..` interceptor is unneeded complexity for a
  local-only tool where the real caller (an AI agent) always sends
  encoded paths anyway.
- Re-read every backend file end to end before touching anything,
  specifically to avoid manufacturing work. Finding 1 was already
  fixed by Session 5. Finding 2 (above) is now closed. No other bug
  found — backend genuinely is in the state Sessions 4 and 5
  reported.

### Session 1 — Frontend Core (Workspace + file tree UI)
**Status: shipped.** `frontend/index.html` (real app shell, replacing
Session 3's unblock-only placeholder), `frontend/js/router.js`,
`frontend/js/theme.js`, `frontend/js/pages/workspace.js`,
`frontend/css/base.css`, `frontend/css/workspace.css`,
`frontend/manifest.json`, `frontend/service-worker.js`,
`frontend/icons/`.

- `base.css` extends Session 3's `--aihub-*` tokens (dark values copied
  verbatim, unchanged) with a `[data-theme="light"]` variant and the
  app-shell layout (sticky header, bottom tab bar, safe-area-inset
  aware for notched phones).
- Router is hash-based (`#/project/:id/workspace|roster|instructions`),
  wires `projectselected` to navigation, and mounts Session 2's
  `SessionRoster`/`InstructionsPage` modules directly via their
  documented `init(mountEl, projectId)` contract -- including calling
  their returned `.destroy()` on every navigation away, so their
  polling timers don't leak when switching tabs or projects.
  `InstructionsPage.init()` is async; the router guards against
  mounting a stale controller if the user navigates away again before
  it resolves.
- Workspace: file tree, editor (deliberately no line-wrap so the
  gutter's line numbers stay correctly aligned to the textarea's
  actual rows -- wrapping would desync them without a much heavier
  editor component), download, delete, new-file creation.
- Conflict UI verified against a real `409` from the live server (not
  a mocked assumption, per Session 5's ask in the lane notes below):
  fetches the current server content and renders an actual LCS
  line-diff (capped at 2000 lines/side to avoid hanging the tab on
  something huge), not just a version-number message. Never
  force-writes automatically -- the human chooses keep-mine or
  use-theirs.
- Icons: pure-Node/zlib PNG generation, no native image libraries
  (canvas/sharp need a native compile step this project avoids
  everywhere else). Circular badge + ring/dot motif, built as an
  original composition in response to style direction the human gave
  on a reference image, not traced from it.
- Fixed Finding 1 from Session 5's report was already closed by
  Session 5 themselves; independently also found and fixed the same
  README Finding 2 wording (traversal-logging scope) Session 2 later
  fixed too -- both landed as parallel commits, merged by
  synthesizing one version from both rather than picking a side, since
  neither was wrong, just independently duplicated.

Verified end-to-end against the real backend before pushing: static
asset serving, project creation, file tree/read/write, the conflict
flow above, and registering as `session-1` in a local test project's
roster while developing (not committed -- `projects/` is gitignored).

---

---

## Definition of done for the whole project

`npm install && npm start` on a bare Termux install produces a working PWA
that a human can install to their home screen, create a project in, copy an
AI token from, and have all 5 of these lanes' worth of functionality work
against that token — with zero native compilation and zero cloud dependency.
