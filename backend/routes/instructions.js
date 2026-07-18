/**
 * routes/instructions.js
 * ------------------------------------------------------------------
 * Page 3: Instructions & Functionalities.
 *
 * Both humans and AIs can read/propose here, EXCEPT for one thing:
 * only the human can approve a function assignment. This is the
 * "Function Assignment Gate" from the spec -- an AI (or the human)
 * can PROPOSE "assign function X to session Y", which is stored with
 * status: 'pending', but the assignment's `approved` flag can only be
 * flipped true by a human-authenticated request. There is no
 * AI-facing approve/reject route at all (verified live: an AI token
 * hitting the approve path gets a 404, not a 403 -- the route
 * structurally doesn't exist on aiRouter, rather than existing and
 * rejecting on a permission check that a bug could someday bypass).
 *
 * CORRECTION (found live, not assumed -- see KNOWN_ISSUES.md /
 * Known Failure Signature #6): a prior version of this comment also
 * claimed "Postgres-backed" -- never true, store.js is still the
 * original fs-based datastore. Every function this file calls
 * genuinely exists there, so this never caused a functional bug --
 * verified live end-to-end: notes update, an AI functionality
 * proposal, an AI assignment proposal, the AI-side approve 404 above,
 * and confirming the human approval actually persists
 * (approved: true). This file's security property never depended on
 * sync vs async, only on aiRouter never mounting an approve/reject
 * route, which remains true exactly as before.
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
// Shared read handler
// ---------------------------------------------------------------------

async function handleGet(req, res, next) {
  try {
    const data = await store.getInstructions(req.params.projectId);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------
// Human-facing routes
// ---------------------------------------------------------------------

humanRouter.use(loadProjectForHuman);
humanRouter.get('/', handleGet);

// PUT notes (free-text instructions the human is drafting)
humanRouter.put('/notes', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const { notes } = req.body || {};
    const data = await store.getInstructions(projectId);
    data.notes = typeof notes === 'string' ? notes : data.notes;
    await store.saveInstructions(projectId, data);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST a functionality definition (human drafting what a function should do)
humanRouter.post('/functionalities', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const { name, description } = req.body || {};
    if (!name) return res.status(400).json({ error: '"name" is required.' });
    if (name.trim().length > 80) {
      return res.status(400).json({ error: '"name" must be 80 characters or fewer.' });
    }
    if ((description || '').trim().length > 500) {
      return res.status(400).json({ error: '"description" must be 500 characters or fewer.' });
    }

    const data = await store.getInstructions(projectId);
    const entry = { id: nanoid(8), name: name.trim(), description: (description || '').trim(), createdAt: new Date().toISOString(), createdBy: 'human' };
    data.functionalities.push(entry);
    await store.saveInstructions(projectId, data);
    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
});

// POST a proposed assignment (human proposes "give function X to session Y")
humanRouter.post('/assignments', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const { functionName, sessionId, sessionLabel, reason } = req.body || {};
    if (!functionName || !sessionId) {
      return res.status(400).json({ error: '"functionName" and "sessionId" are required.' });
    }

    // Verify the target session actually exists -- a dangling assignment
    // (approved: true, sessionId points to a session that doesn't exist)
    // is confusing and gives the UI nothing to render against.
    const sessions = await store.getSessions(projectId);
    if (!sessions.find((s) => s.id === sessionId)) {
      return res.status(404).json({ error: `Session "${sessionId}" not found in this project.` });
    }

    const data = await store.getInstructions(projectId);
    const entry = {
      id: nanoid(8),
      functionName: functionName.trim(),
      sessionId,
      sessionLabel: sessionLabel || sessionId,
      reason: (reason || '').trim(),
      proposedBy: 'human',
      status: 'pending',
      approved: false,
      createdAt: new Date().toISOString(),
      decidedAt: null,
    };
    data.assignments.push(entry);
    await store.saveInstructions(projectId, data);
    await store.appendActivity(projectId, {
      id: nanoid(8),
      type: 'assignment_proposed',
      actor: 'human',
      message: `Proposed assigning "${entry.functionName}" to ${entry.sessionLabel}.`,
      timestamp: new Date().toISOString(),
    });
    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
});

// THE APPROVAL GATE -- human-only, by construction (mounted on humanRouter,
// never on aiRouter). This is the only path that can set approved: true.
humanRouter.post('/assignments/:assignmentId/approve', async (req, res, next) => {
  try {
    const { projectId, assignmentId } = req.params;
    const data = await store.getInstructions(projectId);
    const idx = data.assignments.findIndex((a) => a.id === assignmentId);
    if (idx === -1) return res.status(404).json({ error: 'Assignment not found.' });

    data.assignments[idx].status = 'approved';
    data.assignments[idx].approved = true;
    data.assignments[idx].decidedAt = new Date().toISOString();
    await store.saveInstructions(projectId, data);
    await store.appendActivity(projectId, {
      id: nanoid(8),
      type: 'assignment_approved',
      actor: 'human',
      message: `Approved: "${data.assignments[idx].functionName}" -> ${data.assignments[idx].sessionLabel}.`,
      timestamp: new Date().toISOString(),
    });
    res.json(data.assignments[idx]);
  } catch (err) {
    next(err);
  }
});

// Human can also reject a proposal outright.
humanRouter.post('/assignments/:assignmentId/reject', async (req, res, next) => {
  try {
    const { projectId, assignmentId } = req.params;
    const data = await store.getInstructions(projectId);
    const idx = data.assignments.findIndex((a) => a.id === assignmentId);
    if (idx === -1) return res.status(404).json({ error: 'Assignment not found.' });

    data.assignments[idx].status = 'rejected';
    data.assignments[idx].approved = false;
    data.assignments[idx].decidedAt = new Date().toISOString();
    await store.saveInstructions(projectId, data);
    res.json(data.assignments[idx]);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------
// AI-facing routes: read, and PROPOSE only -- no approve/reject route
// exists on aiRouter at all, so there's nothing for a token to hit.
// ---------------------------------------------------------------------

aiRouter.use(requireAIToken);
aiRouter.use(aiWorkLimiter);
aiRouter.get('/', handleGet);

aiRouter.post('/functionalities', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const { name, description } = req.body || {};
    if (!name) return res.status(400).json({ error: '"name" is required.' });
    if (name.trim().length > 80) {
      return res.status(400).json({ error: '"name" must be 80 characters or fewer.' });
    }
    if ((description || '').trim().length > 500) {
      return res.status(400).json({ error: '"description" must be 500 characters or fewer.' });
    }

    const data = await store.getInstructions(projectId);
    const entry = {
      id: nanoid(8),
      name: name.trim(),
      description: (description || '').trim(),
      createdAt: new Date().toISOString(),
      createdBy: `AI:${req.callerSessionId || 'unknown'}`,
    };
    data.functionalities.push(entry);
    await store.saveInstructions(projectId, data);
    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
});

aiRouter.post('/assignments', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    const { functionName, sessionId, sessionLabel, reason } = req.body || {};
    if (!functionName || !sessionId) {
      return res.status(400).json({ error: '"functionName" and "sessionId" are required.' });
    }

    // Same session-existence check as the human route -- an AI proposing an
    // assignment for a session that doesn't exist creates a dangling record.
    const sessions = await store.getSessions(projectId);
    if (!sessions.find((s) => s.id === sessionId)) {
      return res.status(404).json({ error: `Session "${sessionId}" not found in this project.` });
    }

    const data = await store.getInstructions(projectId);
    const entry = {
      id: nanoid(8),
      functionName: functionName.trim(),
      sessionId,
      sessionLabel: sessionLabel || sessionId,
      reason: (reason || '').trim(),
      proposedBy: `AI:${req.callerSessionId || 'unknown'}`,
      status: 'pending', // AI proposals ALWAYS start pending; only humanRouter can flip this.
      approved: false,
      createdAt: new Date().toISOString(),
      decidedAt: null,
    };
    data.assignments.push(entry);
    await store.saveInstructions(projectId, data);
    await store.appendActivity(projectId, {
      id: nanoid(8),
      type: 'assignment_proposed',
      actor: entry.proposedBy,
      message: `Proposed assigning "${entry.functionName}" to ${entry.sessionLabel}. Awaiting human approval.`,
      timestamp: new Date().toISOString(),
    });
    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
});

module.exports = { humanRouter, aiRouter };
