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
 * flipped true by a human-authenticated request. AI-authenticated
 * requests to the approve endpoint are rejected with 403, even if
 * they present a perfectly valid token -- a valid AI token proves
 * "this is an AI I trust to read/write project data", not "this AI is
 * authorized to approve its own assignments", which would defeat the
 * entire point of a human-in-the-loop gate.
 * ------------------------------------------------------------------
 */

const express = require('express');
const { nanoid } = require('nanoid');
const store = require('../db/store');
const { requireAIToken, loadProjectForHuman } = require('../middleware/auth');

const humanRouter = express.Router({ mergeParams: true });
const aiRouter = express.Router({ mergeParams: true });

// ---------------------------------------------------------------------
// Shared read handler
// ---------------------------------------------------------------------

function handleGet(req, res) {
  const data = store.getInstructions(req.params.projectId);
  res.json(data);
}

// ---------------------------------------------------------------------
// Human-facing routes
// ---------------------------------------------------------------------

humanRouter.use(loadProjectForHuman);
humanRouter.get('/', handleGet);

// PUT notes (free-text instructions the human is drafting)
humanRouter.put('/notes', async (req, res) => {
  const { projectId } = req.params;
  const { notes } = req.body || {};
  const data = store.getInstructions(projectId);
  data.notes = typeof notes === 'string' ? notes : data.notes;
  await store.saveInstructions(projectId, data);
  res.json(data);
});

// POST a functionality definition (human drafting what a function should do)
humanRouter.post('/functionalities', async (req, res) => {
  const { projectId } = req.params;
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: '"name" is required.' });

  const data = store.getInstructions(projectId);
  const entry = { id: nanoid(8), name: name.trim(), description: (description || '').trim(), createdAt: new Date().toISOString(), createdBy: 'human' };
  data.functionalities.push(entry);
  await store.saveInstructions(projectId, data);
  res.status(201).json(entry);
});

// POST a proposed assignment (human proposes "give function X to session Y")
humanRouter.post('/assignments', async (req, res) => {
  const { projectId } = req.params;
  const { functionName, sessionId, sessionLabel, reason } = req.body || {};
  if (!functionName || !sessionId) {
    return res.status(400).json({ error: '"functionName" and "sessionId" are required.' });
  }

  const data = store.getInstructions(projectId);
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
});

// THE APPROVAL GATE -- human-only, by construction (mounted on humanRouter,
// never on aiRouter). This is the only path that can set approved: true.
humanRouter.post('/assignments/:assignmentId/approve', async (req, res) => {
  const { projectId, assignmentId } = req.params;
  const data = store.getInstructions(projectId);
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
});

// Human can also reject a proposal outright.
humanRouter.post('/assignments/:assignmentId/reject', async (req, res) => {
  const { projectId, assignmentId } = req.params;
  const data = store.getInstructions(projectId);
  const idx = data.assignments.findIndex((a) => a.id === assignmentId);
  if (idx === -1) return res.status(404).json({ error: 'Assignment not found.' });

  data.assignments[idx].status = 'rejected';
  data.assignments[idx].approved = false;
  data.assignments[idx].decidedAt = new Date().toISOString();
  await store.saveInstructions(projectId, data);
  res.json(data.assignments[idx]);
});

// ---------------------------------------------------------------------
// AI-facing routes: read, and PROPOSE only -- no approve/reject route
// exists on aiRouter at all, so there's nothing for a token to hit.
// ---------------------------------------------------------------------

aiRouter.use(requireAIToken);
aiRouter.get('/', handleGet);

aiRouter.post('/functionalities', async (req, res) => {
  const { projectId } = req.params;
  const { name, description } = req.body || {};
  if (!name) return res.status(400).json({ error: '"name" is required.' });

  const data = store.getInstructions(projectId);
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
});

aiRouter.post('/assignments', async (req, res) => {
  const { projectId } = req.params;
  const { functionName, sessionId, sessionLabel, reason } = req.body || {};
  if (!functionName || !sessionId) {
    return res.status(400).json({ error: '"functionName" and "sessionId" are required.' });
  }

  const data = store.getInstructions(projectId);
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
});

module.exports = { humanRouter, aiRouter };
