# INSTRUCTIONS.md — AI Collaborative Hub

**Local-first PWA — human + multiple AI coding sessions, one project, from a phone.**
**Repo:** `hrishitkoli-ship-it/the-aisapp-project` (private)

Read this fully before touching any file. Ironically, this project is itself
being built by multiple concurrent AI sessions — you are one of them, the
same way create-bedrock's INSTRUCTIONS.md (whose structure this file now
follows) coordinates that project's five sessions.

> _Maintenance note (restructure, this session): adopted create-bedrock's
> INSTRUCTIONS.md structure at the human's explicit request — Table of
> Contents, numbered Rules, a formal Session Start Procedure (including its
> "your own Requests outrank your backlog" ordering, which that project
> added after a real missed-request incident — importing it here
> preemptively rather than waiting to repeat it), a Known Failure
> Signatures table, and a closing Maintaining This File section. No
> technical content was invented in the move — every fact below already
> existed in the prior flat version; this pass only reorganized it. One
> real change alongside the restructure, per explicit human instruction:
> **Session 5 (Testing, docs, and integration) is retired as a dedicated
> lane.** Its historical ledger entry is kept as-is below (real, shipped
> work). Going forward its responsibility — verify your own work against
> the real server, don't just claim it — is Rule 6, binding on all four
> remaining sessions, matching how create-bedrock handles verification
> (its own Rule 6, no dedicated testing session either). Lane assignments
> below are now "(4 sessions)."
>
> **Update (Session 3, covering Session 5's retired scope): Known Failure
> Signature #4 looks resolved, but isn't fully confirmed.** `store.js` is
> now genuinely Turso-backed (`@tursodatabase/serverless`) and exports
> `run()` — `fileOps.js`'s calls to it are confirmed compatible: matching
> signature (`run(sql, args)`), matching return shape (`result.rows[...]`),
> cross-checked against every call site. The app also boots cleanly with
> real (if placeholder) `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` set — every
> route file requires without error. **What's NOT verified: an actual
> live query against a real Turso database.** This sandbox's network
> egress is blocked from reaching turso.io, same constraint store.js's
> own header comment already discloses for its author. Whoever has real
> Turso credentials should do the thing that comment asks for — create a
> project through the UI, reload the page, confirm it's still there —
> before this gets marked resolved for real. Full details in the Session
> 3 ledger entry below.

---

## 📑 TABLE OF CONTENTS

- [Current State](#current-state-as-of-this-write-up)
- [Non-Negotiable Architecture Rules](#non-negotiable-architecture-rules-do-not-violate-these)
- [Rule 0 — Session Start Procedure](#rule-0--session-start-procedure)
- [Lane Assignments (4 sessions)](#lane-assignments-4-sessions)
- [Coordination Protocol](#coordination-protocol)
- [Known Failure Signatures](#-known-failure-signatures-quick-lookup)
- [Session Ledger](#session-ledger)
- [Definition of Done](#definition-of-done-for-the-whole-project)
- [Maintaining This File](#maintaining-this-file)

---

## Current state (as of this write-up)

```
the-aisapp-project/
├── api/index.js              Vercel serverless entry (re-exports app.js)  ✅ DONE
├── vercel.json                Rewrites all routes to api/index.js         ✅ DONE
├── scripts/vercel-build-public.js  Copies frontend/ -> gitignored public/ ✅ DONE
├── backend/
│   ├── app.js                Express app, no .listen() -- shared by      ✅ DONE
│   │                         server.js (local) and api/index.js (Vercel)
│   ├── server.js             Thin local-dev wrapper: calls app.listen()  ✅ DONE
│   ├── db/store.js           Turso-backed datastore                       ✅ DONE (see KFS #4 correction above)
│   ├── db/store.turso.js     Reference file-content implementation,      ⚠️ UNMERGED
│   │                         not live-verified, not wired in yet
│   ├── db/schema.sql          Turso schema + size-cap triggers            ✅ DONE
│   ├── middleware/auth.js    Human vs AI identity, typed-error aware     ✅ DONE
│   ├── routes/
│   │   ├── activity.js       Read-only timeline                          ✅ DONE
│   │   ├── device.js         Device identity (12-char code), DELETE      ✅ DONE
│   │   ├── files.js          Tree/read/write/delete + conflict           ✅ DONE (see KFS #4 correction above)
│   │   ├── instructions.js   Notes/functionalities/assignments           ✅ DONE
│   │   ├── projects.js       Create/list/regen-token/delete              ✅ DONE (KFS #4 resolved; #7's recurrence-risk pattern still worth reading)
│   │   └── sessions.js       AI Session Roster                           ✅ DONE
│   └── utils/
│       ├── fileOps.js        Path safety + versioning                    ✅ DONE (see KFS #4 correction above)
│       └── tokens.js         Token gen/hash/verify, device-code aware    ✅ DONE
├── frontend/
│   ├── index.html             App shell, PWA meta, script loads          ✅ DONE (S1)
│   ├── manifest.json          PWA manifest                               ✅ DONE (S1)
│   ├── service-worker.js      Offline app-shell caching                  ✅ DONE (S1)
│   ├── css/
│   │   ├── base.css           Shared tokens, light+dark, shell           ✅ DONE (S1)
│   │   ├── projects.css       Project list/create/manage UI              ✅ DONE (S3)
│   │   ├── workspace.css      Tree/editor/diff view                      ✅ DONE (S1)
│   │   └── instructions-roster.css  Roster + Instructions styling        ✅ DONE (S2)
│   ├── js/
│   │   ├── theme.js           Dark/light toggle                         ✅ DONE (S1)
│   │   ├── router.js          Hash router + app-shell chrome             ✅ DONE (S1)
│   │   ├── projects.js        ProjectManager (list/create/token)         ✅ DONE (S3)
│   │   ├── activity.js        Shared activity-timeline component         ✅ DONE (S2)
│   │   ├── roster.js          Page 2: AI Session Roster                  ✅ DONE (S2)
│   │   ├── instructions.js    Page 3: Instructions/approval gate         ✅ DONE (S2)
│   │   └── pages/
│   │       └── workspace.js   Page 1: tree/editor/conflict UI            ✅ DONE (S1)
│   └── icons/                 PWA icons (192/512)                        ✅ DONE (S1)
├── projects/                  Local-dev runtime data, gitignored
├── public/                    Build artifact (vercel-build-public.js), gitignored
├── SECURITY.md                 Trust model, rate limiting, the open auth gap
├── IDEAS.md                    Proposal board -- human approves, nobody self-approves
├── KNOWN_ISSUES.md             Smaller, resolved-or-tracked issues log
├── .env.example                 Turso + local-dev env var template
├── package.json                 express, cors, nanoid, @tursodatabase/serverless
└── README.md                    Full API reference — READ THIS FIRST
```

**⚠️ CORRECTION (Session 4, found immediately after this restructure
landed): the "storage — currently broken" claim below is STALE. Known
Failure Signature #4 is now confirmed resolved, via the strongest
evidence tier available — not code inspection, actual live production
verification, witnessed directly by the human:** the real schema
(all three tables: `aisapp_devices`, `aisapp_projects`, `aisapp_files`)
was applied to the actual live Turso database via its SQL console
(the app's own live requests were failing with `no such table:
aisapp_projects` beforehand — a real, confirmed symptom, not assumed).
After applying it, the human loaded the real deployed app and it
correctly went from a hard `500 Internal server error` to
`"No projects yet. Create one above to get started"` — and then
successfully triggered the real device-secret lazy-creation flow
against production for the first time (the exact flow documented
further down this file), confirmed via a live screenshot showing the
actual response. This is genuinely resolved, not "looks resolved."
**Do not re-open this as broken without re-checking first** — if a
future session's own local testing suggests otherwise, that's more
likely a local/sandbox environment difference (e.g. no real Turso
credentials in that environment) than a regression, given the strength
of the evidence above. If something DOES look broken again, verify
against the real deployed URL before assuming a regression, and check
whether a schema-affecting change landed without a corresponding
migration being applied to the live database (schema.sql changing is
necessary but not sufficient — someone still has to run it against the
live database, the way this fix required).

The two-gaps framing directly below is otherwise still accurate for
gap (2) — real authentication on human-facing routes remains open —
but is now stale on gap (1). Left the original paragraph unedited below
this correction, per this file's own convention elsewhere of
preserving what was actually claimed rather than silently rewriting
history, but treat gap (1)'s description there as superseded by this
note.

**All three frontend pages and the whole backend route surface are built.**
The two live, unresolved gaps are: (1) storage — currently broken more
widely than "file content" alone: **project creation itself doesn't
fully work** (a created project's `project.json` never gets written,
so it 404s on every subsequent read) as well as file content — see
Known Failure Signature #4 for the full, now-widened scope — and (2)
real authentication on human-facing routes, an explicitly open
architectural question per `SECURITY.md` (not a bug, a decision not yet
made — see that file before assuming it's handled just because rate
limiting landed near it). Read `README.md` before writing any code — it
documents every route, the two-identity model, and conflict handling in
detail. Read `SECURITY.md` before touching anything auth-related — it
documents the trust model and exactly what is and isn't decided yet.

---

## Non-negotiable architecture rules (do not violate these)

1. **No native deps.** No SQLite, no Docker, no Python toolchain, no build
   step requiring node-gyp. Turso's client is pure JS over HTTP — it does
   not violate this. If you're tempted to add a bundler/framework for the
   frontend, stop — see Session 2's lane below for why vanilla JS is the
   requirement, not a preference.
2. **Two identities, enforced structurally, not just in the UI.** Human
   routes (`/api/projects/...`) need no *project* token. AI routes
   (`/api/ai/:id/...`) require `Authorization: Bearer <token>`. The AI
   Session Roster is read-only for humans and read/write for AI — there is
   deliberately no human-facing write route for it, and no AI-facing
   approve route for assignments. **Do not add routes that blur this
   line.** (This rule is about the human/AI split specifically — it does
   not mean human routes have no auth at all; see `SECURITY.md` for the
   separate, still-open question of authenticating the human surface
   itself now that this may run publicly.)
3. **The Function Assignment Gate is human-only by construction.**
   `POST /assignments/:id/approve` exists only on `humanRouter`. Never wire
   it onto `aiRouter`, even behind a permission check — the whole point is
   that no route exists for an AI token to hit.
4. **Path safety.** All file reads/writes go through `safeResolve()` in
   `fileOps.js`. Never bypass it with raw `fs`/DB calls from a route.
5. **Optimistic concurrency.** File writes accept `expectedVersion` and
   return `409` on mismatch rather than silently overwriting. Preserve this
   contract in any new write path, including whatever finally resolves
   Known Failure Signature #4.
6. **Verify against the real server, not just plausible-looking code.**
   Every ledger entry below that says "verified" means an actual request
   was made and an actual response was checked — not "read the code and it
   looked right." This is binding on every session, not a separate
   testing lane (see Rule 0 and Lane Assignments — this replaces what used
   to be a dedicated Session 5). The device-code bug (Session 3's
   follow-up ledger entry) is the concrete example of why: multiple
   earlier ledger entries said "verified against a live server," and the
   claim was true *at the time*, but a later change broke it and nobody
   re-verified after that change landed. Verification is a snapshot, not
   a permanent guarantee — re-check after anything adjacent changes, not
   just once per feature.

---

## Rule 0 — Session Start Procedure

Every session, every time you resume work — not just your first message:

1. Read this whole file. Don't assume prior context still holds; other
   sessions push independently and often.
2. Pull latest `main` (or re-fetch via the API) and check what's changed
   since you last looked, including files you're about to edit.
3. **Check your own Requests inbox first, before any self-directed work.**
   `GET /api/projects/:id/sessions`, find your own entry, read
   `taskQueue`. An open request from another session outrank your own
   backlog — address it first, not after. (This ordering is imported
   directly from create-bedrock's own Rule 0.5 step 7, added there after a
   real days-old unresolved cross-session request slipped through; adopting
   it here before that happens once, not after.)
4. Check `IDEAS.md` for anything proposed in your lane awaiting human
   review, and the Known Failure Signatures table below so you don't
   reintroduce a bug class already found and fixed at least once here.
5. Register or refresh yourself in the AI Session Roster
   (`POST /api/ai/:projectId/sessions`) with your lane as `function`, and
   keep `currentTask` updated via `PATCH` as you work. Not optional — it's
   how the human tracks five... now four... concurrent sessions from a
   phone.

---

## Lane assignments (4 sessions)

### Session 1 — Frontend Core (Workspace + file tree UI)
**Status: shipped** — see Session Ledger. Original scope: `frontend/index.html`,
base layout, service worker, PWA manifest, file tree browser, conflict UI
(diff-aware warning on `409`, never auto-force), client-side router.

### Session 2 — Frontend: Session Roster + Instructions pages
**Status: shipped** — see Session Ledger. Original scope: AI Session
Roster page (read-only, no write UI — there is no backend route for it),
Instructions & Functionalities page (notes editor, functionality list,
Approve/Reject buttons that only a human sees), shared activity-timeline
component. Vanilla JS only, no build step.

Currently also the session mid-decision on Known Failure Signature #4
(file-content storage: Turso vs filesystem) per the flag left in Session
3's follow-up ledger entry — that's this lane's call to make, not
something another session should pick a side on unasked.

### Session 3 — Project Management UI + onboarding, now also covering Session 5's retired scope
**Status: shipped** — see Session Ledger. Original scope: project
creation flow with one-time token reveal, project list/switcher, token
regeneration with confirmation, PWA install hint, destructive-action
confirmation on delete.

**Per direct human instruction, also now covering verification/
integration/docs** — the substance of Session 5's retired lane, on top
of (not instead of) Rule 6 applying to all four sessions equally. In
practice this has meant: full-lifecycle testing against a live server
after any handler rewrite (not just the one symptom that prompted the
rewrite), catching cases where a file's comments describe a migration
as further along than the code actually is, and keeping this file's
Known Failure Signatures / Session Ledger current when that happens —
see Session 3's ledger entries below for concrete examples.

### Session 4 — Security & hardening review
**Status: shipped, ongoing** — see Session Ledger. Audit, don't rebuild —
the backend patterns are already good. Path-safety edge cases, constant-time
token comparison, rate-limiting/abuse considerations now that this may go
public (see `SECURITY.md`), and — per Rule 6 — re-verifying earlier
findings still hold after adjacent code changes, not just checking them
once.

---

## Feature sprint (human-directed, 16 items)

The human sent a large fix/feature list framed for "an engineer AI" and
asked for it to be divided across sessions. Two corrections before the
division, since acting on either wrong premise would misdirect real
work:

- **This is not a Next.js/React app.** Vanilla JS, Express, Turso, no
  build step, no framework -- this has been Rule 1 since the very
  first version of this file. The human's own words on this: "Dont
  worry the languages used in this since ideas are genuine and addopt
  in your way" -- so every item below is translated to this actual
  stack (CSS transitions instead of framer-motion, a plain `h()`-based
  button factory instead of a React component, `Promise.all` + a
  simple cache instead of SWR/React Query, etc.), not skipped or
  blocked on the mismatch.
- **Session 2 is not "for testing."** They built the Turso migration,
  the device-secret system, composite tokens, rate limiting, and
  `IDEAS.md` -- substantial backend/security work, directly verified
  multiple times in this file's own Session Ledger. Session 5 (the
  actual testing/integration lane) is retired -- see the note at the
  top of this file -- folded into Rule 6 plus Session 3 explicitly
  covering that scope per separate human instruction. Division below
  is by which subsystem each item actually touches, given that
  correction.

**#1 (rebrand aihub -> aisapp) is done** -- see Session 3's ledger
entry. Ship order for the rest, as specified: **1-5 -> 7-12 -> 14-16 ->
13** (13 is explicitly optional and last).

**⚠️ LIVE COLLISION, found by Session 4 immediately after this division
landed: items #2, #4, and #5 below are reassigned to Session 1 here,
but Session 4 had already independently claimed and completed all
three** (see the original, now-superseded division this replaced, and
Session 4's own ledger entries for #2/#4/#5 — each shipped as its own
commit: `747bba4`, `dd714ee`, `7e98754`, in that order). Not caught
before landing because these were built and pushed across the same
window this restructure itself landed in — a genuine timing race, not
anyone doing anything wrong.

**Facts, stated plainly rather than unilaterally resolved by whichever
session reads this first:**
- #2 (File/Folder toggle): done in `frontend/js/pages/workspace.js` +
  `frontend/css/workspace.css`. Folder mode creates a starter file
  inside a trailing-slash path (this backend has no real empty-
  directory concept — confirmed by reading `fileOps.js`'s own header).
  Nested creation in one action required zero backend changes — already
  worked via the existing single-file PUT path once `buildFileTree()`
  was traced directly.
- #4 (re-render audit): done, same two files. Found `toggleDir()`
  (expand/collapse one folder) was calling the FULL `renderShell()` —
  tearing down and rebuilding the entire toolbar + tree on every single
  folder click. Fixed with a narrowly-scoped `rerenderTreePanelOnly()`
  that swaps only the tree panel's DOM node.
- #5 (skeleton loading): done, same two files. Replaced both genuine
  "Loading..." occurrences in `workspace.js` (tree panel, editor) with
  CSS shimmer rows matching real layout dimensions. One remaining
  "Loading..." exists in `router.js` (a single-word header label,
  resolves near-instantly) — deliberately left as plain text, flagged
  as out of scope rather than silently expanded into or silently
  missed; see Session 4's #5 commit message for the full reasoning.

**If you're Session 1 reading this: please check the three commits
above before doing any of your own work on #2/#4/#5** — redoing them
risks silently overwriting already-verified, already-shipped fixes
(exactly the pattern that's hit `routes/projects.js` multiple times
already this session — see Known Failure Signatures #7/#9). If you
have a strong reason these should be redone differently (a different
architectural approach, something Session 4's version got wrong), say
so here in the ledger rather than silently reverting — that's a real
conversation worth having explicitly, not something to resolve by
whoever commits last winning.

### Session 1 (shell / router / workspace / design system)
- **#2** -- New File dialog: add a File/Folder toggle (or support a
  trailing "/" to create a folder), including nested folder creation
  in one action.
- **#4** -- Audit for unnecessary full re-renders (this app's version
  of "re-render thrashing" without a VDOM: functions that rebuild a
  whole list on every small change instead of diffing). Cache rendered
  list items where cheap, avoid full-list rebuilds for a single-item
  change.
- **#5** -- Replace "Loading..." text with skeleton screens matching
  final layout (CSS shimmer, no dependency needed) for file list,
  roster, activity feed.
- **#7** -- Transitions app-wide: page nav, modal open/close, list
  add/remove, tab switches. Plain CSS transitions/keyframes, ease-out,
  ~150-250ms. Audit for instant/jumpy state changes.
- **#8** -- Buttons feel stiff: hover/active/press feedback (subtle
  scale/shadow), consistent radius/easing. Build one shared button
  factory (an `h()`-based helper with variants, matching the pattern
  `projects.js` already uses) instead of ad hoc styles per file.
- **#9** -- Per-extension file icons (.js/.ts/.json/.md/.txt/etc.) --
  extends `icons.js`.
- **#10** -- Real syntax-highlighted code viewer. Prism over Shiki --
  Shiki's typical usage assumes Node-side rendering or a WASM bundle;
  Prism drops in via a CDN script tag with zero build step, matching
  Rule 1.
- **#14** -- Actual visual design pass on the home page (hierarchy,
  spacing, accent) using whatever design tokens `base.css` already
  defines, not a plain list.

### Session 2 (backend / data / Turso)
- **#3** -- Profile the project/workspace fetch. Check for N+1 queries
  against Turso, missing indexes, redundant roster/activity refetch on
  every nav. Fix with `Promise.all` for parallel fetches + a simple
  in-memory cache layer (no SWR/React Query -- there's no React).
- **#6** -- "Download AI Instructions" button on the home page serving
  a SKILL.md that teaches any AI (Claude, ChatGPT, Gemini, DeepSeek,
  future models) this app's API/workflow. Must generate from a single
  source-of-truth doc and stay in sync automatically -- a script run
  during `vercel-build` (or as a pre-push check) that regenerates
  `SKILL.md` from the actual route definitions, not hand-maintained
  separately. Ties to this session's existing ownership of the
  API/backend surface being documented.
- **#12** -- "Download all files" per project -> .zip. JSZip
  client-side is simplest given no build step; a server-side zip
  stream is the alternative if project sizes make that impractical --
  this session's call given they own the size-limit logic already.
- **#13** (optional, last) -- Connect a GitHub repo per project, push
  files directly (OAuth or PAT).

### Session 4 (security / hardening / compliance + review)
- **#16** -- Privacy Policy + Terms & Conditions links in the home
  page footer. Require acceptance (checkbox/modal) before the first
  project can be created.
- **Standing, in addition to #16**: review Priority 1/2 items as they
  land from Sessions 1 and 2, consistent with this session's
  established audit role and Rule 6 -- e.g., confirm new animations
  don't break keyboard/focus handling, confirm the zip-download
  doesn't leak path info outside a project's own directory.

### Session 3 (this session -- project management UI + Session 5's retired scope)
- **#11** -- Search bar on the projects/home page, filtering by name
  and description. Lives directly in `projects.js`.
- **#15** -- Remove the permanent "Create project" form from home;
  replace with a blue circular FAB opening a modal/sheet for project
  creation. Also lives directly in `projects.js`.
- **Standing**: verify each item above as it lands (live-server
  testing, not just code review -- see this session's own ledger
  entries for why that distinction has mattered repeatedly), keep this
  file current.

---

## Coordination protocol

- **Rule 0 covers session start. This section covers the rest of the
  session.**
- **Commit and push after every meaningful change**, not in one big batch
  at the end. Other sessions can only see what's actually pushed — work
  sitting uncommitted locally is invisible to everyone else and defeats
  the point of a shared, git-connected coordination model.
- **Use `expectedVersion`** on every write once you've read a file once.
  Don't skip this because it's "probably fine" — that's the exact scenario
  it exists for with multiple concurrent sessions.
- **Need something outside your lane?** Use
  `POST /api/ai/:projectId/sessions/:targetSessionId/requests` to queue it
  for the right session instead of just doing it yourself and causing
  merge conflicts across lanes.
- **Proposing a new functionality or reassigning scope?** Use
  `POST /instructions/assignments` — it stays `pending` until the human
  approves it in the UI. Don't treat a proposal as approved just because
  it made sense to you. The same rule applies outside the app to
  `IDEAS.md`: propose, don't self-approve.
- **Found something important outside your own lane while working?** Don't
  sit on it, and don't silently go fix someone else's file mid-edit
  either. File it in `IDEAS.md` or as a session request so it's visible
  and tracked, not lost in a chat transcript only one person read.
- **If you hit a `409` conflict on a shared file** (likely `app.js`,
  `package.json`, or shared frontend CSS): re-read, re-apply your diff on
  top of the current version, and re-submit. Never `force: true` without
  understanding what you'd be overwriting.

---

## 🐛 Known Failure Signatures (quick lookup)

Bug classes already found in this project — check against this list before
writing new code in an adjacent area, so a third session doesn't rediscover
the same thing a third time.

| # | Signature | Root cause | Fix pattern | Found by |
|---|---|---|---|---|
| 1 | A route handler that calls an async `store.*` function without `await`, then responds immediately | `store.js` writes go through a lock queue that resolves on a microtask; the HTTP response can fire before the write actually lands | Every `store.*` call in a route handler must be `await`ed, and the handler must be `async` | Session 1 (project creation, pre-Turso) |
| 2 | `req.params.projectId` (or any route param) used directly in a filesystem/DB path with no validation | Only file *paths within* a project were going through `safeResolve()` — the project identifier itself wasn't | Validate the identifier itself before using it to build any path; throw a typed error, don't silently sanitize-and-continue (silent rewriting gives zero signal that an escape was attempted) | Session 4 (`projectDir()` traversal via DELETE) |
| 3 | An `async` Express route handler throws/rejects with no `try/catch`, and Express 4 doesn't route that to error middleware automatically | Missing `try/catch` + `next(err)` around `await` calls in a route handler | Every async handler needs its own `try/catch`, or a wrapper that catches and forwards to `next()`. Found independently **twice** — audit any new async route handler for this specifically | Session 4 (device DELETE crash), Session 3 (`routes/projects.js` create/regenerate/delete) |
| 4 | **[RESOLVED — see correction note near top of file for live-verification evidence]** File *content* storage is implemented twice, disagreeing: `fileOps.js` was rewritten to call `store.run()` against Turso, but the live `store.js` is still the fs-JSON version with no `run()` method. **Session 4 found this same root cause (route code written against a schema that isn't the live one) is not confined to `files.js`/`fileOps.js`** — `routes/projects.js`'s own header comment describes an `aisapp_projects` Turso table with automatic `ON DELETE CASCADE` and schema-default columns that do not exist in the live JSON-file `store.js`. This is why `POST /api/projects` currently creates an index entry but never writes a real `project.json` — confirmed live, not inferred (a created project immediately 404s on every subsequent read). See row 6 below for a related, now-fixed symptom of this same mismatch | Two (or more) sessions' work landed on top of each other mid-decision, before either fully replaced the other, and the affected surface is broader than first realized | Not a pick-a-line-and-fix-it bug — a real architectural call (Turso table vs. some other approach) that Session 2 is mid-deciding. Don't touch `files.js`/`fileOps.js`/`routes/projects.js` without reading Session 3's flag in the Session Ledger first. **If you find a THIRD file exhibiting this pattern, that's the point this needs to stop being "wait for Session 2" and become an all-hands architectural decision** — see Rule 6/Maintaining This File on updating this row rather than creating a fourth near-duplicate one | Session 3, verified live (`store.run is not a function`). Scope widened by Session 4, verified live (`project.json` never written, every created project immediately unreachable). **Resolved by Session 4**: real schema (`aisapp_devices`/`aisapp_projects`/`aisapp_files`) applied directly to the live Turso database via its SQL console; human confirmed the live app went from a hard `500` to working correctly, including a successful live device-secret creation |
| 5 | A storage write fails because the filesystem is read-only (e.g. a serverless environment), and the raw `fs` error surfaces as an opaque 500 | Vercel's deployed bundle is read-only outside `/tmp`; no distinction was made between "bug" and "expected environment limitation" | Catch the specific read-only error codes (`EROFS`/`EACCES`/`ENOENT`/`EPERM` — confirmed via a real read-only mount test, not assumed; deliberately excludes `ENOSPC` so a real full-disk problem doesn't get mislabeled) and throw a typed error the central handler turns into a clean `503` | Session 3 |
| 6 | A route's own comments describe a Turso/SQL schema (table names, FK cascades, parameterized queries) that doesn't exist anywhere in the actual `store.js` it calls | A migration was planned/assumed complete and documented as such in code comments, before the underlying file was actually changed to match | Don't trust a file's comments about *another* file's behavior — verify by reading that other file directly. `grep` for the specific function/table names the comment claims exist | Session 3 (`routes/projects.js` header + inline comments, twice — see Session Ledger) |
| 7 | A route handler is rewritten for a new concern (e.g. bundling an encryption key into the token) and silently drops an unrelated call it used to make (e.g. `saveProject()`, `generateDeviceCode()`), because the rewrite was done against a mental model of the datastore that had already changed elsewhere | Two independent pieces of in-flight work (a datastore migration + a token-format change) landed on the same file at different times, each written against a different assumption about the other | After any rewrite of a route handler, re-run the FULL lifecycle for that resource (create, single-lookup, update, delete) against the real server — not just the specific case the rewrite was for. This is genuinely Rule 6, just stated for the specific case of "a handler got rewritten," not only "new code got written" | Session 3 (device-code embedding dropped a 2nd time; `saveProject()`/`removeProjectDir()` both silently dropped in the same rewrite). **Also the exact mechanism behind row 9's recurrence below** — same file, same pattern, different dropped fix |
| 8 | Two files that are supposed to share one definition (`app.js` as the shared Express app; `server.js`/`api/index.js` as its two consumers) silently diverge because one of them was never actually rewritten to depend on the other — it just independently rebuilt an equivalent-looking copy instead | `server.js` predates the `app.js` split and was never actually converted to import it, despite `app.js`'s own header comment claiming it was. No test exercised `server.js` specifically after `app.js` started gaining new middleware (helmet/CSP, rate limiting), so the drift wasn't visible until something added to `app.js` was checked against the real entry point and found completely absent | When a refactor claims "two consumers share one definition," grep for the actual `require()`/`import` proving that, don't trust the comment. If a fix only seems to take effect through one of two supposedly-equivalent entry points, suspect this pattern immediately | Session 4 — found while verifying CSP headers actually reached `node backend/server.js`, the real local/Termux entry point, not just `app.js` loaded in isolation |
| 9 | **[RECURRED ONCE ALREADY — see row 7 for why]** A route's own comment says "no secrets included" / matches clearly-intended behavior, but the actual response leaks a secret field anyway, because the route was written against a different store.js/schema shape than the one actually live (same root cause family as row 4, different concrete symptom) | `GET /api/projects` returned every project's `tokenHash` in the clear to any unauthenticated caller — the route's own `stripSecret()` helper exists and is correctly used by three OTHER routes in the same file, just not this one, because `store.listProjects()` on the live store.js returns a different (fuller) shape than whatever this route was written expecting | Don't trust a route's own comment describing its output shape — check what the live `store.*` function actually returns and confirm the response is filtered through the same secret-stripping helper every sibling route in the file already uses. Fixed by routing the response through the existing `stripSecret()` (`.map(stripSecret)`) rather than inventing a new filtering approach. **This exact fix was lost once already** when `routes/projects.js` was independently rewritten from a base that predated it (row 7's pattern, applied to this same fix) — re-applied and re-verified live a second time; full writeup in `KNOWN_ISSUES.md` specifically so a THIRD occurrence is less likely (grep-able, not just buried in a diff) | Session 4 — found live, not by code review, while testing an unrelated fix (`app.js`/`server.js` reconciliation) end-to-end. Recurrence found and re-fixed later the same session, immediately after pulling a new round of `routes/projects.js` changes |
| 10 | A route's own `catch` block checks `err instanceof SomeErrorClass` where `SomeErrorClass` is a `store.*` export that doesn't actually exist on the live `store.js` — `instanceof`'s right-hand side must be a constructor, so checking against `undefined` *throws a TypeError*, inside the very catch block meant to handle the original error, with nothing above it to catch that second throw | Distinct mechanism from row 3 (which is about a *missing* try/catch) — here the try/catch exists, but its own error-classification logic is what fails. `routes/files.js` and `routes/projects.js` both checked `err instanceof store.ProjectSizeLimitError` / `store.AccountSizeLimitError`, neither of which store.js exported at the time | Prefer a generic `if (err.statusCode)` check over hardcoding specific error classes one at a time (matches any current or future typed error without needing another manual fix each time the typed-error set changes) — this is exactly the pattern `app.js`'s own central handler had already been reconciled to, before this row's fix ported the same pattern to these two routes' *own* local catch blocks, which intercept before ever reaching `app.js`'s handler at all | Session 1 — found live while testing file writes (a normal, no-conflict write triggered it; the underlying `fileOps.js` error it was trying to classify is row 4's `store.run is not a function`), confirmed the crash, applied the fix, confirmed the same request then returns a clean response with the server still running |

---

## Session Ledger

Running record of what's actually landed, kept up to date by whichever
session last touched something. Not a task list (that's Lane Assignments
above) — this is "what shipped," so a session starting cold — or the human
checking in from a phone — doesn't have to diff commit history to know
current state.

### Session 3 — Project Management UI + onboarding
**Status: shipped.** `frontend/js/projects.js` + `frontend/css/projects.css`.
Create/list/switch/regenerate/delete, token-reveal modal (shown once,
mirrors GitHub PAT UX), destructive-action confirms, PWA install hint.
Also authored the placeholder `frontend/index.html` (Session 1 owned
replacing it) purely to unblock the SPA-fallback 500 documented in
`KNOWN_ISSUES.md`.

**Follow-up (same session, human-requested): Vercel readiness + storage
hardening.**
- Root `server.js` shim + `scripts/vercel-build-public.js` (copies
  `frontend/` → gitignored `public/` at build time) so Vercel's
  zero-config Express detection and static-asset CDN serving both work
  correctly. `frontend/` stays the single source of truth;
  `backend/server.js` and local `npm start` are untouched.
- **Storage hardening** (Known Failure Signature #5): typed
  `StorageReadOnlyError` (503) instead of a raw fs error, central error
  handler respects a typed error's `statusCode` (additive only, every
  existing error path unaffected), all three write routes in
  `routes/projects.js` properly `try/catch` + `next(err)` (Known Failure
  Signature #3 — `create` had no try/catch at all before this). Verified
  against a real read-only bind mount, not a mock.
- **This is a stopgap, not the real fix** — it makes the failure mode
  honest, it doesn't add persistent storage. Should likely be simplified
  or removed once Known Failure Signature #4 is actually resolved.
- Filed two ideas in `IDEAS.md` rather than building them unasked: audit
  other route files for the same try/catch gap, and remove this stopgap
  once Turso file storage lands.

**Follow-up (same session, human-requested): fixed broken project
creation.**
**Status: shipped.** `POST /api/projects` was throwing a 500 on every
call — `generateDeviceCode` was referenced throughout `store.js`/
`routes/projects.js`/`routes/device.js` but never actually implemented in
`utils/tokens.js`, and `generateToken()` ignored the `deviceCode` argument
being passed to it. Found by actually running the endpoint, not by
reading code — worth noting since several ledger entries above this one
say "verified against a live server," and this bug still slipped through
because it landed *after* that verification happened (see Rule 6 on why
verification is a snapshot, not a permanent guarantee).

Added `generateDeviceCode()`, made `generateToken(deviceCode)` actually
embed it (`aisapp_<12-char code>_<random>`, falls back to the original
shape if no deviceCode is passed). Verified live: project creation works,
a second project on the same device gets the *same* deviceCode, regenerate
uses the same path, new-format tokens authenticate fine.

**Found but deliberately not touched — Known Failure Signature #4 above.**
Flagged for Session 2, who was already mid-decision on this as of this
entry. Not a one-right-answer fix like the device-code bug — a real
architectural call, left for whoever's already deciding rather than
picking a side unasked.

**Follow-up (same session, human-requested): took over Session 5's
retired lane — verification/integration/docs, per Rule 6 and the human's
direct instruction, on top of this session's own Project Management UI
lane.**

First finding under the new scope: the composite-token commit
(`tokens.js`'s auth+encryption-key bundling) re-broke the device-code fix
above — 2nd time this exact function has gone missing (Known Failure
Signature #7). Also found, via full-lifecycle testing rather than just
re-checking the one thing that broke last time: `routes/projects.js`'s
create handler no longer called `store.saveProject()`, only
`addProjectToIndex()` — new projects existed in the list but 404d on
every single-project lookup, meaning regenerate-token and delete were
broken for every project created after this landed. Delete had the
mirror problem: `store.removeProjectDir()` was dropped too, so delete
reported success while silently leaving the entire project directory on
disk — a real violation of this session's own UI copy promising
"permanently removes... all its files."

Root cause for all three: `routes/projects.js`'s comments (header and
inline) described `store.js` as Turso-backed with a real SQL schema —
table names, FK cascades, `assertValidProjectId()` — none of which exist
in the actual file, which is still the original fs-based datastore
(Known Failure Signature #6). The comments look like they were written
against an intended migration, before `store.js` was actually changed to
match.

Fixed: restored `generateDeviceCode()` (composed correctly with the new
`authToken.encryptionKey` format — device code lives entirely in the
auth portion, no conflict), restored `saveProject()` on create and
`removeProjectDir()` on delete, corrected every comment that described
the fictional schema. Verified the full lifecycle end-to-end against a
live server, not just the specific symptom: create → device-code
embedding confirmed (two projects on the same device share the same
12-char code) → `project.json` confirmed present on disk → single-lookup
confirmed 200 (was 404) → regenerate confirmed (device code preserved
across regeneration) → delete confirmed both API success AND actual
directory removal from disk → post-delete single-lookup confirmed 404.

Added Known Failure Signatures #6 and #7 above — the pattern here
(comments describe a migration as complete, a rewrite silently drops an
unrelated call because it was written against stale assumptions about
the datastore) is distinct from #3/#4 and worth its own entries so a
future rewrite of this file checks for it explicitly.

**Follow-up (same session): the real Turso migration landed since the
entry above.** `store.js` genuinely imports `@tursodatabase/serverless`
now (not assumed-but-actually-fs, this time it's real) — confirmed via
its own header comment plus a real `require()` throwing exactly the
documented "TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set" error
without them. This also means a claim in this same session's chat
transcript ("nothing will use these env vars yet") is now stale as of
this migration — worth knowing if referring back to that conversation,
since the app no longer boots at all without them.

`routes/projects.js` was rewritten again to match (this is genuinely
correct this time, unlike the two prior "assumed Postgres/Turso"
rewrites) — cross-checked every store call in `projects.js`, `sessions.js`,
`instructions.js`, `activity.js`, and `device.js` against the new export
list; all resolve. `device.js`'s header comment mentions the old
`store.projectDir()` call — checked whether that's live code or just
describing history: confirmed it's only in a comment (the actual delete
cascade correctly uses `removeProjectFromIndex`), so this was a false
alarm caught by checking rather than just flagging on a grep match.

Found and fixed one real (if minor) issue: `routes/projects.js`'s delete
handler had an inline comment claiming FK cascade handles cleanup,
directly contradicting both the file's own header comment two lines
above and `store.js`'s actual `removeProjectFromIndex` (which explicitly
does NOT rely on cascade, and says why). Corrected to match reality.

**KFS #4 status — see the updated note at the top of this file.**
Confirmed `fileOps.js`'s `store.run()` calls are interface-compatible
with the real `run(sql, args)` now exported (signature and return shape
both checked against actual call sites, not just that the name exists).
Confirmed the whole app boots cleanly with placeholder Turso credentials
-- every route file requires without error. **Could not verify an
actual live query** -- this sandbox can't reach turso.io, matching the
exact limitation store.js's own author already disclosed. This needs a
real "create a project, reload, confirm it persisted" check from
whoever has real credentials before it's fully confirmed fixed.

**Follow-up (same session): live-blocking bug found via a real
screenshot of aisapp.vercel.app, not this sandbox** (can't reach the
live URL at all, same network limitation as above -- this is the kind
of thing only a person with an actual browser can catch). Session 4's
new `requireDeviceSecret` middleware (see SECURITY.md §3b,
`backend/middleware/auth.js`) is a real, well-reasoned security
improvement -- gates write actions behind a per-device secret now that
"the device is the boundary" no longer holds on a public deployment.
It lazily creates a secret on the first-ever write and returns it once
in the 401 body. But `frontend/js/projects.js` had zero code to read
that field, show it, or retry -- every real user's first create/delete/
regenerate attempt just showed a raw technical error with no way
forward through the actual UI. Backend was doing the right thing; there
was no frontend pathway to use it.

Fixed: `api()` now proactively sends `X-Device-Secret` from localStorage
on every request, and specifically detects the one-time-creation
response shape (401 + `body.deviceSecret`) to show a reveal modal
(mirrors `showTokenModal`'s exact safety properties -- no Escape, no
tap-outside, focus trapped, since losing this before saving has the
same permanent-loss consequence as an AI token), save it, and
transparently retry the original request once. `deleteProject`/
`regenerateToken` inherit this for free -- both are thin wrappers
around the same `api()` function.

Verified via a mocked-fetch jsdom test (the real backend needs a live
Turso connection this sandbox can't reach, so this tests the frontend
logic specifically, independent of that separately-confirmed-compatible
but not-live-verified piece): 5/5 pass, including confirming exactly
one retry happens (not a loop) and that a second independent write
sends the header proactively with no modal shown a second time.

The same screenshot also incidentally confirmed several previously-
unverifiable-from-this-sandbox things actually work on the real
production deployment: dark theme, PWA install hint, empty state
copy, and the Vercel routing/static-serving setup from earlier in this
session all render correctly on the live URL.

### Session 4 — Security & hardening review
**Status: shipped, ongoing.** Audited `fileOps.js`/`store.js` path-safety,
found and fixed the `projectDir()` traversal gap (Known Failure Signature
#2) via isolated PoC, not theoretical. Confirmed token comparison is
constant-time throughout.

**Follow-up (same session, human-requested): permanent device identity +
rate limiting.** Built the 12-char device-code system (later needed the
Session 3 fix above to actually work). Built `db/schema.sql` +
`db/store.turso.js` as unverified reference groundwork — explicitly NOT
this lane's deliverable, explicitly not live-verified (no network egress
to `*.turso.io` in this sandbox), explicitly flagged for Session 2 to
verify independently rather than trust as-is.

Found a live crash bug while doing this: the device DELETE route called a
non-existent store function with no try/catch around its async body,
crashing the whole process on that request (Known Failure Signature #3,
found independently a second time). Fixed.

Added four-tier rate limiting once the human confirmed this app is moving
toward a public Vercel deployment, and wrote `SECURITY.md` documenting the
trust model. **The rate limiting landed on top of the Turso migration and
was partially lost in that merge — found and restored in a later pass,
same session.** `SECURITY.md` is explicit that rate limiting slows abuse
of the human-route auth gap, it does not close it — real authentication
there is flagged as an open, undecided architectural question, not solved
by anything in this pass.

**Follow-up (same session, human-requested): additional hardening +
public-deployment prep.** Started rebuilding a device-secret write-gate
for human-facing routes (matching `SECURITY.md`'s flagged open gap) —
**abandoned mid-build** once `git pull` surfaced Session 3's real device-
identity rebuild landing concurrently; the in-progress work was
architecturally superseded before completion and was not carried forward
(old stashes from this abandoned attempt were cleaned up rather than left
to confuse a future session).

Added `helmet` with a carefully-configured CSP to `app.js` — baseline
security headers plus a `script-src` policy locked to `'self'` and one
specific sha256 hash for `index.html`'s one inline script. New
`scripts/compute-csp-hash.js` computes that hash from the real file's
exact byte content, added specifically because a hand-retyped first
attempt at the same hash, during this same pass, produced a silently
wrong value — caught by double-checking, not by inspection.

**Bigger finding while verifying the CSP actually worked**: booted via
the real entry point (`node backend/server.js`) and found the header
completely absent. Root cause: `server.js` never actually imported
`app.js` at all, despite `app.js`'s own header comment claiming it does —
it built its own fully independent, duplicate Express app from scratch.
The two had silently diverged in both directions (`server.js` had
`device.js` mounted and `app.js` didn't; `app.js`'s error handler
referenced two `store.js` error classes that don't currently exist;
`server.js` had the service-worker no-cache header and the explicit
`/api/*` 404 handler, `app.js` had neither; body-size limits differed for
no stated reason). Every difference was reconciled INTO `app.js` first,
each verified live in isolation, before rewriting `server.js` as the thin
wrapper it always claimed to be (111 lines of duplicated app definition
→ 65 lines of actual wrapper). Re-verified the full flow end-to-end
through the real entry point afterward, not just `app.js` in isolation.
Added as Known Failure Signature #6 — this class of drift (two files
that are supposed to share a definition, where one was never actually
converted to depend on the other) seemed generically worth watching for
elsewhere, not just noting as a one-off.

**While running that end-to-end verification, found a live secret leak
unrelated to what was being tested**: `GET /api/projects` — fully
unauthenticated — was returning every project's `tokenHash` in the clear.
Same root cause family as Known Failure Signature #4 (route code written
against a different store.js shape than the live one — confirmed
`routes/projects.js`'s own header comment describes a Turso
`aisapp_projects` table that doesn't exist yet), but unlike that broader
architectural question, this specific fix was safe and appropriate to
make immediately: `stripSecret()` already exists in the same file and is
already used correctly by three sibling routes — this one just missed
it. Fixed by routing the response through the same existing helper,
verified live (before: real hash in a real response; after: field
absent, every other field intact). Added as Known Failure Signature #7.
Deliberately did NOT touch the deeper issue that caused it (the on-disk
`_index.json` still contains `tokenHash` — that's Known Failure
Signature #4's territory, Session 2's call).

Also widened Known Failure Signature #4's documented scope: the same
route/schema mismatch that breaks file storage also means
`POST /api/projects` currently never writes a real `project.json` at
all — confirmed live (a project is created, then immediately 404s on
every subsequent read). Not a new bug, the same one, just found to be
wider than the existing table row described.

**Follow-up (same session): git identity fix + the device-secret
write-gate finally built, against the real Turso schema this time.**

Fixed a real, blocking issue first: a Vercel deployment was blocked
because this session's git commits used `session4@ai-collab-hub.local`
as the author email (set early this session, when the sandbox had no
git identity configured at all) — not a valid email Vercel's deployment
protection would accept, since it checks the commit author against the
GitHub account's real associated email. Reconfigured to the repo's
actual owner identity (confirmed from existing commit history —
`hrishitkoli-ship-it <hrishitkoli@gmail.com>` was the only identity in
the whole log that wasn't a session placeholder). Flagging for future
sessions: every session this repo has seen has used its own placeholder
git identity (`session4@...`, `session5@...`, `hub@local`) — any of
these committing again will trip the same block. Past commits with bad
identities weren't rewritten (force-pushing history in an actively
multi-session repo is a bigger risk than the problem it'd solve); only
the current/future identity was fixed, which is what actually
determines whether the *next* deployment succeeds.

Then: built the device-secret write-gate `SECURITY.md` §3b had flagged
as open since earlier this session. Started against the OLD fs-JSON
`store.js` (the version live before this pull), using a JSON-object-
merge pattern ("spread the existing object, then add the new field")
— then Session 2's real Turso migration landed mid-build (`e55624a`
and surrounding commits). Checked before assuming the old approach
still applied: `getDevice`/`saveDevice` are genuinely async now, backed
by a real `aisapp_devices` SQL table, not a JSON file — the JSON-merge
reasoning didn't transfer, since SQL rows don't have an "accidentally
overwrite unrelated fields" failure mode the way `writeJSON()`
overwriting a whole object does. Rebuilt against the real schema:
added a nullable `device_secret_hash` column to the existing
`aisapp_devices` table (additive only — no change to any existing
column, no new table, no change to `aisapp_projects`' FK relationship
— deliberately narrow given this is actively-owned territory, same
respect shown when the device-identity gap itself was first found
earlier this session).

Installed `@tursodatabase/database` (the native, local-file package,
dev-only — never a runtime dependency) specifically to test this schema
change against a REAL local Turso-compatible engine before trusting it,
matching the rigor `schema.sql`'s own header already established for
the size-cap triggers. Worth naming a real mistake this caught: assumed
`code TEXT PRIMARY KEY` implied `NOT NULL`, the way it would in
Postgres/MySQL — direct testing proved SQLite does NOT make that
guarantee for a `TEXT` primary key (only `INTEGER PRIMARY KEY` gets
special `rowid`-aliasing behavior that makes it feel that way). An
`INSERT` omitting `code` entirely was confirmed to succeed, silently
storing a `NULL` primary key — added an explicit `NOT NULL` to close
this, re-tested, confirmed fixed. Also confirmed this schema addition
didn't break the existing size-cap triggers (a real regression risk
whenever a shared table gets touched) by deliberately re-running a
size-cap violation test after the edit and confirming it still
correctly rejects.

Wired `requireDeviceSecret` into `middleware/auth.js` and applied it to
the three destructive `projects.js` routes (create/regenerate-token/
delete) and `device.js`'s delete-cascade, alongside `humanSensitiveLimiter`
— found, for a confirmed 5th time, silently missing from `projects.js`
(same recurring pattern as Known Failure Signature #7/#9 — see
`KNOWN_ISSUES.md`), re-added in the same pass.

**Honest verification status, stated plainly rather than overclaimed:**
the middleware's own control-flow logic (lazy secret creation, correct-
secret retry succeeding, wrong-secret and missing-header rejection, no
secret ever leaked on failure) was tested directly and passed on every
case — but via an isolated test with a hand-built mock of `store.js`,
not a live request against a real Turso database, since this sandbox
still cannot reach `*.turso.io` (same disclosed limitation carried all
session). The schema/SQL correctness was separately verified against a
real local engine. The two were never proven together end-to-end
against one live connection — that first real proof happens at actual
deploy time. Full detail in `SECURITY.md` §3b, updated in place with
this same caveat rather than silently marked done.

While reconciling this work against Session 2's concurrent Turso
migration, also confirmed (not just assumed) that a separately-landed
fix (`0171834`, same general timeframe) correctly applied the exact
same `instanceof`-against-nonexistent-error-class fix this session's
own `app.js` error-handler fix used earlier, independently rediscovered
and correctly extended to two route files (`files.js`, `projects.js`)
whose own local catch blocks bypassed `app.js`'s handler entirely —
good confirmation the pattern is being recognized and maintained
consistently now, not just fixed once and forgotten.

**Follow-up (same session, human-provided 16-item fix/feature prompt,
framed against Next.js — this app is confirmed Express + vanilla JS
throughout, no React tree anywhere): claimed and shipped items 1–5
(Priority 1) as this lane's own subset.** Commits: `eac2345` (#1),
`747bba4` (#2), `aa17acd`→amended to `008bd04` (#3, see below), `dd714ee`
(#4), `7e98754` (#5).

- **#1 (rebrand aihub→aisapp):** visible surfaces only (title, PWA
  manifest name/short_name, in-app header, doc titles) — deliberately
  NOT the ~547 `aihub-*` CSS class occurrences (cosmetic-internal, zero
  user-visible difference) and NOT the token-prefix format or the
  `localStorage` device-secret key (both load-bearing; renaming either
  breaks existing tokens/saved secrets — this is a wire-format/storage-
  key change, not branding). A later session (`b2171b6`) did the full
  repo-wide rename including those two categories — see that ledger
  entry for how it handled the backward-compatibility concerns this
  entry flagged as needing care if attempted.
- **#2 (File/Folder toggle):** real modal replacing a bare
  `window.prompt()`. This backend has no empty-directory concept at
  all (confirmed via `fileOps.js`'s own header) — Folder mode creates a
  starter file inside a trailing-slash path, matching the fix request's
  own suggested fallback. Nested creation in one action needed zero
  backend changes — `buildFileTree()` already splits every path segment
  correctly, verified by replicating its logic against real generated
  paths, not just reading it.
- **#3 ("project load is slow"):** traced the actual frontend fetch
  pattern first (router.js/workspace.js/instructions.js/activity.js) —
  found no redundant-refetch or N+1-shaped pattern in the REST layer;
  that framing doesn't map onto this architecture. The real, confirmed
  inefficiency was server-side: `buildFileTree()` fetched every file's
  FULL content just to compute a size number via `Buffer.byteLength()`.
  Fixed via `octet_length(content)` (server-side byte count, no
  transfer) — verified this wasn't a silent correctness regression by
  testing directly against a local libSQL-compatible engine first
  (SQLite's plain `length()` returns character count, not bytes, for a
  `TEXT` column — confirmed `length('café')=4` vs `octet_length('café')=5`
  — using the wrong one would have silently produced wrong sizes for any
  non-ASCII content). Commit message initially got mangled by the exact
  backtick-in-`git commit -m` bug this file already documented
  elsewhere — hit it directly, fixed via `--amend` + a message file
  rather than leaving corrupted history.
- **#4 ("UI is laggy," originally framed as React re-render
  thrashing):** no VDOM here to profile. Found the real bug by reading
  `renderShell()` directly: `toggleDir()` (expand/collapse ONE folder)
  called the FULL page rebuild every time — tree + toolbar torn down
  and rebuilt on every single folder click, scaling badly with project
  size. Fixed with a narrowly-scoped `rerenderTreePanelOnly()` swapping
  only the tree panel's DOM node. Re-verified the diagnosis was still
  accurate against the current file before writing the fix, not
  assumed carried-over — `workspace.js` changed by net -220 lines in a
  same-day rebrand pass that landed mid-work on this exact item.
- **#5 (skeleton screens):** pure CSS shimmer (no dependency, per the
  request's own instruction), varied bar widths rather than identical
  bars (reads as approximating real content, not an obviously-fake
  placeholder grid), dimensions matched to the real `.aisapp-tree-row`
  CSS rather than guessed. Included a `prefers-reduced-motion`
  fallback, not explicitly asked for but cheap and worth doing for any
  animated UI. One remaining "Loading..." in `router.js` (header
  project-name label) deliberately left as plain text and flagged
  rather than silently expanded into or silently missed — a full
  skeleton for a two-word label felt disproportionate, and `router.js`
  is shared/core-routing territory outside this item's actual scope.

**Real collision found and flagged, not silently resolved either
way:** after pushing all five, a separately-landed restructure of the
Lane Assignments section (`7d9f0dc`) reassigned items #2/#4/#5 to
Session 1 — a genuine timing race (both landed in the same general
window), not anyone's mistake. Flagged this explicitly in that section
with the facts and commit references, rather than either unilaterally
deciding Session 1 should discard its own plans or silently letting a
future Session 1 redo (and risk silently overwriting) already-shipped,
already-verified work. See the Lane Assignments section itself for the
full flag.

**Also found and corrected, same follow-up:** the `7d9f0dc` restructure
of this file's top-of-file "Current state" summary and file-tree status
table preserved historical findings accurately (verified this directly,
not assumed) but left several storage-related items marked broken/open
that are actually resolved — Known Failure Signature #4 specifically,
confirmed resolved via direct, human-witnessed live production
verification (the real schema applied to the real live Turso database
via its own SQL console; the human's own screenshots show the live app
going from a hard `500` to working correctly, including successfully
triggering the real device-secret flow against production). Corrected
in commit `766f305` — added a clear correction note rather than
silently rewriting the original claim, per this file's own established
convention of preserving what was actually claimed at the time.

### Session 2 — Session Roster + Instructions pages
**Status: shipped.** `frontend/js/roster.js`, `frontend/js/instructions.js`,
`frontend/js/activity.js` (shared component), `frontend/css/instructions-roster.css`.

- Roster: strictly read-only per spec. Sessions sorted active-first, stale
  (>10min silent) pushed down. Nested task-queue rendering with priority
  badges.
- Instructions: debounced notes autosave, functionality list, the Function
  Assignment Gate (Approve/Reject exist only on this page, call only the
  human-facing routes — no client-side permission check added on top,
  since the backend route boundary already is the boundary).
- Activity timeline: shared, `security_alert` entries rendered distinctly.
  Polling pauses on `document.hidden`, resumes + refreshes on return.

Verified against a live local server: seeded real sessions/requests/
assignments through actual API calls, triggered a genuine `security_alert`
via an actual encoded-traversal attempt, clicked the real Approve button
and confirmed via separate `curl` that the write persisted and got
logged — not just that the DOM updated.

**Follow-up (same session, human-requested):**
- Added the Session Ledger pattern and `IDEAS.md`.
- Fixed a README precision gap on `security_alert` logging scope
  (clarified it applies to requests that reach `safeResolve()` — a raw
  non-encoded `../` gets normalized by Express before that point, so it
  falls through to the SPA shell unlogged; never a real vulnerability
  either way, since no file outside the workspace is touched regardless).
- Re-read every backend file end to end before touching anything,
  specifically to avoid manufacturing work.

### Session 1 — Frontend Core (Workspace + file tree UI)
**Status: shipped.** `frontend/index.html` (real app shell, replacing
Session 3's unblock-only placeholder), `frontend/js/router.js`,
`frontend/js/theme.js`, `frontend/js/pages/workspace.js`,
`frontend/css/base.css`, `frontend/css/workspace.css`,
`frontend/manifest.json`, `frontend/service-worker.js`, `frontend/icons/`.

- `base.css` extends Session 3's `--aisapp-*` tokens (dark values copied
  verbatim) with a `[data-theme="light"]` variant and the app-shell layout
  (sticky header, bottom tab bar, safe-area-inset aware).
- Router is hash-based, wires `projectselected` to navigation, mounts
  Session 2's `SessionRoster`/`InstructionsPage` modules via their
  documented `init(mountEl, projectId)` contract, including calling their
  returned `.destroy()` on every navigation away so polling timers don't
  leak. `InstructionsPage.init()` is async; the router guards against
  mounting a stale controller if the user navigates away again before it
  resolves.
- Workspace: file tree, editor (deliberately no line-wrap so the gutter's
  line numbers stay aligned to the textarea's actual rows), download,
  delete, new-file creation.
- Conflict UI verified against a real `409` from the live server: fetches
  the current server content and renders an actual LCS line-diff (capped
  at 2000 lines/side), not just a version-number message. Never
  force-writes automatically.
- Icons: pure-Node/zlib PNG generation, no native image libraries.
- Independently found and fixed the same README wording gap Session 2
  fixed — both landed as parallel commits on the same real issue, merged
  by synthesizing one version rather than picking a side, since neither
  was wrong, just duplicated.

Verified end-to-end against the real backend before pushing: static asset
serving, project creation, file tree/read/write, the conflict flow above,
and registering as `session-1` in a local test project's roster while
developing (not committed — `projects/` is gitignored).

**Follow-up (same session, human-requested): emoji removal + icon
system, plus an unrelated live crash fix found along the way.**
- New `frontend/js/icons.js`: 19 hand-drawn stroke SVG icons replacing
  every emoji found across `router.js`/`workspace.js` (mine) and
  `activity.js`/`projects.js` (Sessions 2/3) — a cross-cutting change,
  so it's one shared module rather than patched differently per file.
  `currentColor` stroke means every icon follows the theme
  automatically. Verified visually before shipping (rendered the actual
  shipped path data to a real PNG grid via a one-off local cairosvg
  install, dev-only, not a project dependency), not just by reading
  path coordinates. Caught two integration gaps pre-push: `icons.js`
  wasn't wired into `index.html`'s script tags at all, and the service
  worker's cached-asset list hadn't been updated (bumped to v3).
- Small additional polish within own files: button press-state and
  hover transitions, previously instant/no-transition.
- Separately, human explicitly redirected away from Session 4's
  territory (the admin-secret/human-route-auth work Session 4 itself
  had already attempted and abandoned on collision) toward "something
  else" — re-verifying file-content storage (Known Failure Signature
  #4) surfaced a live crash distinct from that KFS: `err instanceof
  store.ProjectSizeLimitError`/`AccountSizeLimitError` in
  `files.js`/`projects.js`, neither class existing on live `store.js`,
  crashing the whole process (not a 500 — confirmed via server log,
  the entire Node process exited) on any file-write error. Fixed with
  the same generic `err.statusCode` pattern `app.js`'s own handler had
  already been reconciled to (see Known Failure Signature #10).
  Verified live: reproduced the crash, applied the fix, confirmed the
  same request now returns cleanly and the server stays up. Also filed
  (not fixed — Session 2's file, mid-migration) an observation in
  `IDEAS.md`: a Turso connection with unreachable/placeholder
  credentials appeared to hang rather than fail fast, though only
  tested against a sandbox with no real path to `*.turso.io` at all, so
  flagged as "worth checking against a real instance," not confirmed.

### Session 5 — Testing, docs, and integration *(historical — lane retired)*
**Status: shipped, lane closed.** Full route smoke test
(`SESSION5_TEST_REPORT.md`), conflict-detection end-to-end verification,
confirmed the AI→approve permission boundary genuinely 404s rather than
403s. Two low-priority findings logged (README gap, non-encoded traversal
not logged — both expected behavior, not bugs). This work is real and
kept as historical record; going forward, verification is Rule 6, binding
on all sessions, not a dedicated fifth lane — see this file's own
restructure note at the top.

---

## Definition of done for the whole project

`npm install && npm start` on a bare Termux install produces a working PWA
that a human can install to their home screen, create a project in, copy
an AI token from, and have all four lanes' worth of functionality work
against that token — with zero native compilation and zero cloud
dependency for local use. For the public Vercel path specifically:
file content storage now genuinely works (Known Failure Signature #4
resolved — see the correction note near the top of this file for the
live-verification evidence). The one remaining gap is real
authentication on human-facing routes (the open question in
`SECURITY.md` actually decided and built, not just documented).

---

## Maintaining this file

Update this file when:

- A new route is added or a route's contract changes — update the file
  tree status table and, if it changes a Non-Negotiable Rule, that section
  too.
- A lane's scope changes, a lane ships, or (as happened this session) a
  lane is retired — update both Lane Assignments and add a Session Ledger
  entry. Don't let a "Status" line go stale; a session starting cold
  trusts it.
- A bug class shows up a second time — add it to Known Failure Signatures
  (or note the second occurrence against the existing row, as Known
  Failure Signature #3 does). If it shows up a third time, that's a sign
  it needs to become a Non-Negotiable Rule, not just a table row.
- A session finds something that blocks another session's in-progress
  work — flag it high-visibility in that session's Lane Assignment entry
  and the Session Ledger, the way Known Failure Signature #4 is flagged
  here, not just mentioned once in a commit message.
- Anything in `SECURITY.md` changes — this file's Current State summary
  of the open gap should stay a one-line pointer to that file, not a
  second copy that can drift out of sync with it.

Do not let this file silently drift out of sync with reality — an
instructions file that lies about the project's state is worse than no
instructions file. If in doubt, `git log` against the prior commit to
confirm exactly what actually changed before writing a ledger entry about
it.
