/**
 * routes/activity.js
 * ------------------------------------------------------------------
 * Read-only timeline of everything that's happened in a project:
 * file writes/deletes, session registrations, task requests,
 * assignment proposals/approvals, token regeneration, etc.
 * Both humans and AIs can read this (it's genuinely useful for an
 * AI agent to see recent history too), nobody writes to it directly
 * -- entries are appended internally by the other route modules via
 * store.appendActivity().
 * ------------------------------------------------------------------
 */

const express = require('express');
const store = require('../db/store');
const { requireAIToken, loadProjectForHuman } = require('../middleware/auth');

const humanRouter = express.Router({ mergeParams: true });
const aiRouter = express.Router({ mergeParams: true });

async function handleGet(req, res, next) {
  try {
    const { projectId } = req.params;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
    const log = (await store.getActivity(projectId)).slice(0, limit);
    res.json(log);
  } catch (err) {
    next(err);
  }
}

humanRouter.use(loadProjectForHuman);
humanRouter.get('/', handleGet);

aiRouter.use(requireAIToken);
aiRouter.get('/', handleGet);

module.exports = { humanRouter, aiRouter };
