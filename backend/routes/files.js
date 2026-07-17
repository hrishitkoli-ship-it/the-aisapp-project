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
  PathSafetyError,
} = require('../utils/fileOps');

const humanRouter = express.Router({ mergeParams: true });
const aiRouter = express.Router({ mergeParams: true });

// ---------------------------------------------------------------------
// Shared handlers (identity-agnostic once req.isAI / req.project is set)
// ---------------------------------------------------------------------

async function handleListTree(req, res) {
  const { projectId } = req.params;
  try {
    const tree = await buildFileTree(projectId);
    res.json({ tree });
  } catch (err) {
    res.status(500).json({ error: `Failed to list files: ${err.message}` });
  }
}

async function handleReadFile(req, res) {
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
      await logSecurityAlert(req, projectId, relPath, 'read');
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: `Failed to read file: ${err.message}` });
  }
}

async function handleWriteFile(req, res) {
  const { projectId } = req.params;
  const relPath = req.params[0] || '';
  const { content, expectedVersion, force } = req.body || {};

  if (typeof content !== 'string') {
    return res.status(400).json({ error: '"content" (string) is required.' });
  }

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
  // Lives inside the try block below (moved here from before it,
  // where it originally sat unguarded): this is a real `await store.*`
  // call that can throw on any transient DB error, same as every other
  // store call this handler makes -- KFS #3's exact shape (an
  // unguarded await in an async handler with no next()) just applied
  // to a check that was added after the handler's own try/catch was
  // already in place, so it landed outside by omission rather than by
  // design. Left unguarded, a DB hiccup here would hang the request
  // (no response, no crash) instead of surfacing the same clean 500
  // every other failure path in this handler already produces.
  const actorLabel = req.isAI
    ? `AI${req.callerSessionId ? `:${req.callerSessionId}` : ''}`
    : 'human';

  try {
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
      await logSecurityAlert(req, projectId, relPath, 'write');
      return res.status(400).json({ error: err.message });
    }
    // Was: `err instanceof store.ProjectSizeLimitError || err instanceof
    // store.AccountSizeLimitError` -- neither class exists on the
    // currently-live store.js (confirmed via its module.exports, same
    // check app.js's own error handler already went through). Since
    // the right-hand side of instanceof must be a constructor,
    // checking against `undefined` throws a TypeError, which crashed
    // this whole process on any file-write error (confirmed live, not
    // theoretical). Generic statusCode check instead, matching app.js's
    // already-reconciled handler -- catches any current or future typed
    // error that sets one without needing another manual fix here.
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    res.status(500).json({ error: `Failed to write file: ${err.message}` });
  }
}

async function handleDeleteFile(req, res) {
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
      await logSecurityAlert(req, projectId, relPath, 'delete');
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: `Failed to delete: ${err.message}` });
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
humanRouter.get(/^\/content\/(.*)$/, handleReadFile);
humanRouter.put(/^\/content\/(.*)$/, handleWriteFile);
humanRouter.delete(/^\/content\/(.*)$/, handleDeleteFile);

// ---------------------------------------------------------------------
// AI-facing routes: /api/ai/:projectId/files (token required)
// ---------------------------------------------------------------------

aiRouter.use(requireAIToken);
aiRouter.use(aiWorkLimiter);
aiRouter.get('/tree', handleListTree);
aiRouter.get(/^\/content\/(.*)$/, handleReadFile);
aiRouter.put(/^\/content\/(.*)$/, handleWriteFile);
aiRouter.delete(/^\/content\/(.*)$/, handleDeleteFile);

module.exports = { humanRouter, aiRouter };

