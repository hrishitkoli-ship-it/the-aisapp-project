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
const path = require('path');

const projectsRouter = require('./routes/projects');
const sessionsRoutes = require('./routes/sessions');
const instructionsRoutes = require('./routes/instructions');
const activityRoutes = require('./routes/activity');
const filesRoutes = require('./routes/files');

const app = express();

app.use(express.json({ limit: '2mb' }));

// CORS left open by design -- see README "Security notes": this is
// meant to run as a tool you (or your own AI agents) call directly,
// not to be exposed to the open internet without your own auth layer
// in front of it.
app.use(cors());

// ---------------------------------------------------------------------
// Human-facing routes (browser, no token)
// ---------------------------------------------------------------------
app.use('/api/projects', projectsRouter);
app.use('/api/projects/:projectId/sessions', sessionsRoutes.humanRouter);
app.use('/api/projects/:projectId/instructions', instructionsRoutes.humanRouter);
app.use('/api/projects/:projectId/activity', activityRoutes.humanRouter);
app.use('/api/projects/:projectId/files', filesRoutes.humanRouter);

// ---------------------------------------------------------------------
// AI-facing routes (token required)
// ---------------------------------------------------------------------
app.use('/api/ai/:projectId/sessions', sessionsRoutes.aiRouter);
app.use('/api/ai/:projectId/instructions', instructionsRoutes.aiRouter);
app.use('/api/ai/:projectId/activity', activityRoutes.aiRouter);
app.use('/api/ai/:projectId/files', filesRoutes.aiRouter);

// ---------------------------------------------------------------------
// Static frontend (unchanged from before this migration -- serving
// the built/static frontend files has nothing to do with the
// project-data storage layer this migration replaced).
// ---------------------------------------------------------------------
const frontendDir = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendDir));

// SPA fallback -- anything not matched above and not an /api/* path
// falls through to index.html so the frontend's own router can
// handle it client-side.
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

// ---------------------------------------------------------------------
// Central error handler -- catches anything passed to next(err) by
// any route above, including store.js's typed errors that a specific
// route didn't already handle itself.
// ---------------------------------------------------------------------
app.use((err, req, res, next) => {
  const store = require('./db/store');
  if (err instanceof store.InvalidProjectIdError) {
    return res.status(400).json({ error: 'Invalid project id.' });
  }
  if (err instanceof store.ProjectSizeLimitError || err instanceof store.AccountSizeLimitError) {
    return res.status(413).json({ error: err.message });
  }
  console.error('[unhandled error]', err);
  res.status(500).json({ error: 'Internal server error.' });
});

module.exports = app;
