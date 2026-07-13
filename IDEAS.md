# IDEAS.md — Proposals from AI sessions

Not part of the app. Not read by the backend, not linked from the
frontend, no route touches this file. It's just a place for whichever
AI session is working on this repo to drop an idea that's outside its
own lane, without derailing into building it unasked.

## How this works

- Any session can add an idea. Put it under **Open** in the format below.
- **Nobody touches an idea's status but the human.** Sessions don't
  self-approve, don't mark their own idea "approved," and don't act on
  an idea that isn't marked approved yet — this mirrors the actual
  Function Assignment Gate in the app (`instructions.js` /
  `routes/instructions.js`), just outside the app instead of inside it.
- To approve: write `**APPROVED**` right after the idea's title line.
  To reject: write `**REJECTED**` (a reason is helpful but not required).
  Anything without one of those tags is still pending — treat it as
  "not yours to build" until it says otherwise.
- Once an idea is approved and a session picks it up, move it to
  **In progress**, and once shipped, move it to **Done** with a link
  to what landed (commit message, filename, or a line in the Session
  Ledger in `INSTRUCTIONS.md`).
- Keep each entry short: what, why, rough size. This is a pitch, not a
  spec — the spec happens in `INSTRUCTIONS.md`/`instructions.js` once
  it's actually approved and assigned.
- Sign each idea with which session added it (e.g. `— Session 2`) so
  it's traceable, same convention as `createdBy` in the app's own
  functionalities list.

---

## Open

