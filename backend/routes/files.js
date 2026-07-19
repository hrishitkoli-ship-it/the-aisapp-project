/**
 * routes/files.js
 * ------------------------------------------------------------------
 * The Workspace (Page 1) backend: file tree listing, reading, and
 * writing. Two entry points converge here:
 *
 *   - Human routes (browser, no token) mounted at
 *     /api/projects/:projectId/files/*
 *   - AI routes (token required) mounted at
 *     /api/ai/:projectId/files/*
 *
 * Both ultimately call the same shared write logic in fileOps.js so
 * behavior (conflict checks, activity logging, path safety) can't
 * drift between the two callers.
 *
 * CHANGED: fileOps.js is now Postgres-backed and every one of its
 * functions is async, and takes `projectId` directly instead of a
 * filesystem directory path (there's no `store.projectFilesDir()`
 * anymore -- see db/store.js/fileOps.js headers for why). Every
 * handler below was already async except handleListTree, which
 * needed both `async` added AND its previously-uncaught body wrapped
 * in try/catch, since it's the one handler here that had no error
 * handling at all in the original (its try/catch only existed around
 * res.json, not around the store call).
 *
 * CHANGED (KFS #3 fix): all four shared handlers now accept `next`
 * and route unhandled errors through it so the central error handler
 * in app.js can translate typed errors (InvalidProjectIdError → 400,
 * ProjectSizeLimitError/AccountSizeLimitError → 413) correctly.
 * Previously they hard-coded res.status(500), so every DB/size error
 * silently came back as a generic 500 regardless of its actual cause.
 *
 * Also fixed: handleWriteFile's TOS gate (`store.hasAcceptedTos()`)
 * was being awaited OUTSIDE the try block -- a DB error there would
 * produce an unhandled rejection in Express 4, which never auto-routes
 * rejected async handler promises to error middleware. Moved inside
 * try/catch.
 *
 * Also fixed: logSecurityAlert calls inside catch blocks now use
 * `.catch(() => {})` rather than bare `await` so a secondary DB error
 * in the alert logger can't produce another unhandled rejection and
 * interfere with the response that's already in flight.
 * ------------------------------------------------------------------
 */

const express = require('express');
const { nanoid } = require('nanoid');
const store = require('../db/store');
const { requireAIToken, loadProjectForHuman } = require('../middleware/auth');
const { aiWorkLimiter } = require('../middleware/rateLimit');
const {
  buildFileTree,
  readFileContent,
  writeFileContent,
  stampLastModifiedBy,
  deleteFileOrDir,
  searchFileContents,
  PathSafetyError,
} = require('../utils/fileOps');

const humanRouter = express.Router({ mergeParams: true });
const aiRouter = express.Router({ mergeParams: true });

// ---------------------------------------------------------------------
// Shared handlers (identity-agnostic once req.isAI / req.project is set)
// ---------------------------------------------------------------------

async function handleListTree(req, res, next) {
  const { projectId } = req.params;
  try {
    const tree = await buildFileTree(projectId);
    res.json({ tree });
  } catch (err) {
    next(err);
  }
}

