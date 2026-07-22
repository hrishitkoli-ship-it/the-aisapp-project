/**
 * scripts/generate-skill.js
 * ------------------------------------------------------------------
 * Generates frontend/SKILL.md -- the downloadable AI onboarding doc
 * for sprint item #6. Run during `vercel-build` so it's always in
 * sync with the actual deployed routes, never hand-maintained.
 *
 * Usage:
 *   node scripts/generate-skill.js
 *   # or automatically via npm run vercel-build
 * ------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'frontend', 'SKILL.md');

// ----------------------------------------------------------------
// Route file definitions: which file maps to which URL prefix
// ----------------------------------------------------------------

const ROUTE_FILES = [
  { file: 'backend/routes/projects.js',    humanMount: '/api/projects',                           aiMount: null },
  { file: 'backend/routes/device.js',       humanMount: '/api/device',                             aiMount: null },
  { file: 'backend/routes/migration.js',    humanMount: '/api/migration',                          aiMount: null },
  { file: 'backend/routes/sessions.js',     humanMount: '/api/projects/:projectId/sessions',       aiMount: '/api/ai/:projectId/sessions' },
  { file: 'backend/routes/instructions.js', humanMount: '/api/projects/:projectId/instructions',   aiMount: '/api/ai/:projectId/instructions' },
  { file: 'backend/routes/activity.js',     humanMount: '/api/projects/:projectId/activity',       aiMount: '/api/ai/:projectId/activity' },
  { file: 'backend/routes/files.js',        humanMount: '/api/projects/:projectId/files',          aiMount: '/api/ai/:projectId/files' },
  { file: 'backend/routes/githubIntegration.js', humanMount: '/api/projects/:projectId/github',    aiMount: null }, // #13, human-only by design -- see that file's own header for why
];

// ----------------------------------------------------------------
// Route extraction
// ----------------------------------------------------------------

/**
 * Convert a JS regex literal body (as it appears in source text,
 * e.g. "^\\/content\\/(.*)$" which is ^ \\ / c o n t e n t \\ / ... $)
 * to a human-readable path like "/content/:path*".
 */
function regexBodyToPath(raw) {
  return raw
    .replace(/^\^/, '')                   // strip leading ^
    .replace(/\$$/, '')                   // strip trailing $
    .replace(/\\+\//g, '/')               // \\/ or \/ -> /
    .replace(/\(\.\*\)/g, ':path*')       // (.*) -> :path*
    .replace(/\([^)]+\)/g, ':segment');   // other capture groups -> :segment
}

/**
 * Extract all routes from a route file's source text.
 * Returns [{verb, subPath}] where subPath is relative to the mount point.
 */
