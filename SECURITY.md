# SECURITY.md — Aisapp

This document was originally scoped to Session 4 (see `INSTRUCTIONS.md`'s
lane assignments) as: *"Write a short SECURITY.md documenting the trust
model as-is (no cloud auth, device-is-the-boundary) so future sessions
don't 'fix' it into a cloud auth system by mistake."*

That original framing has partially been overtaken by real events: this
app is now moving toward a public Vercel deployment (human-directed, not
a drift or a mistake), which changes some of what "as-is" means. This
document covers both: what the trust model always was, and what's
actually changed now that "local-only" is no longer the whole story.

---

## 1. The core trust model, as originally designed

**There is no cloud login.** No email/password, no OAuth, no session
cookies for the human. Two separate identities exist:

1. **The human**, using the browser UI. No token required at all —
   `/api/projects/...` and `/api/device` are open to anyone who can
   reach the server. The original assumption: only the device's owner,
   or someone physically on the same LAN, could reach it.
2. **An AI agent**, calling the API with `Authorization: Bearer
   <project-token>` against `/api/ai/:projectId/...`.

This was a deliberate choice, not an oversight (see `auth.js`'s own
header comment) — for a phone-hosted, LAN-only tool, the device itself
being the trust boundary is a reasonable design. **It stops being
reasonable the moment the server is reachable from the open internet**,
which is covered in §3 below.

## 2. What's actually enforced, and how (verified this session, not assumed)

- **Path traversal via `projectId`.** Fixed this session — see
  `db/store.js`'s header comment and the commit history for the full
  writeup. Confirmed via an isolated proof-of-concept that this
  previously allowed the `DELETE /api/projects/:projectId` route to
  recursively force-delete an arbitrary directory outside the intended
  `projects/` root, under specific conditions. Now closed: `projectDir()`
  verifies containment and throws rather than silently stripping `../`.