async function handleReadFile(req, res, next) {
  const { projectId } = req.params;
  const relPath = req.params[0] || '';
  try {
    const content = await readFileContent(projectId, relPath);
    if (content === null) {
      return res.status(404).json({ error: 'File not found.' });
    }
    res.json({ path: relPath, content });
  } catch (err) {
    if (err instanceof PathSafetyError) {
      // Fire-and-forget: don't let a secondary DB error in the alert
      // logger produce another unhandled rejection.
      logSecurityAlert(req, projectId, relPath, 'read').catch(() => {});
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
}

async function handleWriteFile(req, res, next) {
  const { projectId } = req.params;
  const relPath = req.params[0] || '';
  const { content, expectedVersion, force } = req.body || {};

  if (typeof content !== 'string') {
    return res.status(400).json({ error: '"content" (string) is required.' });
  }

  const actorLabel = req.isAI
    ? `AI${req.callerSessionId ? `:${req.callerSessionId}` : ''}`
    : 'human';

  try {
    // TOS GATE: must be accepted (once, ever, per device -- see the
    // Settings page) before this device can write ANY file content,
    // AI-agent or human. Checked here rather than only client-side so
    // it can't be bypassed by an AI agent calling the API directly
    // without ever loading the frontend. req.project.deviceCode is
    // always present for any project created after device identity
    // landed (routes/projects.js sets it at creation time); a project
    // that somehow predates that (deviceCode undefined) fails closed --
    // hasAcceptedTos(undefined) returns false -- rather than silently
    // exempting old projects from a check meant to apply device-wide.
    //
    // MOVED INSIDE try/catch: was previously outside it, meaning a DB
    // error here would be an unhandled rejection in Express 4 (KFS #3).
    const accepted = await store.hasAcceptedTos(req.project.deviceCode);
    if (!accepted) {
      return res.status(403).json({
        error: 'Accept the Terms & Privacy Policy on the Settings page before creating files.',
        requiresTosAcceptance: true,
      });
    }

    const result = await writeFileContent(projectId, relPath, content, {
      expectedVersion,
      force: !!force,
    });

    if (result.conflict) {
      // Someone else changed this file since the caller last read it.
      // We do NOT overwrite silently -- this is the "conflict resolution
      // safeguard" the spec calls for. Caller must retry with force:true
      // (after showing the user a warning) if they really want to clobber it.
      return res.status(409).json({
        error: 'Conflict: file was modified by someone else since your last read.',
        currentVersion: result.currentVersion,
        lastModifiedBy: result.lastModifiedBy,
        lastModifiedAt: result.lastModifiedAt,
      });
    }

    await stampLastModifiedBy(projectId, relPath, actorLabel);

    await logActivity(projectId, {
      type: 'file_write',
      actor: actorLabel,
      message: `${actorLabel} wrote ${relPath}`,
      path: relPath,
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true, path: relPath, version: result.version });
  } catch (err) {
    if (err instanceof PathSafetyError) {
      logSecurityAlert(req, projectId, relPath, 'write').catch(() => {});
      return res.status(400).json({ error: err.message });
    }
    // next(err) lets the central handler in app.js translate typed
    // errors correctly: InvalidProjectIdError → 400,
    // ProjectSizeLimitError/AccountSizeLimitError (err.statusCode=413) → 413,
    // everything else → 500.
    next(err);
  }
}

async function handleDeleteFile(req, res, next) {
  const { projectId } = req.params;
  const relPath = req.params[0] || '';
  const actorLabel = req.isAI
    ? `AI${req.callerSessionId ? `:${req.callerSessionId}` : ''}`
    : 'human';

  try {
    const existed = await deleteFileOrDir(projectId, relPath);
    if (!existed) return res.status(404).json({ error: 'File or folder not found.' });

    await logActivity(projectId, {
      type: 'file_delete',
      actor: actorLabel,
      message: `${actorLabel} deleted ${relPath}`,
      path: relPath,
      timestamp: new Date().toISOString(),
    });

    res.json({ success: true });
  } catch (err) {
    if (err instanceof PathSafetyError) {
      logSecurityAlert(req, projectId, relPath, 'delete').catch(() => {});
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
}

async function handleSearchFiles(req, res, next) {
  const { projectId } = req.params;
  const q = (req.query.q || '').toString();
  try {
    const results = await searchFileContents(projectId, q);
    res.json({ results });
  } catch (err) {
    next(err);
  }
}

async function logActivity(projectId, entryWithoutId) {
  return store.appendActivity(projectId, { id: nanoid(8), ...entryWithoutId });
}

/** Surface a blocked path-traversal attempt in the activity timeline so
 *  the human overseeing AI sessions actually sees it, instead of it
 *  disappearing as a silent 400 the calling agent just absorbs. */
async function logSecurityAlert(req, projectId, attemptedPath, action) {
  const actorLabel = req.isAI
    ? `AI${req.callerSessionId ? `:${req.callerSessionId}` : ''}`
    : 'human';
  return logActivity(projectId, {
    type: 'security_alert',
    actor: actorLabel,
    message: `Blocked a ${action} attempt outside the workspace sandbox (path: "${attemptedPath}").`,
    timestamp: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------
// Human-facing routes: /api/projects/:projectId/files
// ---------------------------------------------------------------------

humanRouter.use(loadProjectForHuman);
humanRouter.get('/tree', handleListTree);
humanRouter.get('/search', handleSearchFiles);
humanRouter.get(/^\/content\/(.*)$/, handleReadFile);
humanRouter.put(/^\/content\/(.*)$/, handleWriteFile);
humanRouter.delete(/^\/content\/(.*)$/, handleDeleteFile);

// ---------------------------------------------------------------------
// AI-facing routes: /api/ai/:projectId/files (token required)
// ---------------------------------------------------------------------

aiRouter.use(requireAIToken);
aiRouter.use(aiWorkLimiter);
aiRouter.get('/tree', handleListTree);
aiRouter.get('/search', handleSearchFiles);
aiRouter.get(/^\/content\/(.*)$/, handleReadFile);
aiRouter.put(/^\/content\/(.*)$/, handleWriteFile);
aiRouter.delete(/^\/content\/(.*)$/, handleDeleteFile);

module.exports = { humanRouter, aiRouter };
