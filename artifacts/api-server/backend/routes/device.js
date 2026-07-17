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
const { generateDeviceCode } = require('../utils/tokens');

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

// POST /api/device/accept-tos - marks this device's Terms & Privacy as
// accepted. Called from the Settings page. Idempotent.
//
// CORRECTED (Session 4, same pass that added the project-creation ToS
// gate in routes/projects.js): this used to 404 on a device-less fresh
// install ("create a project first") -- which was directly circular
// once project creation itself started requiring acceptance first. A
// person landing here BECAUSE creation blocked them couldn't actually
// accept, since accepting required a device that (by definition, in
// that exact path) didn't exist yet. Now lazily creates the device row
// via the same getOrCreateDeviceCode(generateDeviceCode) pattern
// routes/projects.js already uses, rather than requiring one to
// pre-exist -- so accepting ToS works as a person's genuine first-ever
// action on a brand new install, not just as a recovery step after
// creation already failed once.
//
// Deliberately NOT behind requireDeviceSecret, unlike DELETE below --
// different risk profile, not an oversight. requireDeviceSecret exists
// to stop an attacker from DESTROYING or taking over someone else's
// device/projects (see SECURITY.md §3b); calling this endpoint against
// a device that isn't yours only flips that device's own consent flag
// and grants the caller no capability they didn't already have (file
// writes on that device were already reachable with no token before
// this existed, same as today) -- there's nothing here worth gating
// the same way as an irreversible delete or a token-invalidating
// regenerate. That reasoning is unchanged by this fix -- only the
// device-must-preexist requirement was wrong.
router.post('/accept-tos', async (req, res, next) => {
  try {
    const code = await store.getOrCreateDeviceCode(generateDeviceCode);
    await store.acceptTos(code);
    res.json({ success: true, acceptedAt: new Date().toISOString() });
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

