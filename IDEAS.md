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

---

## In progress

*(nothing yet)*

---

## Done

*(nothing yet — first entries will move here once approved + shipped)*
