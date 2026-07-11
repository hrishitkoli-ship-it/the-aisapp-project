/**
 * routes/device.js
 * ------------------------------------------------------------------
 * Device identity: the permanent 12-char code embedded as a fixed
 * prefix in every project token created on this device (see
 * utils/tokens.js and db/store.js). Human-facing only, same trust
 * boundary reasoning as routes/projects.js -- no token required, the
 * device itself is the boundary.
 * ------------------------------------------------------------------
 */

const express = require('express');
const fs = require('fs');
const store = require('../db/store');
const { generateDeviceCode } = require('../utils/tokens');
const { humanSensitiveLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// GET /api/device - view this device's permanent code (or null if none
// exists yet -- it's only created lazily on first project creation, not
// on server boot, so a brand new install with zero projects legitimately
// has no device identity yet).
router.get('/', (req, res, next) => {
  try {
    const device = store.getDevice();
    res.json(device || { code: null });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/device - delete this device's identity AND every project
// created under it (their tokens embed a code that no longer exists
// anywhere, so they're unauthenticatable regardless -- deleting the
// projects too, rather than leaving them stranded, is what "delete
// cascades" means here). Irreversible: the next project created after
// this gets a brand new, different permanent code.
//
// Requires { "confirm": true } in the body. Same reasoning as project
// deletion's planned confirmation step (see INSTRUCTIONS.md Session 3
// scope notes) -- a bare DELETE with no body is deliberately rejected
// rather than treated as "confirmed by virtue of calling the endpoint,"
// since this is a wider blast radius than deleting a single project.
//
// try/catch + next(err) here (and above) rather than bare async/await:
// this app runs Express 4 (confirmed via package.json), which does NOT
// auto-catch a rejected promise from an async route handler the way
// Express 5 does -- an uncaught throw here previously crashed the
// entire server process, not just this one request (found live during
// this session's own testing: a typo calling a non-existent store
// function took the whole process down). This file is scoped
// defensively; the same gap likely exists across other async route
// handlers in this codebase (projects.js, sessions.js, etc.) but
// retrofitting all of them is outside Session 4's audit-not-rebuild
// scope for this pass -- flagged as a finding, not silently expanded
// into.
router.delete('/', humanSensitiveLimiter, async (req, res, next) => {
  try {
    const { confirm } = req.body || {};
    if (confirm !== true) {
      return res.status(400).json({
        error: 'Deleting your device identity deletes every project on ' +
          'this device and cannot be undone. Resend with { "confirm": true } to proceed.',
      });
    }

    const device = store.getDevice();
    if (!device) {
      return res.status(404).json({ error: 'No device identity exists yet.' });
    }

    const projects = store.listProjects();
    const deletionErrors = [];
    for (const p of projects) {
      // p.id always comes from our own _index.json, written by nanoid(10)
      // at creation time, never from an external request param -- so this
      // isn't the same untrusted-input path the InvalidProjectIdError
      // containment check in store.projectDir() exists for. It still runs
      // regardless of caller, though, so it's wrapped rather than left
      // bare: a hand-edited or corrupted _index.json entry could still
      // trip it, and one bad entry shouldn't abort deleting the rest.
      try {
        fs.rmSync(store.projectDir(p.id), { recursive: true, force: true });
      } catch (err) {
        deletionErrors.push({ id: p.id, error: err.message });
      }
    }
    await store.clearProjectIndex();
    await store.deleteDevice();

    res.json({
      success: true,
      deletedProjectCount: projects.length - deletionErrors.length,
      ...(deletionErrors.length > 0 && { deletionErrors }),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
