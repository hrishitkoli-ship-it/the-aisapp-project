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

### Fix aisapp_projects.updated_at's timestamp format before anything reads it
Found while fixing the same bug in `aisapp_files.updated_at` (see
Session Ledger — Session 4). Both `saveProject`, `saveSessions`,
`saveInstructions`, and `appendActivity` write
`updated_at = datetime('now')` (SQLite's own format: space-separated,
no UTC marker) — the exact same format that, when later parsed via
`new Date(...)` in a browser not physically in UTC+0, gets
misinterpreted as local time instead of UTC. Not fixed this pass
because nothing currently reads `aisapp_projects.updated_at` in any
Date-parsing frontend code (checked directly) — but it's a very
plausible thing to want later (e.g. "last edited" on the project
list), and whoever adds that will hit this exact bug fresh unless it's
fixed first. Same fix as the files.js one: swap
`datetime('now')` → `strftime('%Y-%m-%dT%H:%M:%fZ','now')` in all four
call sites.
Size: small — four one-line changes, same pattern already proven
correct elsewhere.
— Session 4

## In progress

*(nothing yet)*

---

## Done

### Audit other route files for the same missing-try/catch pattern
**DONE** — completed per direct human instruction ("find and improve
more bugs"), which is what actually authorized picking this up (not
self-approval — see this file's own rule on that). Audited every async
handler in `sessions.js`, `instructions.js`, `device.js`, `migration.js`,
and re-checked `projects.js`: all clean, full try/catch coverage,
confirmed by direct reading, not just grep. Found one real, live
instance of the gap in `files.js`'s `handleWriteFile` — not the file
this idea originally named as unaudited by coincidence, but a genuinely
distinct instance (the ToS-gate check, added after the handler's
try/catch already existed, landed outside it). See `KNOWN_ISSUES.md`
("3rd occurrence of KFS #3") for the full writeup and
`INSTRUCTIONS.md`'s new Non-Negotiable Rule 7 for what this graduated
into. Original idea text preserved below for record.

<details>
<summary>Original idea text</summary>

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

</details>

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

### Turso connection appears to hang rather than fail fast when unreachable
Found while re-verifying a crash fix (see Session Ledger / KNOWN_ISSUES.md
— the `instanceof` against non-existent `SizeLimitError` classes in
`files.js`/`projects.js`, now fixed). Testing that fix required booting
locally without real Turso credentials; store.js now throws a clear
error at require-time if the env vars are unset at all (good — fail
loud, not silent), but with placeholder/unreachable credentials *set*,
a request that touches the database didn't return an error response at
all — the process stayed alive (no crash trace in the log) but stopped
responding to that request, and the connection had to be killed
manually. Only tested against a deliberately fake hostname from a
sandbox with no real network path to `*.turso.io` at all, so this could
be an artifact of that specific setup rather than real client
behavior against an actually-unreachable-but-real Turso instance (e.g.
a transient regional outage) — flagging as "worth checking," not "this
is definitely a bug." If it does hold against a real instance: worth a
connection/query timeout so a Turso hiccup degrades to a clean 503
rather than a hung request. Didn't touch store.js's connection setup
to check further — that's Session 2's file mid-migration, not somewhere
to go poking without asking.
Size: unknown until someone can verify against a real Turso instance
(needs actual network access to `*.turso.io`, which at least two
sessions' sandboxes so far have not had).
— Session 1

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