function extractFromSrc(src) {
  const results = [];

  for (const line of src.split('\n')) {
    // Router variable name: matches `router`, `aiRouter`, `humanRouter`,
    // or any other `*Router` identifier. Classification (isAI, below)
    // is a separate exact-match check on the captured name, so being
    // permissive here doesn't risk misclassifying anything.
    //
    // BUG FOUND ON RE-VERIFICATION, not caught when this script was
    // first written: the original pattern was `\b(router|aiRouter)\.`
    // -- literal-string alternation only. \b is a zero-width boundary
    // between a \w and a non-\w character; camelCase transitions (the
    // lowercase-n -> uppercase-R in "humanRouter") are \w on both
    // sides, so \b never fires there -- `\brouter\b` case-insensitively
    // never matched the "Router" substring inside "humanRouter". That
    // meant every route defined on `humanRouter` (sessions.js,
    // instructions.js, activity.js, files.js, githubIntegration.js --
    // five of seven route files) was silently missing from the
    // generated human-facing table since this script's first version,
    // including this exact session's own new dismiss route. Caught by
    // reading the generated SKILL.md against the real route files
    // after adding one more route to check, not by assuming a script
    // with no error meant correct output.
    const strMatch = line.match(/\b(\w*[Rr]outer)\.(get|post|patch|put|delete)\s*\(\s*['"`]([^'"`]*)['"`]/);
    if (strMatch) {
      results.push({
        isAI: strMatch[1] === 'aiRouter',
        verb: strMatch[2].toUpperCase(),
        subPath: strMatch[3] === '/' ? '' : strMatch[3],
      });
      continue;
    }

    // Match regex-path routes: aiRouter.get(/^\/content\/(.*)$/, ...)
    // The source file stores these as /^\\/content\\/(.*)$/ (JS regex literal)
    const rxMatch = line.match(/\b(\w*[Rr]outer)\.(get|post|patch|put|delete)\s*\(\s*\/(.*?)\/\s*,/);
    if (rxMatch) {
      results.push({
        isAI: rxMatch[1] === 'aiRouter',
        verb: rxMatch[2].toUpperCase(),
        subPath: regexBodyToPath(rxMatch[3]),
      });
    }
  }

  return results;
}

const humanRoutes = [];
const aiRoutes = [];

for (const { file, humanMount, aiMount } of ROUTE_FILES) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const { isAI, verb, subPath } of extractFromSrc(src)) {
    if (isAI && aiMount) {
      aiRoutes.push({ verb, path: `${aiMount}${subPath}` });
    } else if (!isAI && humanMount) {
      humanRoutes.push({ verb, path: `${humanMount}${subPath}` });
    }
  }
}

// ----------------------------------------------------------------
// Markdown helpers
// ----------------------------------------------------------------

function routeTable(routes) {
  if (!routes.length) return '_none_\n';
  const colW = Math.max(6, ...routes.map(r => r.verb.length));
  const pathW = Math.max(4, ...routes.map(r => r.path.length));
  const header = `| ${'Method'.padEnd(colW)} | ${'Path'.padEnd(pathW)} |`;
  const sep    = `| ${'-'.repeat(colW)} | ${'-'.repeat(pathW)} |`;
  const rows   = routes.map(r => `| ${r.verb.padEnd(colW)} | ${r.path.padEnd(pathW)} |`);
  return [header, sep, ...rows].join('\n') + '\n';
}

// ----------------------------------------------------------------
// Output
// ----------------------------------------------------------------

const now = new Date().toISOString().slice(0, 10);

const md = `# Aisapp — AI Integration Skill
<!-- AUTO-GENERATED by scripts/generate-skill.js on ${now}. Do not edit by hand. -->

This file teaches any AI model how to integrate with the Aisapp project
coordination API. Download it from the app's home page header ("Download AI Instructions").

---

## What Aisapp is

A local-first PWA that lets a human coordinate multiple concurrent AI coding
sessions against a shared project. You (an AI) talk to the API; the human
watches the roster and approves/rejects function assignments in the UI.

---

## Quick start

1. The human creates a project in the UI and copies your token (shown once).
2. Register yourself in the session roster — this is how the human sees you're live.
3. Read/write project files as you work.
4. Use the request queue to hand off work to another AI session.
5. Propose function assignments; a human must approve them before they're real.

---

## Authentication

| Route prefix          | Auth required                                      |
| --------------------- | -------------------------------------------------- |
| \`/api/projects/...\` | None (human-facing, device is the trust boundary)  |
| \`/api/ai/...\`       | \`Authorization: Bearer <token>\` on every request |

### If you were handed a connection link instead of a bare token

A human may paste you a single link that looks like:

\`\`\`
https://<host>/#/connect/<projectId>/<token>
\`\`\`

instead of separately telling you the host, project ID, and token. All
three are in that one string — parse it as an ordinary URL:

- Everything before the first \`/#/\` is \`<host>\` — the base URL for
  every API call below.
- The path segment right after \`/#/connect/\` is \`<projectId>\`.
- Everything after that (the rest of the path) is \`<token>\` — use it
  exactly as-is in \`Authorization: Bearer <token>\`, including the
  \`.\` and everything after it if present (that's the token's own
  encryption-key suffix, not a URL file extension — don't truncate at
  the first \`.\`).

This link only exists as a convenience for handing you everything at
once — there's no separate endpoint to "redeem" it. Once you've
parsed out host/projectId/token, use them exactly as documented below;
there's no different behavior for a link-derived token versus one you
were told about verbally.

---

## AI-facing routes

These are the routes you call. All require \`Authorization: Bearer <token>\`.

${routeTable(aiRoutes)}
---

## Key workflows

### Register / update your session
\`\`\`bash
curl -X POST <host>/api/ai/<projectId>/sessions \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"sessionId":"session-2","label":"Backend Lane","function":"API development","currentTask":"Implementing zip download"}'
\`\`\`

Update your status as work progresses:
\`\`\`bash
curl -X PATCH <host>/api/ai/<projectId>/sessions/session-2 \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"currentTask":"Done with zip","status":"active"}'
\`\`\`

### Read a file
\`\`\`bash
curl <host>/api/ai/<projectId>/files/content/src/main.js \\
  -H "Authorization: Bearer <token>"
\`\`\`
Returns \`{ content, version, lastModifiedBy }\`.

### Write a file (with conflict protection)
\`\`\`bash
curl -X PUT <host>/api/ai/<projectId>/files/content/src/main.js \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"content":"...","expectedVersion":3}'
\`\`\`
Returns \`409\` if someone else wrote the file since your last read. Include
\`"force":true\` to overwrite anyway (only after reviewing the conflict).

### Read the file tree
\`\`\`bash
curl <host>/api/ai/<projectId>/files/tree \\
  -H "Authorization: Bearer <token>"
\`\`\`

### Send a request to another AI session
\`\`\`bash
curl -X POST <host>/api/ai/<projectId>/sessions/session-3/requests \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"message":"Please review the zip route for path-leak risks"}'
\`\`\`

Check your own inbox: \`GET /api/ai/<projectId>/sessions\` — find your entry,
read \`taskQueue\`. Pending requests from other sessions outrank your own backlog
(Rule 0 — imported from this project's own INSTRUCTIONS.md).

### Mark a request done
\`\`\`bash
curl -X PATCH <host>/api/ai/<projectId>/sessions/<sessionId>/requests/<requestId> \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"status":"done"}'
\`\`\`

### Propose a function assignment (human must approve)
\`\`\`bash
curl -X POST <host>/api/ai/<projectId>/instructions/assignments \\
  -H "Authorization: Bearer <token>" \\
  -H "Content-Type: application/json" \\
  -d '{"functionName":"Zip download","sessionId":"session-2","sessionLabel":"Backend Lane"}'
\`\`\`
Stays \`pending\` until a human approves it in the Instructions page UI.
Never treat a proposal as approved just because you filed it.

### Read the activity log
\`\`\`bash
curl <host>/api/ai/<projectId>/activity \\
  -H "Authorization: Bearer <token>"
\`\`\`

---

## Human-facing routes (for reference only — you don't call these)

${routeTable(humanRoutes)}
---

## Conflict handling

Every file write should include \`expectedVersion\` (the \`version\` field from
your last read). The server returns \`409\` with \`{ currentVersion, lastModifiedBy }\`
if there's a mismatch. Do not auto-force: flag the conflict, then decide.

---

## Rules that apply to you as an AI session

1. Read \`INSTRUCTIONS.md\` in the project repo before touching any file.
2. Check your own \`taskQueue\` before starting new self-directed work.
3. Commit and push after every meaningful change (multi-session repo).
4. Never approve your own function assignment proposals.
5. If you find something blocking another session, file it visibly — don't
   sit on it, don't silently fix someone else's lane.

---

_Generated from live route definitions. If out of date, run \`node scripts/generate-skill.js\`._
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, md, 'utf8');
console.log(`generate-skill: wrote ${OUT}`);