- **The Function Assignment Gate.** Genuinely structural, not a
  permission check that could be bypassed — there is no route on
  `aiRouter` in `instructions.js` capable of approving an assignment.
  An AI-authenticated request to the approve endpoint gets `404 Not
  Found`, not `403 Forbidden`, because the route doesn't exist on that
  side at all. Verified live this session (and independently by
  Session 5 earlier — see `INSTRUCTIONS.md`'s Session Ledger).
- **Token comparison is constant-time throughout.** `tokens.js`'s
  `verifyToken()` hashes first (SHA-256), then compares digests with
  `crypto.timingSafeEqual`. Confirmed via `grep` across the whole
  backend that no other file compares a token with `===` or any other
  non-constant-time method.
- **Device identity (12-char permanent code).** Added this session —
  see `db/store.js` and `utils/tokens.js`. One permanent code per
  device, embedded as a fixed prefix in every project's token, never
  regenerated except via explicit, confirmed deletion
  (`DELETE /api/device`, requires `{ "confirm": true }` in the body —
  a bare call is rejected). Deleting the device cascades to deleting
  every project under it, since their tokens embed a code that no
  longer exists anywhere and would be unauthenticatable regardless.
- **Rate limiting.** Added this session — see §4 below for the
  detailed breakdown; the short version is that it exists now, is
  tiered to this app's actual traffic shape rather than generic web
  defaults, and was verified live (not just configured) against real
  request bursts for every tier.

## 3. What changed: this app is moving toward public reachability

The human has confirmed this app is being deployed on Vercel and will
be made public later (currently LAN-only in practice, but the direction
is set). This is a real shift in the threat model, not a hypothetical
one, and a few things follow from it directly:

### 3a. `0.0.0.0` binding is the actual mechanism

`server.js` binds to `0.0.0.0`, not `127.0.0.1` — intentional, so
other devices on the same LAN can reach it (see that file's own
comment). This was flagged in Session 4's original scope as something
to "sanity-check... no accidental `0.0.0.0` exposure beyond intent."
It's not accidental — but it IS the exact mechanism by which "reachable
on my LAN" becomes "reachable from anywhere" the instant this runs
somewhere with a public IP and no firewall/NAT in front of it, which is
close to the default posture of a Vercel-style deployment. This isn't
something to "fix" by rebinding — a serverless deployment needs to
accept external connections to work at all — it's something to be
clear-eyed about: **the human-facing routes have no authentication,
and once this is public, "no authentication" means exactly that, for
anyone.**

### 3b. Unauthenticated human routes — CLOSED (this session), with an honest verification caveat

**Update:** the gap described below is now closed. `middleware/auth.js`'s
`requireDeviceSecret` gates every human-facing WRITE route (create/
delete a project, delete-cascade the device, regenerate a token) behind
a per-device secret — exactly the design flagged as needed. Read routes
remain open by design (browsing your own data shouldn't need
re-authenticating). The original problem description is left below,
unedited, since it's still the right explanation of *why* this existed
and *why* rate limiting alone was never enough.

**Design, briefly:** a secret is created lazily on first write attempt
(not at boot — see `requireDeviceSecret`'s own comment for why a hard
boot-time requirement would permanently break the Vercel path, which
has no equivalent "boot moment" a human would see). The first caller
without a valid secret gets it back directly in the `401` response body
— on a fresh install, that's virtually certainly the human themselves,
setting the app up for the first time. Every subsequent wrong or
missing secret gets a generic rejection with nothing leaked. Deliberately
**not** the same value as the device code embedded in AI tokens — reusing
that would mean any AI agent with a valid project token could trivially
derive the credential meant to gate the human's own destructive actions.

**Verification status — read this before trusting it blindly:** the
middleware's own control-flow logic (lazy creation, correct-secret
retry succeeding, wrong-secret/missing-header rejection, no secret
leaked on failure) was tested directly and passed on every case — but
via an isolated test with a mocked `store` module, not a live request
against a real Turso database, because this sandbox cannot reach
`*.turso.io` (same disclosed limitation `store.js`'s own header has
carried all session). The underlying `store.getDevice()`/
`getOrCreateDeviceSecretHash()` calls this middleware depends on were
separately verified against a real local Turso-compatible engine
(`@tursodatabase/database`, used for local testing only, not a runtime
dependency) for the schema/SQL correctness — but the two were never
proven together, end-to-end, against one real live connection. The
first real end-to-end proof will happen at actual deploy time. Flagging
this plainly rather than overstating confidence, same discipline this
document has tried to hold throughout.

**Original problem description, unedited:**

Every route under `/api/projects/...` and `/api/device` — create a
project, delete a project, delete-and-cascade the entire device
identity, regenerate a token (invalidating whatever agent was using
it) — requires no token at all. Locally, "no token" was fine because
reaching the server at all implied you were the owner or someone they
trusted on their LAN. Publicly, "no token" means anyone who finds the
URL can do all of the above to a stranger's data.

**Rate limiting (§4) does not close this gap. It only slows it down.**
An unauthenticated attacker with no rate limit could nuke every project
instantly; with rate limiting, they can still do it, just over a few
minutes instead of a few seconds. This is a real mitigation (worth
having regardless), not a fix for the underlying issue.

**Closing this gap for real needs actual authentication on the human
routes** — something like a per-device secret set on first run, checked
on every human-facing write, not just the AI ones. That is a
genuinely bigger architectural decision than anything in this
document's scope, and it has NOT been made or built as part of this
session's work. Flagging it here explicitly, in the document whose
whole purpose is "so future sessions don't drift into something by
mistake" — this is the opposite: a real, known gap that a future
session (or the human) needs to decide how to close, with eyes open,
before this is actually public.

### 3c. Storage is also mid-migration, for the same underlying reason

