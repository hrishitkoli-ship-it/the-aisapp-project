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
