/**
 * app.js
 * ------------------------------------------------------------------
 * Builds and configures the Express app, but does NOT call
 * app.listen(). Two things consume this:
 *
 *   - server.js (below, sibling file): calls app.listen() for local
 *     dev / Termux use (`npm start` / `npm run dev`), unchanged
 *     workflow from before this migration.
 *   - api/index.js (repo root): exports this app directly for
 *     Vercel's Node runtime, which calls it as a plain
 *     (req, res) => {} handler per request -- an Express app
 *     instance is already callable with that exact signature, so no
 *     extra adapter code is needed, just point Vercel at it via
 *     vercel.json's rewrite rule.
 *
 * This split exists because the ORIGINAL server.js called
 * app.listen() unconditionally at module load time, which is wrong
 * for a Vercel serverless function (Vercel manages the request
 * lifecycle itself; a stray .listen() either does nothing useful or
 * can cause problems depending on the runtime). Splitting the app
 * definition from the "how do we receive traffic" concern lets both
 * environments share the exact same route wiring with zero
 * duplication.
 * ------------------------------------------------------------------
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const projectsRouter = require('./routes/projects');
const deviceRoutes = require('./routes/device');
const migrationRoutes = require('./routes/migration');
const sessionsRoutes = require('./routes/sessions');
const instructionsRoutes = require('./routes/instructions');
const activityRoutes = require('./routes/activity');
const filesRoutes = require('./routes/files');
const githubIntegrationRoutes = require('./routes/githubIntegration');
const {
  globalBackstopLimiter,
  aiSurfaceLimiter,
} = require('./middleware/rateLimit');

const app = express();

/**
 * SECURITY HARDENING (Session 4): baseline security headers via
 * helmet -- X-Content-Type-Options, X-Frame-Options, HSTS (on HTTPS,
 * a no-op on plain local HTTP), and friends, all at helmet's sane
 * defaults. Mounted first so headers apply to every response
 * regardless of what happens further down the chain.
 *
 * CSP IS THE ONE PART OF THIS WORTH READING CAREFULLY BEFORE TOUCHING
 * frontend/index.html: script-src is locked to 'self' plus one
 * specific sha256 hash, computed from the exact byte content (verified
 * via a Node script reading the real file, not retyped by hand -- a
 * retyped-by-hand attempt produced a DIFFERENT, wrong hash on the
 * first try during this same session, which would have silently
 * broken PWA service-worker registration with no visible error) of
 * the one inline <script> block in index.html (the serviceWorker.
 * register() snippet). If that script's content changes even by one
 * character -- different whitespace, an added line, anything -- this
 * hash stops matching and the browser silently blocks it: no crash,
 * no error in this app's logs, just "service worker quietly stops
 * registering," which is a nasty thing to have to debug later. If
 * you're touching that inline script, either recompute the hash (see
 * scripts/ for a hash-computation snippet, or just paste the exact new
 * content into: `crypto.createHash('sha256').update(exactContent,
 * 'utf-8').digest('base64')` and update the value below) or move the
 * snippet to its own frontend/js/register-sw.js file and drop the
 * hash entirely -- the latter is more robust long-term and was not
 * done here only because touching frontend/ isn't this lane's scope.
 *
 * Every other directive is deliberately conservative but unrestrictive
 * given this app's actual shape: no inline styles are used anywhere
 * found in the frontend (style-src stays 'self'), no external CDNs or
 * third-party scripts are loaded (default-src 'self' covers
 * everything else), and connect-src includes 'self' only since every
 * API call this frontend makes is same-origin.
 */
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // cdnjs.cloudflare.com added here for JSZip (#12, this
        // session) and Prism (#10, Session 1) -- both landed as
        // external <script src="https://cdnjs...">/<link> tags
        // AFTER this CSP block was written with "no external CDNs...
        // given this app's actual shape" as its stated rationale.
        // That rationale is no longer accurate; verified live in a
        // browser console that both were being silently blocked
        // (no visible error in this app's own logs -- exactly the
        // failure mode this file's own header comment warns about
        // for the inline-script hash below). Note this does NOT fix
        // Prism's two inline <script> config blocks in index.html --
        // those need their own sha256 hashes (or a move to an
        // external file, per this section's existing guidance) and
        // are Session 1's file to touch; flagged in the ledger
        // rather than silently expanded into here.
        scriptSrc: [
          "'self'",
          "'sha256-hIoPKioPhemuiPB45DRjfJH/MJvbsoc8NsVWCtCd1j0='", // serviceWorker.register() inline snippet in index.html
          'https://cdnjs.cloudflare.com',
        ],
        styleSrc: ["'self'", 'https://cdnjs.cloudflare.com'], // Prism's stylesheet <link>
        imgSrc: ["'self'", 'data:'], // data: for the PWA icons' any inline favicon/data-uri usage
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
      },
    },
  })
);

