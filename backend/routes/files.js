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
 * ------------------------------------------------------------------
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const store = require('../db/store');
const { requireAIToken, loadProjectForHuman } = require('../middleware/auth');
const { aiWorkLimiter } = require('../middleware/rateLimit');
const {
  safeResolve,
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

function handleListTree(req, res) {
  const { projectId } = req.params;
  try {
    const tree = buildFileTree(store.projectFilesDir(projectId));
    res.json({ tree });
  } catch (err) {
    res.status(500).json({ error: `Failed to list files: ${err.message}` });
  }
}

async function handleReadFile(req, res) {
  const { projectId } = req.params;
  const relPath = req.params[0] || '';
  try {
    const content = readFileContent(store.projectFilesDir(projectId), relPath);
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

  const actorLabel = req.isAI
    ? `AI${req.callerSessionId ? `:${req.callerSessionId}` : ''}`
    : 'human';

  try {
    const result = writeFileContent(store.projectFilesDir(projectId), relPath, content, {
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

    stampLastModifiedBy(store.projectFilesDir(projectId), relPath, actorLabel);

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
    const existed = deleteFileOrDir(store.projectFilesDir(projectId), relPath);
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
  const { nanoid } = require('nanoid');
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
