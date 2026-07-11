/**
 * Root-level entrypoint, for Vercel only.
 * ------------------------------------------------------------------
 * Vercel's zero-config Express/Node detection looks for an entrypoint
 * at specific fixed locations: app/index/server (.js/.ts) at the
 * project root or under src/. This app's real entrypoint lives at
 * backend/server.js, which Vercel's auto-detection does not scan.
 *
 * This file exists ONLY so Vercel finds something at a recognized
 * path. It changes nothing about how the app runs: requiring
 * backend/server.js executes it exactly as if it were the entrypoint
 * itself (Node's __dirname inside that file still resolves correctly
 * to backend/, since __dirname is based on a file's own location,
 * not whatever required it) -- including its existing app.listen()
 * call, which Vercel captures via its documented server-detection
 * mechanism (no vercel.json needed for this part).
 *
 * Local/Termux usage is unaffected: `npm start` still runs
 * `node backend/server.js` directly per package.json, and never
 * touches this file at all.
 * ------------------------------------------------------------------
 */
require('./backend/server.js');
