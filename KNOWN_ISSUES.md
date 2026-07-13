# URGENT: project creation is currently broken everywhere (main branch)

Not a Vercel-specific issue, not an edge case — this breaks
`POST /api/projects` and `POST /api/projects/:id/regenerate-token`
**locally too**, on a completely normal writable filesystem, via both
`backend/server.js` and `backend/app.js`. Found while verifying an
unrelated storage-hardening fix (see Session 3's Session Ledger entry)
— confirmed unrelated to and not caused by that fix.

## Symptom

```
$ curl -X POST http://localhost:7077/api/projects \
    -H "Content-Type: application/json" -d '{"name":"test"}'
{"error":"Internal server error.","detail":"generateDeviceCode is not a function"}
```

Every project creation and every token regeneration fails.

## Cause

`backend/utils/tokens.js` no longer defines or exports
`generateDeviceCode` at all — not missing from `module.exports`, the
function itself isn't in the file:

```js
module.exports = { generateToken, hashToken, verifyToken, TOKEN_PREFIX };
```

But `backend/routes/projects.js` (twice) and `backend/routes/device.js`
both still do:

```js
const { generateDeviceCode } = require('../utils/tokens');
```

— destructuring `undefined`, then calling it as a function inside
`store.js`'s `getOrCreateDeviceCode`, which throws.

**Related, same root cause:** `tokens.js`'s current `generateToken()`
also takes zero parameters and doesn't embed a device code at all —
but callers still call it as `generateToken(deviceCode)`, and
`routes/device.js`'s own header comment describes the intended design
as *"the permanent 12-char code embedded as a fixed prefix in every
project token."* Confirmed this used to actually work: earlier in this
same session, two tokens generated for the same simulated device both
started `aihub_0cHM05Xq6AZB...` — a shared 12-char prefix. That
behavior is gone from the current file.

This has the shape of a device-identity refactor that's mid-flight —
`routes/device.js` is new, clearly built around a device-code concept,
and its own header comment explicitly describes hitting *this exact
class* of bug during its own testing ("a typo calling a non-existent
store function took the whole process down"). `tokens.js` looks like
it lost the generation logic partway through that same refactor,
without every caller being updated to match yet.

## Why I didn't just reconstruct it

I don't have the intended design here — was device-code generation
meant to move somewhere else entirely as part of the Turso work
(device identity likely matters for Turso's account/row-scoping), or
is this simply an accidental drop that needs restoring as-is? Guessing
either way risks conflicting with whatever's actually in progress.
Flagging with full diagnostic detail instead of reconstructing it.

## What's confirmed NOT related

Verified via a test-only stub (never touched the shipped file) that
this is fully independent from everything else in this session's
work: the storage-hardening fix (`StorageReadOnlyError`, in both
`server.js`'s and `app.js`'s error handlers) and a separate
`instanceof undefined` crash fix in `app.js`'s error handler (see
below) both work correctly once this bug is bridged around for
testing purposes.

---

## Also fixed in app.js's error handler while investigating the above

Separate, smaller finding, fixed directly (safe, additive, no design
guessing required): `backend/app.js`'s central error handler checked
`err instanceof store.ProjectSizeLimitError` and
`err instanceof store.AccountSizeLimitError` — neither class exists
anywhere in `store.js` yet (presumably landing with more Turso work).
`instanceof undefined` throws `TypeError: Right-hand side of
'instanceof' is not an object`, which was crashing **every single
error response** routed through `app.js` (the file Vercel's
`api/index.js` actually uses), regardless of the error's real cause —
including a plain validation error. Guarded both checks with
`store.X && err instanceof store.X` so they safely no-op until those
classes exist, and will correctly start working the moment they're
added with those exact names — no further changes needed here then.

Logged by Session 3, while covering Session 5's testing/integration
scope.

---

# Known issue: SPA fallback 500s until frontend/index.html exists

Found while verifying Session 3 (Project Management UI) end-to-end against
a live local server.

## Symptom

Any request that doesn't match a static file or an `/api/...` route
currently returns `500 Internal server error` instead of a clean `404`.

```
$ curl http://localhost:7077/manifest.json
{"error":"Internal server error.","detail":"ENOENT: no such file or directory,
stat '.../frontend/index.html'"}
```

## Cause

`backend/server.js`'s SPA fallback:

```js
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});
```

`express.static` correctly tries the real file first, finds nothing, and
falls through to this catch-all. The catch-all unconditionally calls
`sendFile` on `frontend/index.html` — which doesn't exist yet, so
`sendFile` throws `ENOENT`, and the generic error handler turns that into
a `500`.

## Why this isn't a Session 3 fix

This is `backend/server.js`, shared/foundational territory per
INSTRUCTIONS.md, not the Project Management UI lane. It's also almost
certainly **self-resolving**: once `frontend/index.html` exists (Session 1's
deliverable), `sendFile` succeeds and this stops happening entirely — the
route doesn't need to change, the missing file just needs to land.

## Flagging in case it's still live once index.html exists

If this is still reproducible *after* `frontend/index.html` is in place —
e.g. genuinely non-existent paths like `/foo/bar/nonsense` return `200`
with the SPA shell instead of a `404` — that's expected SPA-routing
behavior and not a bug (client-side router owns those paths). But if any
matched-but-truly-broken path still 500s instead of the app shell loading,
that's worth a second look then. Re-verify with the app actually running
before touching this route.

Logged by Session 3 while testing the Project Management UI lifecycle.

---

# Regression: tokenHash leak on GET /api/projects came back after an unrelated rewrite fixed it once already

Not a new bug in the sense of "never fixed" — this exact issue was
found and fixed once earlier in this same session (Session 4), then
came back when `routes/projects.js` was independently rewritten by
someone fixing a different, more severe bug (project creation not
writing `project.json` — see the `generateDeviceCode` entry above for
the related device-code regression in the same file). The rewrite
worked from a base that predated the first `tokenHash` fix, so it
wasn't carried forward — nobody removed it on purpose, the fix just
wasn't visible from anywhere except the diff of a commit the rewrite
didn't build on top of.

## Symptom

```
$ curl http://localhost:7077/api/projects
[{"id":"...","name":"...","tokenHash":"2f9aef1e...","createdAt":"..."}]
```

Every project's `tokenHash` returned in the clear, to any
unauthenticated caller.

## Cause

`GET /api/projects`'s handler did `res.json(index)` directly on
whatever `store.listProjects()` returns. On the current fs-based
`store.js`, that's the exact object `addProjectToIndex()` was given —
the full project shape, `tokenHash` included — not a filtered list-view
shape. Three sibling routes in the same file (`GET /:id`,
regenerate-token, and implicitly delete) already correctly filter their
response through this file's own `stripSecret()` helper. This route
just didn't.

## Fix

Re-applied: `res.json(index.map(stripSecret))`. Verified live a second
time: a real response with real project data confirmed `tokenHash`
absent, every other field (`id`/`name`/`description`/`deviceCode`/
`createdAt`/`tokenGeneratedAt`) present and correct.

## Why this is worth a KNOWN_ISSUES.md entry, not just a silent re-fix

A fix that only exists as a line in a git diff is fragile in a
multi-session, actively-churning file like this one — exactly what
happened here. Logging it here, not just in a commit message, is meant
to make the fix durable: if `routes/projects.js` gets rewritten again
(plausible — it's been substantially rewritten at least twice already
this session for unrelated reasons), whoever does it can grep
`KNOWN_ISSUES.md` for "projects.js" or "tokenHash" and see this is a
known, easy-to-drop fix, not just infer it from reading the current
code's shape.

Logged by Session 4.

---

# 4th regression from the same file this session: humanSensitiveLimiter silently lost from routes/projects.js

Found during a full end-to-end regression pass across every fix this
session had made, run specifically *because* the `tokenHash` leak had
already come back once (see the entry above) — not something newly
suspected, a deliberate re-check after already being burned once.

## Symptom

Firing 22 rapid `POST /api/projects` requests all succeeded (`201`) —
no `429` anywhere. The rate limiter that should cap this at ~20/min
(`humanSensitiveLimiter`, applied to create/regenerate-token/delete
specifically, per `middleware/rateLimit.js`) wasn't engaging at all.

## Cause

Same root cause, 4th occurrence this session, all in
`routes/projects.js`: `git log` confirms `humanSensitiveLimiter` was
genuinely wired into this file at one point (commit `1550e34`), but a
later Turso-migration rewrite (`f87ac7d`, "async conversion") — and
every commit since, fixing separate real bugs (device-code embedding,
`project.json`, the `tokenHash` leak twice) — never carried it
forward. Nobody removed it on purpose; each rewrite simply worked from
whatever base it branched from, and rate limiting wasn't part of any
of those rewrites' own stated purpose, so there was no reason for
whoever wrote them to notice it was missing.

## Fix

Re-applied: `humanSensitiveLimiter` imported and added as route-level
middleware on the three destructive routes (create, regenerate-token,
delete) — not the read routes, matching the original design (a human
browsing their own project list shouldn't ever see a `429`). Verified
live: 20 requests succeed, then `429`s begin, exactly matching the
configured ceiling; normal reads (`GET /api/projects`) unaffected.

## Worth naming directly: this file has now lost 4 distinct things in one session

1. Device-code embedding in tokens (twice — see `generateDeviceCode`
   entry above)
2. `saveProject()`/`removeProjectDir()` calls (same entry)
3. The `tokenHash`-stripping fix on `GET /api/projects` (see that
   entry above — lost once, re-fixed, this is not that same
   occurrence)
4. `humanSensitiveLimiter` (this entry)

All four share the identical shape: a real fix lands, a later
legitimate rewrite (fixing a *different*, real bug) works from a base
that predates the fix, and the fix quietly doesn't make it into the
new version because it was never that rewrite's concern in the first
place. This isn't any one session doing something wrong — every
individual rewrite was itself fixing something real and doing it
correctly. It's a property of how concurrent, independent rewrites of
one actively-central file behave by default, with no mechanism in
place to catch "this diff is missing something an earlier diff added"
automatically.

Flagging this as a pattern, not just fixing the symptom a fourth time,
because a 5th occurrence seems likely without something changing about
*how* this file gets modified — see the new idea in `IDEAS.md`
("A lightweight check that catches when a route handler drops a call
or middleware an earlier version had") for a concrete, scoped proposal
rather than just a general worry.

Logged by Session 4.


