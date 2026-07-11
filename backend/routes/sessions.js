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
 * CHANGED: store.getSessions()/saveSessions() are now async
 * (Postgres-backed). Every call site got `await` + async handlers
 * with try/catch -> next(err). The read-only-for-humans structure
 * (which router mounts what) is untouched.
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
    if (status !== undefined) sessions[idx].status = String(status).trim();
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
      priority: priority || 'normal',
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

    const sessions = await store.getSessions(projectId);
    const sessionIdx = sessions.findIndex((s) => s.id === sessionId);
    if (sessionIdx === -1) return res.status(404).json({ error: 'Session not found.' });

    const reqIdx = sessions[sessionIdx].taskQueue.findIndex((r) => r.id === requestId);
    if (reqIdx === -1) return res.status(404).json({ error: 'Request not found in queue.' });

    sessions[sessionIdx].taskQueue[reqIdx].status = status;
    await store.saveSessions(projectId, sessions);
    res.json(sessions[sessionIdx].taskQueue[reqIdx]);
  } catch (err) {
    next(err);
  }
});

module.exports = { humanRouter, aiRouter };