### Audit other route files for the same missing-try/catch pattern
`routes/projects.js` had at least one async handler (`POST /`, create
project) with no try/catch at all around its body — a thrown/rejected
error there wouldn't reach Express's error-handling middleware (Express
4 doesn't auto-route rejected promises from route handlers to `next`),
so it'd hang or surface as an opaque error instead of a clean response.
Fixed in that file specifically while working on Vercel-readiness (see
Session Ledger), but `sessions.js`, `instructions.js`, `device.js`,
`files.js` all have multiple `async (req, res) => {...}` handlers too,
and I didn't audit whether they have the same gap — didn't want to
touch files that might be actively being edited by another session.
Worth a pass: grep for `async (req, res)` per file, check each has a
try/catch reaching `next(err)` (or an equivalent explicit catch).
Size: small-medium (mechanical once you know the pattern, but touches
every route file).
— Session 3

### Remove the storage-read-only stopgap once real persistent storage lands
`backend/db/store.js` currently catches read-only-filesystem write
failures (the situation on Vercel today) and returns a clean 503
instead of a raw error — see `StorageReadOnlyError` and
`isReadOnlyStorageError()`. This is explicitly a stopgap: it makes the
*failure* honest, it doesn't add persistence. Once real storage
(Turso, per the human's direction to Session 2) is wired in, writes
should actually succeed on Vercel and this code path should stop
triggering in practice — at that point it's worth a quick check that
it's not masking something, and either removing it or leaving it as
a genuine last-resort safety net, whichever fits how the Turso
integration ends up structured.
Size: small (mostly a "check and decide," not new code).
— Session 3

### Export the activity log as CSV
A "download" button on the activity feed that dumps the current
`GET /activity` response as CSV. Small — could live entirely in
`activity.js` client-side (no new backend route needed, just
`Array → CSV string → Blob → <a download>`). Useful once a project's
been running a while and the human wants to skim history off-device.
Size: small (~1-2 hrs).
— Session 2

### Session "last seen" push instead of poll-only
Right now `roster.js` polls every 15s. An AI session that just
registered or PATCHed itself could fire a lightweight
`CustomEvent`-style nudge if the roster page happens to be open in the
same browser context (unlikely on mobile, but relevant if the human
ever runs this on desktop across tabs) — low priority, just noting it
since the polling code already has clean start/stop hooks
(`mount()`/`destroy()` in `activity.js`, same pattern in `roster.js`)
if someone wants to extend it later. Honestly might not be worth the
complexity for a single-device tool — flagging more as "did we
consider this" than "we should do this."
Size: small, but low value — read the reasoning before picking this up.
— Session 2

### Task queue: let a human clear/dismiss a stuck request
If an AI session dies mid-task, its `taskQueue` entries stay `pending`
forever — nothing currently marks them `dismissed`. `roster.js` is
read-only by design (matches the backend having no human write route
for sessions), so this would need a new backend route first, which
is a bigger call than a frontend session should make unilaterally.
Flagging as an idea rather than building it, since it touches the
"structural, not just UI" permission model Session 4 was strict about.
Size: medium (new route + auth-boundary decision, not just UI).
— Session 2

### A lightweight "does this route match what store.js actually returns" check, run in CI or pre-commit
This session hit the same root cause three separate times in one file
(`routes/projects.js`): code written against a comment's description of
`store.js` rather than `store.js` itself, twice for Turso-schema
assumptions (KFS #4, #6) and once for a silently-dropped call after a
rewrite (KFS #7, #9). All three were only caught by actually running
the real server and hitting the real endpoint — nothing in the code
itself would fail a lint or a type check, since JS doesn't statically
verify that a comment's claims match reality. A small script (even
just: import every `routes/*.js` file, extract every `store.<name>`
call via regex, confirm `<name>` exists on the real `store.js` export
object) wouldn't catch a *behavioral* mismatch, but would catch the
"calling a function that doesn't exist" flavor of this bug (which is
most of what actually happened) before it needs a live server to
surface. Wouldn't have caught the `tokenHash` leak (that's a shape
mismatch, not a missing-function one) but would've caught the
`generateDeviceCode`-undefined crash and the `store.run()` calls in
`fileOps.js` instantly, for free, on every commit.
Size: small (a few hours for a rough version; could grow into a real
pre-commit hook later if it proves useful).
— Session 4

### A lightweight check that catches when a route handler drops a call or middleware an earlier version had
The idea above explicitly flags what it *doesn't* catch: "wouldn't
have caught the `tokenHash` leak (that's a shape mismatch, not a
missing-function one)." This is the complementary idea for that gap,
prompted by `routes/projects.js` losing four separate things across
this session alone (see `KNOWN_ISSUES.md`'s "4th regression" entry for
the full list) — device-code embedding, two `store.*` calls, a
secret-stripping fix, and a rate-limit middleware application, each
lost when a later, legitimate rewrite worked from a base that predated
it. None of those four were "calling something that doesn't exist" —
they were "this diff has fewer calls/middleware applications than the
previous commit touching this route did," which a function-existence
check can't see at all.

Rough shape: for any route file, diff the current commit's route
handler bodies against the last commit that touched the *same named
route* (not the whole file — a file can have unrelated routes changing
independently) and flag when the new version calls *fewer* distinct
`store.*`/`middleware.*` functions than the old one did, for a human
(or the next session) to glance at and confirm "yes, that removal was
intentional" before it merges. Deliberately not asking it to be smart
about *which* removals are fine — false positives here are cheap (a
one-line "yep, intentional, that's fine" from whoever's reviewing),
false negatives are what actually cost time (a fix silently
vanishing, discovered days later via a live symptom instead of at
commit time). Could start as a manual `npm run check-route-diffs`
script rather than a blocking CI gate, given how actively multiple
sessions are rewriting the same files right now — a hard gate might
create more friction than the problem currently costs, but a fast
"here's what changed call-count-wise" summary seems useful even
opt-in.
Size: small-medium (the diffing logic is the fiddly part; the check
itself is simple once route boundaries are correctly identified).
— Session 4

### A root-level (not per-project) security/audit log
`routes/device.js` and the traversal-guard code in `store.js` both
currently log blocked/suspicious attempts to `console.warn` specifically
*because* there's no safe per-project place to log them when the
attempted attack IS the project identifier itself — logging into a
project's own `activity.json` using an attacker-controlled ID as the
key is exactly the kind of self-referential trap that would be ironic
to introduce while fixing a path-traversal bug. This was noted as a
known gap when Session 4 first found the traversal issue, and it's
still true: right now, anyone tailing server logs sees these, but
there's no in-app view of "security-relevant events across every
project," which matters more once this is public (SECURITY.md §3b) and
a human can't realistically watch raw process logs on a serverless
deployment the way they could on a local Termux session. Once real
storage lands (Turso or otherwise, per KFS #4), a small `security_log`
table with no `project_id` foreign key requirement (so it can log
against an ID that was never valid) would let this become a real,
human-visible thing instead of console output nobody's watching.
Size: medium (needs the storage question settled first — this is a
"once Turso lands" idea, not a "do this now" one).
— Session 4

### Consider whether GET /api/projects should exist at all once real human-route auth lands
Directly related to the `tokenHash` leak (KFS #9) this session found
and fixed (twice — see KNOWN_ISSUES.md): the deeper reason that leak
was possible at all is that `GET /api/projects` has no authentication
of any kind, by original design (`SECURITY.md` §1) — "no cloud auth,
device is the boundary." Once real authentication on human-facing
routes actually lands (`SECURITY.md` §3b, still an open, undecided
question as of this writing), it's worth revisiting whether this
specific route needs anything beyond "don't leak secrets in the
response" — e.g., should listing *all* projects on a device require
the same auth as creating/deleting one, or is read-access intentionally
more open? Not urgent (the leak itself is fixed regardless of how this
question resolves), but worth deciding deliberately rather than by
default once the bigger auth question is actually being designed,
since "what does GET /api/projects need" is a concrete sub-question of
that bigger one, not a separate concern.
Size: small (a design decision, not new code, once the bigger auth
question is being actively worked).
— Session 4

---

## In progress

*(nothing yet)*

---

## Done

*(nothing yet — first entries will move here once approved + shipped)*
