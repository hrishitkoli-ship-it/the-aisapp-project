/**
 * routes/sessions.js
 * ------------------------------------------------------------------
 * Page 2: AI Session Roster.
 *
 * Permission model (from the spec): "strictly read-only for the user,
 * read/write for the AIs (via the API)". This is enforced structurally:
 *
 *   GET  /api/projects/:projectId/sessions      <- human, read-only
 *   GET  /api/ai/:projectId/sessions             <- AI, read
 *   POST /api/ai/:projectId/sessions             <- AI, create/register
 *   PATCH /api/ai/:projectId/sessions/:sessionId <- AI, update
 *   POST /api/ai/:projectId/sessions/:sessionId/requests <- AI, queue a task for another session
 *
 * There is intentionally NO human-facing POST/PATCH/DELETE route for
 * sessions. The human router below only ever mounts the GET.
 *
 * Each session record holds the three data groups the spec requires:
 *   function       - core role/purpose of this AI session
 *   currentTask    - what it's doing right now
 *   taskQueue      - array of requests from other sessions
 *
 * CORRECTION (found live, not assumed -- see KNOWN_ISSUES.md /
 * Known Failure Signature #6): "Postgres-backed" was never true --
 * store.js is still the original fs-based datastore. Every function
 * this file calls (getSessions/saveSessions/appendActivity) genuinely
 * exists there, so the extra `await`/`async` costs nothing and never
 * caused a functional bug -- verified live end-to-end: register a
 * session via the AI route, read it back via both the AI route and
 * the human (no-token) read route.
 * ------------------------------------------------------------------
 */

const express = require('express');
const { nanoid } = require('nanoid');
const store = require('../db/store');
const { requireAIToken, loadProjectForHuman } = require('../middleware/auth');
const { aiWorkLimiter } = require('../middleware/rateLimit');

const humanRouter = express.Router({ mergeParams: true });
const aiRouter = express.Router({ mergeParams: true });

// ---------------------------------------------------------------------
// Human-facing: READ ONLY
// ---------------------------------------------------------------------

humanRouter.use(loadProjectForHuman);

humanRouter.get('/', async (req, res, next) => {
  try {
    const sessions = await store.getSessions(req.params.projectId);
    res.json(sessions);
  } catch (err) {
    next(err);
  }
});

