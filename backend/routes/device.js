/**
 * routes/device.js
 * ------------------------------------------------------------------
 * Device identity: the permanent code embedded as a fixed prefix in
 * every project token created on this device (see utils/tokens.js
 * and db/store.js). Human-facing only, same trust boundary reasoning
 * as routes/projects.js -- no token required, the device itself is
 * the boundary.
 *
 * CHANGED (Turso reconciliation): the original version of this file
 * called store.getDevice()/store.listProjects() synchronously and
 * did fs.rmSync(store.projectDir(p.id)) directly for the delete
 * cascade -- correct against the JSON-file store.js that was live at
 * the time, but incompatible with the async, Turso-backed store.js
 * this app now uses (no real filesystem, no projectDir()). Ported to
 * async store.* calls throughout.
 *
 * ALSO CHANGED: the delete cascade now scopes to THIS device's own
 * projects (store.listProjectIdsForDevice(code)) rather than every
 * project in the database. The original single-device model made
 * "delete everything" and "delete this device's projects" the same
 * operation, since there was only ever one device. Now that
 * aisapp_devices can hold more than one device's identity (see
 * schema.sql's comment on why a shared Vercel deployment needs this),
 * those two things are no longer the same operation, and only the
 * narrower one (this device's own projects) is what "delete my
 * device identity" should ever mean.
 * ------------------------------------------------------------------
 */

const express = require('express');
const store = require('../db/store');
const { humanSensitiveLimiter } = require('../middleware/rateLimit');
const { requireDeviceSecret } = require('../middleware/auth');

const router = express.Router();

// GET /api/device - view this device's permanent code (or null if none
// exists yet -- it's only created lazily on first project creation, not
// on server boot, so a brand new install with zero projects legitimately
// has no device identity yet).
router.get('/', async (req, res, next) => {
  try {
    const device = await store.getDevice();
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
// Requires { "confirm": true } in the body. A bare DELETE with no body
// is deliberately rejected rather than treated as "confirmed by virtue
// of calling the endpoint," since this is a wider blast radius than
// deleting a single project.
router.delete('/', humanSensitiveLimiter, requireDeviceSecret, async (req, res, next) => {
  try {
    const { confirm } = req.body || {};
    if (confirm !== true) {
      return res.status(400).json({
        error: 'Deleting your device identity deletes every project on ' +
          'this device and cannot be undone. Resend with { "confirm": true } to proceed.',
      });
    }

    const device = await store.getDevice();
    if (!device) {
      return res.status(404).json({ error: 'No device identity exists yet.' });
    }

    // Scoped to THIS device's own projects -- see file header on why
    // this is no longer "every project in the database" now that
    // aisapp_devices can hold more than one device.
    const projectIds = await store.listProjectIdsForDevice(device.code);
    const deletionErrors = [];
    for (const id of projectIds) {
      try {
        // Reuses the already-tested delete path (deletes files rows
        // then the project row -- see store.js's removeProjectFromIndex
        // header on why this doesn't rely on the schema's declared
        // ON DELETE CASCADE).
        await store.removeProjectFromIndex(id);
      } catch (err) {
        deletionErrors.push({ id, error: err.message });
      }
    }
    await store.deleteDevice();

    res.json({
      success: true,
      deletedProjectCount: projectIds.length - deletionErrors.length,
      ...(deletionErrors.length > 0 && { deletionErrors }),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
