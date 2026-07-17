# Known issues

---

## Open

### Multi-device support: build it for real, or correct the comments claiming it exists
Found while fixing #16's ToS gate (see Session Ledger). `routes/device.js`'s
header comment says `aisapp_devices` "can hold more than one device's
identity" and that the delete-cascade was scoped to `listProjectIdsForDevice(code)`
specifically *because* of that. `store.js`'s actual `getDevice()` is
hardcoded single-row (`ORDER BY created_at ASC LIMIT 1`, no `WHERE`
clause tied to any request-specific identity at all) — there is only
ever one device, period, regardless of what called it or why. Every
other device.js/store.js function (`getOrCreateDeviceCode`,
`hasDeviceAcceptedTos`, the write-gate secret) inherits this same
single-row assumption, so the app today is single-device-per-deployment
in practice, whatever one comment claims motivated a change.

This is the exact KFS #6 pattern (comment describes capability code
doesn't have) for the 3rd time — see that row's own note in
`INSTRUCTIONS.md`. Not fixing either direction myself: correcting the
comment is cheap but doesn't resolve why someone wrote "can hold more
than one device's identity" in the first place (did an earlier version
of this file actually filter by something, and that got lost in a
rewrite the way KFS #7/#9 describe? or was this aspirational from the
start?) — and actually BUILDING real multi-device support (a per-
request device identity, e.g. a cookie or header, instead of "the one
row that exists") is a real architecture decision with security
implications (SECURITY.md §3b territory) that shouldn't happen as a
side effect of an unrelated ToS-gate fix. Flagging for a real decision
either way, per this file's own "nobody touches an idea's status but
the human" rule — this one's arguably bigger than a normal idea
(it's a proposed *rule*, not a feature), but the same non-self-approval
principle applies even more here, not less.
Size: investigation first (small), then either small (fix the comment)
or large (build real multi-device identity resolution) depending on
what that investigation finds.
— Session 4

---

## In progress

*(nothing yet)*

---

## Done

### generateDeviceCode missing from tokens.js — broke all project creation (FIXED)

**Was URGENT.** `POST /api/projects` and `POST /api/projects/:id/regenerate-token`
both failed everywhere (locally and on Vercel) with:

```
{"error":"Internal server error.","detail":"generateDeviceCode is not a function"}
```

**Root cause (as documented when found):** `backend/utils/tokens.js` had dropped
`generateDeviceCode` entirely — not just from `module.exports` but the function
body was gone. Callers in `routes/projects.js` and `routes/device.js` both
destructured it as `undefined`, then called it, throwing immediately.
`generateToken()` had also regressed to zero parameters, so even if
`generateDeviceCode` existed it wouldn't embed the device code into the token.

**Fix:** `generateDeviceCode` restored in `backend/utils/tokens.js` (commit
`3347647`). `generateToken(deviceCode)` likewise fixed to accept and embed the
device code, producing `aisapp_<12-char code>_<random>` tokens as designed.
This was a regression that occurred twice in the same session before the final
fix was reconciled with the composite-token scheme (see `tokens.js` own header
comment for the full history). Verified: project creation succeeds end-to-end.
— Session 3/4

### app.js error handler crashed on every error response (FIXED)

**Found while investigating the generateDeviceCode regression above.**
`backend/app.js`'s central error handler checked `err instanceof
store.ProjectSizeLimitError` and `err instanceof store.AccountSizeLimitError` —
at the time those classes didn't exist in `store.js`. `instanceof undefined`
throws `TypeError`, which was crashing **every error response** routed through
`app.js` (the Vercel entry point), regardless of the original error's cause.

**Fix:** Error handler replaced those specific class checks with `err.statusCode`
(generic — works for any typed error that sets one, including `ProjectSizeLimitError`
and `AccountSizeLimitError` once they were added to `store.js` in a later commit).
— Session 3/4

### humanSensitiveLimiter dropped from routes/projects.js four times (FIXED)

Rate limiting was genuinely wired into `routes/projects.js` at one point (commit
`1550e34`), but successive rewrites — each fixing a real, unrelated bug — worked
from a base that predated the rate-limiter addition and never carried it forward.

This happened four distinct times with four different things in one session:
1. Device-code embedding in tokens (twice)
2. `saveProject()`/`removeProjectDir()` calls
3. The `tokenHash`-stripping fix on `GET /api/projects`
4. `humanSensitiveLimiter` itself

All four share the same shape: a fix lands, a later legitimate rewrite works
from an older base and doesn't carry the fix forward, because the fix wasn't
that rewrite's concern. Not any one session doing something wrong — a property
of concurrent rewrites of one actively-central file with no automatic "diff is
missing something" detection. See IDEAS.md for a concrete proposal to prevent
a 5th occurrence.

**Fix:** `humanSensitiveLimiter` re-applied to the three destructive routes
(create, regenerate-token, delete) in `routes/projects.js`. Verified: 20
requests succeed, then `429`s begin as configured; read routes unaffected.
— Session 4

---

### 3rd occurrence of KFS #3: files.js's ToS check sat outside its handler's try/catch (FIXED) — crashed the whole process, not just a hang

Found during a general Session 3 bug-hunt (human asked to "find and
improve more bugs"), not while chasing a specific reported symptom --
the same way the tokenHash leak above was found while testing something
unrelated.

#### Symptom

`routes/files.js`'s `handleWriteFile` -- the handler behind every single
file write in the app, human or AI -- had this shape:

```js
async function handleWriteFile(req, res) {
  ...
  const accepted = await store.hasAcceptedTos(req.project.deviceCode);  // <-- unguarded
  if (!accepted) { return res.status(403)...; }

  const actorLabel = ...;

  try {
    const result = await writeFileContent(...);
    ...
  } catch (err) { ... }
}
```

The ToS-gate check runs an `await store.*` call -- a real network round
trip to Turso -- entirely outside the handler's own try/catch. Confirmed
live (well, against a real local Express server + a deliberately-throwing
mock of `store.hasAcceptedTos`, since this sandbox still can't reach
`*.turso.io` -- same disclosed limitation as every other entry in this
file): when that call throws, it's worse than a hang. It's an uncaught
promise rejection with no `next()` anywhere to catch it, and confirmed
directly that this **terminates the entire Node process** --

```
Error: simulated transient Turso failure
    at Object.hasAcceptedTos (.../store.js:37:15)
    at handleWriteFile (backend/routes/files.js:96:32)
    ...
Node.js v22.22.2
```

-- not a clean 500, not a per-request failure. One transient Turso
hiccup on one file write kills the whole server process, taking down
every other in-flight request on that instance too, not just the one
that hit the bad connection.

#### Cause

Exactly the KFS #3 / KFS #7 combination, third time now: the ToS gate
was added to an already-complete, already-correctly-try/catch'd handler
(see `git log` on this file -- the try/catch predates the ToS check).
Whoever added the check inserted it above the existing `try {` instead
of moving the `try` up to cover it, the same "insert into a handler that
already has error handling, but insert OUTSIDE that handling" shape KFS
#3's other two occurrences share. Every OTHER `await store.*` call in
this exact file (`handleReadFile`, `handleListTree`, `handleDeleteFile`,
and every other `await` inside `handleWriteFile` itself) is correctly
inside its handler's try block -- this was a single, localized gap, not
a file-wide pattern, which is exactly why it's easy to miss: three of
four handlers in the same file were already doing this right.

#### Fix

Moved the ToS check inside the existing try block (see `git log` on
`routes/files.js`, same commit as this entry). No behavior change for
either the 403 (ToS not accepted) or the 200 (success) paths --
confirmed via a real Express server bound to a real local port, hit
with real HTTP requests (Node 22's built-in `fetch`), mocking only
`store.js`/`fileOps.js`/the auth middleware:

- Thrown DB error: now responds `500` with the underlying error message
  in ~60ms, instead of crashing the process.
- `hasAcceptedTos` resolves `false`: still `403` +
  `requiresTosAcceptance: true`, unchanged.
- `hasAcceptedTos` resolves `true`: still `200` + `success: true` +
  the real `version` from `writeFileContent`, unchanged.

Verified the test itself was meaningful, not just passing by
construction: re-ran it against the pre-fix code via `git stash` and
confirmed it reproduces the exact process-crash shown above, then
restored the fix and confirmed clean.

#### Worth naming directly

This is the 3rd occurrence of Known Failure Signature #3 (see
`INSTRUCTIONS.md`), which -- per this file's own "Maintaining This
File" policy -- means it graduates from a table row to a full
Non-Negotiable Rule (new Rule 7). The specific lesson Rule 7 tries to
capture: auditing a handler's try/catch coverage ONCE, when it's first
written, isn't enough. The gap here was introduced by a *later*,
unrelated change (the ToS gate) that had no reason to think of itself
as "touching error handling" at all -- it was just adding a business
rule check, and the try/catch was already sitting right there a few
lines down, easy to assume it already covered everything above it too.

Logged by Session 3.
