/**
 * scripts/vercel-build-public.js
 * ------------------------------------------------------------------
 * Vercel's zero-config Express deployment serves static assets only
 * from a public/** directory via its CDN -- express.static() is
 * ignored at request time in that deployment mode (Vercel's routing
 * layer intercepts static-looking paths before they ever reach the
 * Express function). This is a hard requirement per Vercel's current
 * docs, not a style preference.
 *
 * frontend/ remains the single source of truth (used directly by
 * backend/server.js's express.static() call for local/Termux use,
 * completely unchanged). public/ is a BUILD ARTIFACT, generated fresh
 * from frontend/ on every Vercel build by this script, never
 * hand-edited or committed (see .gitignore) -- so there is exactly
 * one place to edit frontend code, regardless of which environment
 * ends up serving it.
 *
 * Invoked via package.json's "vercel-build" script, which Vercel
 * runs automatically before detecting/building the Express function.
 * ------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'frontend');
const DEST = path.join(__dirname, '..', 'public');

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

if (!fs.existsSync(SRC)) {
  console.error(`vercel-build-public: source directory not found: ${SRC}`);
  process.exit(1);
}

fs.rmSync(DEST, { recursive: true, force: true });
copyRecursive(SRC, DEST);

// _test-harness.html is a Session 3 manual-verification page, not
// something that should be publicly deployed -- it exercises the
// project management UI in isolation and assumes a dev-style setup.
const testHarnessPath = path.join(DEST, '_test-harness.html');
if (fs.existsSync(testHarnessPath)) {
  fs.unlinkSync(testHarnessPath);
}

console.log(`vercel-build-public: copied ${SRC} -> ${DEST}`);
