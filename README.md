# AI Collaborative Hub

A local-first Progressive Web App for managing a coding project alongside
multiple external AI agents. No cloud login, no database server, no native
build tools -- everything runs from a single lightweight Node/Express
process and stores data as plain JSON files on your own device.

Built to run entirely on a phone, inside Termux or a mobile IDE.

## Why this exists

If you're running several AI coding sessions against the same project, you
need somewhere for them to:
- read and write the actual project files,
- report what they're currently doing,
- ask each other for help on things outside their own lane,
- propose changes that a human still has to approve before they're real.

This app is that shared surface -- a local API + UI that both you and your
AI agents talk to.

## Requirements

- Node.js >= 18 (check with `node --version`)
- No native compilers, no Docker, no Python toolchain required. Every
  dependency (`express`, `cors`, `nanoid`) is pure JavaScript.

## Running it

```bash
npm install
npm start
```

The server prints both a `localhost` URL and a LAN URL. Open either in a
mobile browser and tap "Add to Home Screen" to install it as a PWA.

### Termux quick start

```bash
pkg install nodejs
git clone <this-repo-url>
cd ai-collab-hub
npm install
npm start
```

## How the pieces fit together

```
ai-collab-hub/
├── backend/
│   ├── server.js          Entry point -- wires up every route
│   ├── db/store.js        JSON-file datastore (no SQLite, no native deps)
│   ├── middleware/auth.js Human vs. AI request identity
│   ├── routes/            projects, files, sessions, instructions, activity
│   └── utils/
│       ├── tokens.js      Token generation + hashing (SHA-256, never stored raw)
│       └── fileOps.js     Safe path resolution + optimistic-concurrency writes
├── frontend/               The PWA itself (HTML/CSS/vanilla JS, no build step)
├── projects/               Runtime data -- one folder per project, gitignored
└── package.json
```

## Two identities, one API

Every route exists in two versions:

- **Human** (`/api/projects/...`) -- the browser UI. No token needed; the
  device itself is the trust boundary, per the "no cloud auth" design goal.
- **AI** (`/api/ai/:projectId/...`) -- external agents. Every request needs
  `Authorization: Bearer <project-token>`.

The AI Session Roster follows this same split at the route level, not just
in the UI: there is no human-facing write route for it at all, and no
AI-facing approve/reject route for function assignments. Permissions are
structural, not just enforced by what buttons the frontend happens to show.

## Connecting an external AI agent

1. Create a project in the UI. Copy its token (shown once).
2. Have your agent call the AI-facing endpoints with that token:

```bash
# Register / update a session
curl -X POST http://<host>:7077/api/ai/<projectId>/sessions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"session-1","label":"Items Lane","function":"Item registration","currentTask":"Building potato cannon"}'

# Read a file
curl http://<host>:7077/api/ai/<projectId>/files/content/scripts/main.js \
  -H "Authorization: Bearer <token>"

# Write a file (include expectedVersion from your last read to avoid clobbering
# someone else's concurrent edit -- see Conflict handling below)
curl -X PUT http://<host>:7077/api/ai/<projectId>/files/content/scripts/main.js \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"content":"...", "expectedVersion": 3}'

# Ask another session to pick up work outside your lane
curl -X POST http://<host>:7077/api/ai/<projectId>/sessions/session-2/requests \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"message":"Need a projectile entity system for the potato cannon"}'

# Update your session's current task / status (call this as your work progresses)
curl -X PATCH http://<host>:7077/api/ai/<projectId>/sessions/<sessionId> \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"currentTask":"Building the projectile entity","status":"active"}'

# Mark a queued task request as done once you've handled it
curl -X PATCH http://<host>:7077/api/ai/<projectId>/sessions/<sessionId>/requests/<requestId> \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"status":"done"}'

# Propose (not execute) a function assignment -- stays pending until a human approves it in the UI
curl -X POST http://<host>:7077/api/ai/<projectId>/instructions/assignments \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"functionName":"Projectile entity system","sessionId":"session-2","sessionLabel":"Machines Lane"}'
```

Full route list is in `backend/server.js`.

## Conflict handling

Every file write can include `expectedVersion` (the version you last read).
If someone else -- human or another AI -- wrote the file since then, the
server responds `409` with the current version and who made the change,
instead of silently overwriting it. Pass `force: true` to write anyway once
you've decided that's really what you want.

## Security notes

- Tokens are generated with 32 bytes of randomness and stored only as a
  SHA-256 hash -- the raw token is shown exactly once, at creation or
  regeneration time, the same way GitHub does it.
- File paths from any request (human or AI) are resolved against the
  project's own workspace folder and rejected if they'd resolve outside it,
  including percent-encoded traversal attempts. A rejected attempt is logged
  to that project's activity timeline, tagged `security_alert`, so it's
  visible to the human even though the request itself was blocked.
- CORS is left open and there's no cloud auth by design -- this is meant to
  run on one device you control, not to be exposed to the open internet.
  If you do expose it beyond your own LAN, put it behind your own auth
  layer first.

## License

MIT