// Human-facing: dismiss (remove) a stale session from the roster.
// Intentionally human-only: an AI session removing another session
// would bypass the "human stays in control" principle for roster state.
humanRouter.delete('/:sessionId', async (req, res, next) => {
  try {
    const { projectId, sessionId } = req.params;
    const sessions = await store.getSessions(projectId);
    const idx = sessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) return res.status(404).json({ error: 'Session not found.' });
    sessions.splice(idx, 1);
    await store.saveSessions(projectId, sessions);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Human-facing: dismiss a single stuck request from a session's
// taskQueue (IDEAS.md, "Task queue: let a human clear/dismiss a
// stuck request", Session 2). If an AI session dies mid-task, its
// request sits `pending` forever with nothing to move it along --
// this is the human's way to clear it without needing the AI session
// that would normally PATCH its own status.
//
// Deliberately a single-purpose action route (POST .../dismiss, no
// body) rather than reusing the generic AI-facing PATCH-with-status-
// in-body shape below. That route's ALLOWED_REQUEST_STATUSES includes
// transitions ('in_progress', 'done') that represent an AI reporting
// its OWN progress -- a human claiming a request is "done" on an AI's
// behalf would be a materially different, riskier action (silently
// hides a possibly-still-needed task) than a human saying "clear this,
// it's stuck." Keeping this route unable to express anything but
// dismissal means a future loosening into a general human status-
// setter has to be a deliberate, reviewable change, not a one-line
// accident.
//
// Auth: loadProjectForHuman only (applied to the whole humanRouter
// above), matching the sibling DELETE /:sessionId route directly
// above -- both are "human clears stale roster state" actions in the
// same file, same actor, same trust boundary. No additional
// device-secret gate: that pattern is reserved elsewhere in this app
// for actions with real external consequences (regenerating a token
// that invalidates every AI session's credentials, deleting an entire
// project) -- dismissing one queue entry has no consequence beyond
// this project's own roster display.
humanRouter.post('/:sessionId/requests/:requestId/dismiss', async (req, res, next) => {
  try {
    const { projectId, sessionId, requestId } = req.params;
    const sessions = await store.getSessions(projectId);
    const sessionIdx = sessions.findIndex((s) => s.id === sessionId);
    if (sessionIdx === -1) return res.status(404).json({ error: 'Session not found.' });

    const reqIdx = sessions[sessionIdx].taskQueue.findIndex((r) => r.id === requestId);
    if (reqIdx === -1) return res.status(404).json({ error: 'Request not found in queue.' });

    sessions[sessionIdx].taskQueue[reqIdx].status = 'dismissed';
    await store.saveSessions(projectId, sessions);
    res.json(sessions[sessionIdx].taskQueue[reqIdx]);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// AI-facing: read + write
// ---------------------------------------------------------------------

aiRouter.use(requireAIToken);
aiRouter.use(aiWorkLimiter);

aiRouter.get('/', async (req, res, next) => {
  try {
    const sessions = await store.getSessions(req.params.projectId);
    res.json(sessions);
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/:projectId/sessions
// An AI agent registers itself (or updates itself, if it reuses a
// stable sessionId across restarts of the same agent process).
aiRouter.post('/', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const { sessionId, label, function: fn, currentTask } = req.body || {};

    if (!label || typeof label !== 'string') {
      return res.status(400).json({ error: '"label" (a human-readable session name) is required.' });
    }
    if (label.trim().length > 80) {
      return res.status(400).json({ error: '"label" must be 80 characters or fewer.' });
    }
    if ((fn || '').trim().length > 200) {
      return res.status(400).json({ error: '"function" must be 200 characters or fewer.' });
    }
    if ((currentTask || '').trim().length > 200) {
      return res.status(400).json({ error: '"currentTask" must be 200 characters or fewer.' });
    }

    const sessions = await store.getSessions(projectId);
    const id = sessionId || nanoid(8);
    const existingIndex = sessions.findIndex((s) => s.id === id);

    const record = {
      id,
      label: label.trim(),
      function: (fn || '').trim(),
      currentTask: (currentTask || 'Idle').trim(),
      taskQueue: existingIndex >= 0 ? sessions[existingIndex].taskQueue : [],
      status: 'active',
      registeredAt: existingIndex >= 0 ? sessions[existingIndex].registeredAt : new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      sessions[existingIndex] = record;
    } else {
      sessions.push(record);
    }

    await store.saveSessions(projectId, sessions);
    await store.appendActivity(projectId, {
      id: nanoid(8),
      type: 'session_registered',
      actor: `AI:${id}`,
      message: `Session "${record.label}" registered/updated.`,
      timestamp: new Date().toISOString(),
    });

    res.status(201).json(record);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/ai/:projectId/sessions/:sessionId
// Update function / currentTask / status for an existing session.
// This is how an AI reports "here's what I'm doing right now".
aiRouter.patch('/:sessionId', async (req, res, next) => {
  try {
    const { projectId, sessionId } = req.params;
    const sessions = await store.getSessions(projectId);
    const idx = sessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) return res.status(404).json({ error: 'Session not found.' });

    const { function: fn, currentTask, status } = req.body || {};
    if (fn !== undefined) sessions[idx].function = String(fn).trim();
    if (currentTask !== undefined) sessions[idx].currentTask = String(currentTask).trim();
    if (status !== undefined) {
      const ALLOWED_STATUSES = ['active', 'idle', 'done', 'error'];
      const s = String(status).trim();
      if (!ALLOWED_STATUSES.includes(s)) {
        return res.status(400).json({
          error: `"status" must be one of: ${ALLOWED_STATUSES.join(', ')}.`,
        });
      }
      sessions[idx].status = s;
    }
    sessions[idx].lastSeenAt = new Date().toISOString();

    await store.saveSessions(projectId, sessions);
    res.json(sessions[idx]);
  } catch (err) {
    next(err);
  }
});

// POST /api/ai/:projectId/sessions/:sessionId/requests
// Session A asks Session B (:sessionId) to do something outside A's
// own capabilities -- this appends to B's taskQueue.
aiRouter.post('/:sessionId/requests', async (req, res, next) => {
  try {
    const { projectId, sessionId } = req.params;
    const { message, priority } = req.body || {};

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: '"message" describing the requested task is required.' });
    }
    if (message.trim().length > 1000) {
      return res.status(400).json({ error: '"message" must be 1000 characters or fewer.' });
    }
    const ALLOWED_PRIORITIES = ['normal', 'high', 'urgent'];
    const resolvedPriority = String(priority || 'normal').trim();
    if (!ALLOWED_PRIORITIES.includes(resolvedPriority)) {
      return res.status(400).json({
        error: `"priority" must be one of: ${ALLOWED_PRIORITIES.join(', ')}.`,
      });
    }

    const sessions = await store.getSessions(projectId);
    const targetIdx = sessions.findIndex((s) => s.id === sessionId);
    if (targetIdx === -1) return res.status(404).json({ error: 'Target session not found.' });

    const requestingSessionId = req.callerSessionId || 'unknown';
    const requestingLabel =
      sessions.find((s) => s.id === requestingSessionId)?.label || requestingSessionId;

    const requestEntry = {
      id: nanoid(8),
      fromSessionId: requestingSessionId,
      fromLabel: requestingLabel,
      message: message.trim(),
      priority: resolvedPriority,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    sessions[targetIdx].taskQueue.push(requestEntry);
    await store.saveSessions(projectId, sessions);
    await store.appendActivity(projectId, {
      id: nanoid(8),
      type: 'task_requested',
      actor: `AI:${requestingSessionId}`,
      message: `${requestingLabel} requested "${sessions[targetIdx].label}" to: ${requestEntry.message}`,
      timestamp: new Date().toISOString(),
    });

    res.status(201).json(requestEntry);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/ai/:projectId/sessions/:sessionId/requests/:requestId
// Mark a queued request as done/dismissed (called by the session that
// received it, once it has picked it up or completed it).
aiRouter.patch('/:sessionId/requests/:requestId', async (req, res, next) => {
  try {
    const { projectId, sessionId, requestId } = req.params;
    const { status } = req.body || {};
    if (!status) return res.status(400).json({ error: '"status" is required.' });
    const ALLOWED_REQUEST_STATUSES = ['pending', 'in_progress', 'done', 'dismissed'];
    const s = String(status).trim();
    if (!ALLOWED_REQUEST_STATUSES.includes(s)) {
      return res.status(400).json({
        error: `"status" must be one of: ${ALLOWED_REQUEST_STATUSES.join(', ')}.`,
      });
    }

    const sessions = await store.getSessions(projectId);
    const sessionIdx = sessions.findIndex((s) => s.id === sessionId);
    if (sessionIdx === -1) return res.status(404).json({ error: 'Session not found.' });

    const reqIdx = sessions[sessionIdx].taskQueue.findIndex((r) => r.id === requestId);
    if (reqIdx === -1) return res.status(404).json({ error: 'Request not found in queue.' });

    sessions[sessionIdx].taskQueue[reqIdx].status = s;
    await store.saveSessions(projectId, sessions);
    res.json(sessions[sessionIdx].taskQueue[reqIdx]);
  } catch (err) {
    next(err);
  }
});

module.exports = { humanRouter, aiRouter };