// 15mb, not a smaller default: an AI agent may paste substantial code
// files as a single PUT body. Matches server.js's existing limit and
// reasoning (see that file) -- this value previously differed between
// the two files (app.js had 2mb, no stated reason) for no apparent
// reason connected to an actual constraint; reconciled to the one
// with a real justification behind it.
app.use(express.json({ limit: '15mb' }));

// CORS left open by design -- see README "Security notes": this is
// meant to run as a tool you (or your own AI agents) call directly,
// not to be exposed to the open internet without your own auth layer
// in front of it.
app.use(cors());

// Global rate-limiting backstop: applies to every request, before
// anything else. Not abuse-detection (the tiered limiters below and in
// each route file handle that) -- this is purely the "make sure the
// app doesn't crash" safety net against any runaway loop, buggy or
// malicious, on either side of the API. See middleware/rateLimit.js's
// header comment for the full reasoning and the other tiers.
app.use(globalBackstopLimiter);

// ---------------------------------------------------------------------
// Human-facing routes (browser, no token)
// ---------------------------------------------------------------------
app.use('/api/projects', projectsRouter);
app.use('/api/device', deviceRoutes);
app.use('/api/migration', migrationRoutes);
app.use('/api/projects/:projectId/sessions', sessionsRoutes.humanRouter);
app.use('/api/projects/:projectId/instructions', instructionsRoutes.humanRouter);
app.use('/api/projects/:projectId/activity', activityRoutes.humanRouter);
app.use('/api/projects/:projectId/files', filesRoutes.humanRouter);
app.use('/api/projects/:projectId/github', githubIntegrationRoutes.humanRouter);

// ---------------------------------------------------------------------
// AI-facing routes (token required).
//
// aiSurfaceLimiter runs BEFORE each router below (and therefore before
// that router's own requireAIToken, applied inside the route files
// themselves) -- deliberate, not an oversight: it's the only limiter
// keyed by IP rather than project, specifically so it can catch token
// brute-forcing/auth-hammering BEFORE a token is known to be valid. A
// project-keyed limiter (aiWorkLimiter, applied inside each route file
// right after requireAIToken) structurally cannot do this job, since an
// attacker without a valid token never has a project to be keyed by.
// See middleware/rateLimit.js for the full tier breakdown.
// ---------------------------------------------------------------------
app.use('/api/ai/:projectId/sessions', aiSurfaceLimiter, sessionsRoutes.aiRouter);
app.use('/api/ai/:projectId/instructions', aiSurfaceLimiter, instructionsRoutes.aiRouter);
app.use('/api/ai/:projectId/activity', aiSurfaceLimiter, activityRoutes.aiRouter);
app.use('/api/ai/:projectId/files', aiSurfaceLimiter, filesRoutes.aiRouter);

// ---------------------------------------------------------------------
// Static frontend (unchanged from before this migration -- serving
// the built/static frontend files has nothing to do with the
// project-data storage layer this migration replaced).
//
// setHeaders callback ported from server.js during this session's
// reconciliation pass (see this file's own header note on why the two
// had drifted) -- without this, the service worker could get cached
// by a browser or CDN on the Vercel path, meaning PWA updates might
// never reach an already-installed user. Not a hypothetical: this is
// specifically why service workers conventionally ship with
// Cache-Control: no-cache, and server.js already had this right.
// ---------------------------------------------------------------------
const frontendDir = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('service-worker.js')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// SPA fallback -- anything not matched above and not an /api/* path
// falls through to index.html so the frontend's own router can
// handle it client-side.
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

// Any /api/* path that reached here matched no route above (a typo'd
// endpoint, wrong method, etc.) -- explicit handler so this returns
// the same clean JSON shape every other error in this app uses,
// rather than falling through to Express's default HTML 404. Ported
// from server.js during this session's reconciliation pass, which had
// this and app.js did not.
app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// ---------------------------------------------------------------------
// Central error handler -- catches anything passed to next(err) by
// any route above.
//
// RECONCILED with server.js's error handler during this session (see
// that file's own note on why the two were drifting): this version
// previously checked for `store.ProjectSizeLimitError` /
// `store.AccountSizeLimitError`, neither of which the currently-live
// store.js exports (confirmed directly via its module.exports) --
// dead code referencing a feature from a different, not-currently-
// active version of the datastore. Removed. Added a check for
// `err.statusCode` (generic, matches ANY typed error that sets one --
// currently just StorageReadOnlyError, which server.js's handler
// already correctly caught and this one did not, meaning a read-only-
// storage failure on the Vercel path was incorrectly falling through
// to a generic 500 instead of the correct 503) instead of hardcoding
// specific error classes one at a time, so this handler doesn't need
// updating again the next time store.js's typed-error set changes.
// ---------------------------------------------------------------------
app.use((err, req, res, next) => {
  const store = require('./db/store');
  if (err instanceof store.InvalidProjectIdError) {
    return res.status(400).json({ error: 'Invalid project id.' });
  }
  if (err.statusCode) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  console.error('[unhandled error]', err);
  res.status(500).json({ error: 'Internal server error.' });
});

module.exports = app;