The original JSON-file datastore (`db/store.js`) assumes a persistent
local filesystem, which a stateless Vercel function does not have.
Session 2 owns migrating this to Turso (Turso chosen over Supabase per
human decision — see `INSTRUCTIONS.md`'s migration notes for the full
reasoning). Two files exist in this repo as REFERENCE-ONLY groundwork
from an earlier point in this same session, before that ownership was
confirmed:

- `backend/db/schema.sql` — a relational schema derived directly from
  the current JSON shapes. Loaded and exercised against a real SQLite
  engine (Node 22's built-in `node:sqlite`) — composite keys, foreign
  key cascade deletes, and unique constraints all confirmed working
  correctly.
- `backend/db/store.turso.js` — a drop-in-shaped replacement for
  `store.js` using `@tursodatabase/serverless` (chosen over
  `@libsql/client` specifically because the latter pulls in
  platform-specific native binaries — confirmed present in
  `node_modules` during testing — which conflicts with this repo's own
  "no native deps" rule; `@tursodatabase/serverless` is Turso's own
  recommended package for exactly this app's situation and has zero
  native dependencies, confirmed the same way).

**Neither file has been live-tested against a real Turso database.**
The sandbox this was written in has no network egress to `*.turso.io`
(confirmed: a direct connection attempt failed with "Host not in
allowlist," a sandbox limitation, not a credentials problem). These
files are believed correct based on the schema validation above and
Turso's documented API, not proven end-to-end. Session 2 should treat
these as a starting reference, verify the actual connection
independently, and is free to diverge from this shape if a better one
emerges — this was written before ownership was clear, not as a
finished handoff.

## 4. Rate limiting (added this session)

Three tiers plus a global backstop, in `backend/middleware/rateLimit.js`.
Full design reasoning lives in that file's header comment; summary:

| Tier | Keyed by | Runs | Limit | Purpose |
|---|---|---|---|---|
| Global backstop | IP | Before everything | 600/min | Pure "don't crash" safety net against any runaway loop, buggy or malicious |
| `aiSurfaceLimiter` | IP | Before `requireAIToken` on every AI route | 1000/min | Catches token brute-forcing across many projects/tokens — the one thing a project-keyed limiter structurally cannot catch, since an invalid token has no project to key by |
| `aiWorkLimiter` | Project (`req.project.id`) | After `requireAIToken` | 300/min | The real per-project ceiling, tuned to accommodate legitimate agent bursts (reading a whole file tree, polling roster/activity) without a single active project starving others sharing the server |
| `humanSensitiveLimiter` | IP | On specific destructive/sensitive human routes only (create project, delete project, delete-device-cascade, regenerate token) — NOT the whole human surface | 20/min | A human browsing their own project list should never see a 429; this only targets the routes with real cost per abused call |

**A real bug found and fixed during this session's own testing, worth
knowing about:** `aiSurfaceLimiter` and `aiWorkLimiter` run on the same
request path in sequence — they stack, they are not alternatives. The
surface limiter was originally set to 100/min ("generous, just needs
to stop hammering"), which turned out to silently cap ALL AI traffic
at 100/min regardless of `aiWorkLimiter`'s intended 300/min allowance,
because for the realistic common case (one agent, one project, one
IP), the *lower* of two stacked limits always wins. Caught via live
testing (a single legitimate project, valid token, 150 requests —
expected all to succeed, only 100 did), not by inspection. Fixed by
raising `aiSurfaceLimiter` well above `aiWorkLimiter`'s ceiling, so it
only ever engages for genuine cross-project hammering. Re-verified
after the fix: 300 requests from one valid token now succeed before
`429`s begin, matching the intended design.

**Known limitation, not yet solved:** the in-memory store
(`express-rate-limit`'s default) does not aggregate across multiple
concurrent server processes. Fine for one long-running Node process
(Termux, a single VPS); NOT correct once this runs as multiple,
possibly-concurrent Vercel function invocations, where each cold start
can be its own process with its own memory. A real fix needs a shared
store (Redis, or a Turso table once Session 2's migration lands) keyed
the same way these limiters already are. Not addressed here — flagged
as a natural follow-up once storage is centralized, not before.

## 4a. Rate limiting was lost during the Turso migration, and restored — plus a bigger finding surfaced while doing that

Session 2's Turso migration (async conversion across every route file,
new `store.js`, `app.js`/`server.js`/`api/index.js` split for Vercel)
unintentionally dropped every `.use(aiWorkLimiter)` /
`.use(humanSensitiveLimiter)` / `globalBackstopLimiter` /
`aiSurfaceLimiter` wiring except the one that happened to live inside
`device.js` (which, see below, turned out to be broken for an
unrelated, bigger reason). `middleware/rateLimit.js` itself was never
touched — the tier logic and limits are exactly as designed and
previously verified — only the `.use()` calls wiring it into the new
async route files and the new `app.js` were lost, almost certainly a
casualty of a large mechanical rewrite rather than anything deliberate.
Re-wired into `sessions.js`, `files.js`, `instructions.js`,
`activity.js` (all `aiWorkLimiter`), `projects.js`
(`humanSensitiveLimiter` on the three destructive routes), and `app.js`
(`globalBackstopLimiter` + `aiSurfaceLimiter`).

**Re-verified live** — not just re-wired and trusted — by booting the
app with a placeholder (non-functional) Turso URL/token and confirming
rate limiting genuinely engages independent of real database
connectivity: a single request correctly fails with `500` (proving it
reached real route logic, not a dead route), and a burst of requests
is correctly cut off by the appropriate limiter tier (`429`) before the
remainder even reach the DB-dependent code. This confirms the limiters
are positioned correctly in the middleware chain — before, not
alongside, the parts of the app that need a real Turso connection to
function — which was the property worth actually testing, since the
live Turso path itself remains unverifiable from this sandbox (§3c).

**A bigger, more urgent finding surfaced while investigating why only
`device.js` still had rate limiting wired in:** `device.js` (the whole
device-identity feature — permanent 12-char code embedded in every
project token, `DELETE /api/device` cascade-delete, everything in
§2's "Device identity" bullet above) calls `store.getDevice()`,
`store.saveDevice()`, `store.deleteDevice()`, `store.projectDir()`, and
`store.clearProjectIndex()` — **none of which exist on the new
Turso-backed `store.js`** (confirmed directly: `Object.keys(store)`
lists 20 exports, none of the five above among them). `schema.sql` has
no trace of a device table or device-related column anywhere either.
`tokens.js` has been reverted to its pre-device-code form —
`generateToken()` takes no arguments and produces a token with no
embedded permanent-code prefix at all, exactly matching what it looked
like before that feature was ever built. `projects.js`'s creation route
calls `generateToken()` with zero arguments, consistent with that
reversion, not a mismatched leftover call.

This reads like an earlier version of these specific files (predating
the device-identity work) was used as the base for part of the Turso
rewrite, rather than a deliberate decision to drop the feature — there
is no comment or note anywhere in the new schema or store explaining a
choice to remove it, which is inconsistent with how carefully
documented the rest of this migration is (the honest network-
verification caveat, the real `ON DELETE CASCADE` reliability bug that
WAS caught and explained). Every route in `device.js` will throw the
instant it's invoked — this isn't conditional on live Turso
connectivity; calling `undefined()` fails regardless of what's on the
other end of the network.

**Not fixed here.** Restoring this means adding a device table (or
equivalent columns) back to `schema.sql` and the corresponding
functions back to `store.js` — both files Session 2 owns and has been
deliberate about (the size-cap trigger design, the `ON DELETE CASCADE`
reliability fix). Reconstructing that unilaterally, on top of someone
else's actively-evolving schema, without their input on how they'd
want it to fit alongside the size-cap/trigger design they already
built, risks a worse outcome than flagging it clearly and letting
Session 2 (or whoever picks this up) decide how it should actually fit
back in. `device.js` is deliberately left UNMOUNTED in `app.js` (no
`app.use('/api/device', ...)` line was added back) rather than wired up
broken — better for it to be visibly absent than silently 500ing on
every call once this is live.

**Update (Session 2):** this gap is now closed. Verified live, directly
against the current files, not assumed from this section's own claim:
`store.js` currently exports `getDevice`, `saveDevice`, `deleteDevice`,
`getOrCreateDeviceCode`, `getOrCreateDeviceSecretHash`, and
`setDeviceSecretHash` (confirmed via `module.exports` directly), and
`app.js` has `app.use('/api/device', deviceRoutes)` wired in. That
specific claim -- device identity is wired up, not unmounted -- holds.

**CORRECTION (Session 2, same session, caught while investigating
`KNOWN_ISSUES.md`'s multi-device entry):** the paragraph that used to
sit here also repeated `device.js`'s own header comment verbatim --
that `aisapp_devices` "can hold more than one device's identity" and
that the delete-cascade is now correctly scoped because of it. I
wrote that down as verified fact without checking `store.js`'s actual
`getDevice()` against it, which is precisely the mistake this
document exists to catch. Checked now: `getDevice()` takes zero
parameters and runs `... ORDER BY created_at ASC LIMIT 1` with no
`WHERE` clause tied to any request-specific identity at all -- there
is no mechanism anywhere in this codebase for the server to resolve a
DIFFERENT device than "the single oldest row" for any given request.
`listProjectIdsForDevice(device.code)` in the delete-device handler
does correctly filter to that one device's own projects rather than
literally every project in the table (a real improvement over an
unscoped delete) -- but since `getDevice()` can only ever resolve to
one possible device, that scoping makes no actual behavioral
difference today: every project in the database was necessarily
created by "the one device," so the scoped query and an unscoped one
return the same result set in practice. This is exactly
`KNOWN_ISSUES.md`'s open "Multi-device support: build it for real, or
correct the comments" entry, already correctly diagnosed there in
more depth than I'd given it here -- not re-litigating or resolving
it myself; that entry already flags it as needing a real human
decision (architecture + security implications), not a side-effect
fix. Retracting my own repetition of the comment's claim rather than
leaving it uncorrected: the mounting/exports fix above is real and
verified; the "multi-device" framing around it was not.

## 5. Things explicitly out of scope for this document / this session

- **Real authentication on human-facing routes** (§3b). Known gap,
  not built. Needs a deliberate design decision, not a quick patch.
- **A shared rate-limit store for multi-instance deployment** (§4,
  known limitation). Natural follow-up to the Turso migration.
- **The device-to-device identity transfer link** the human requested
  earlier in this session (retrieve your permanent 12-char code on a
  second device). Not built — Session 4's actual security/rate-limiting
  work took priority this pass; this remains open.
- **File *content* storage on serverless** (§3c) — `files/` still
  assumes a local filesystem even in the Turso-groundwork files above;
  Vercel's ephemeral filesystem means this needs its own answer (blob
  store, or a `files` table in Turso too), not decided here.
- ~~Restoring device identity to the new Turso schema~~ (§4a) — done,
  see that section's Update note. No longer open.

## 6. For future sessions: the original warning still applies

The device-is-the-boundary model was a reasonable, deliberate design
for a local tool. It is now being deliberately extended, not replaced
wholesale — but "deliberately extended" only stays true if the real
gaps above (§3b especially) get closed with real decisions, not
silently patched over piece by piece until the original model's
guarantees no longer actually hold anywhere. If you're a future
session reading this: the honest state is "local-first design, now
adding rate limiting and a storage migration, with a known and
explicitly-flagged authentication gap on human routes that going
public does not fix by itself." Don't assume that gap has been closed
just because other hardening has happened around it.
