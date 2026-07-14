/**
 * routes/projects.js
 * ------------------------------------------------------------------
 * Human-facing project management: create a project (which mints its
 * AI token), list all projects, fetch one, regenerate its token, or
 * delete it. These routes are only ever called from the browser UI,
 * so they don't require requireAIToken -- the device itself is the
 * trust boundary, per the "no cloud auth" requirement.
 *
 * CHANGED: the original fs.mkdirSync(store.projectFilesDir(id)) /
 * fs.rmSync(dir, {recursive:true}) calls are GONE. There's no
 * directory to scaffold anymore -- inserting a row into
 * aisapp_projects (via store.addProjectToIndex, below) already
 * creates its `sessions`/`instructions`/`activity` columns with
 * their schema defaults (see db/schema.sql). Deleting a project
 * (store.removeProjectFromIndex) explicitly deletes its aisapp_files
 * rows first, then the project row -- NOT via the schema's declared
 * ON DELETE CASCADE, which was tested and found unreliable (SQLite's
 * foreign_keys pragma defaults off, and isn't safely assumed to
 * persist across the Serverless SDK's request-scoped transport). See
 * store.js's removeProjectFromIndex for the full explanation.
 *
 * The store.projectDir() security check (guarding the OLD
 * unsuffixed-path delete vulnerability Session 4 found) is also
 * gone, because there's no second unsuffixed filesystem call left
 * to protect -- store.removeProjectFromIndex() does scoped
 * `DELETE ... WHERE id = ?` / `WHERE project_id = ?` calls with
 * parameterized binds (never string-concatenated), which cannot
 * resolve "outside" anything the way a real path could.
 * assertValidProjectId() (called internally by every store.js
 * function) still rejects a malformed projectId up front, preserving
 * the same "fail closed on a bad id" property this file's original
 * comment cared about.
 * ------------------------------------------------------------------
 */

const express = require('express');
const { nanoid } = require('nanoid');
const store = require('../db/store');
const { generateToken, generateDeviceCode, hashToken, generateEncryptionKey, composeToken } = require('../utils/tokens');

const router = express.Router();

/** Logs a blocked malformed-projectId attempt. Best-effort only: if
 *  projectId itself is malformed, there's no real per-project row to
 *  attribute this to, so (same as the original) this logs to the
 *  server console rather than inventing a root-level activity log. */
function logBlockedProjectIdAttempt(req, action, err) {
  console.warn(
    `[security] Blocked a ${action} attempt with an unsafe projectId ` +
    `(path: "${req.params.projectId}"): ${err.message}`
  );
}

// POST /api/projects  { name, description }
// Creates a new project row + metadata + a fresh AI token.
router.post('/', async (req, res, next) => {
  try {
    const { name, description } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Project "name" is required.' });
    }

    const id = nanoid(10);
    // This device's permanent identity code -- created once, on the
    // very first project ever created (on this shared server; see
    // schema.sql's aisapp_devices comment on why "device" here still
    // means "this server instance" for now, not yet "this specific
    // browser," and store.js's getOrCreateDeviceCode for the
    // create-once-never-regenerate contract).
    const deviceCode = await store.getOrCreateDeviceCode(generateDeviceCode);
    const rawToken = generateToken(deviceCode);
    // Generated once, shown once (below), NEVER stored -- see tokens.js
    // header for why the server has no legitimate use for this even
    // hashed. If lost, the caller loses decrypt capability for any
    // content it wrote, same failure mode as losing any other secret;
    // regenerate-token issues a NEW key too (see that route below),
    // meaning content encrypted under the old key becomes unreadable
    // via the new composite token -- this is a real, known tradeoff
    // of not storing the key anywhere, not an oversight.
    const encryptionKey = generateEncryptionKey();

    const project = {
      id,
      deviceCode,
      name: name.trim(),
      description: (description || '').trim(),
      tokenHash: hashToken(rawToken),
      createdAt: new Date().toISOString(),
      tokenGeneratedAt: new Date().toISOString(),
    };

    // addProjectToIndex INSERTs the row; sessions/instructions/activity
    // columns get their schema defaults automatically (empty array,
    // empty-shaped instructions object, empty array respectively) --
    // no separate saveSessions/saveInstructions calls needed for an
    // empty new project the way the old fs-based version required
    // (each was a separate file that had to exist on disk).
    await store.addProjectToIndex(project);
    await store.appendActivity(id, {
      id: nanoid(8),
      type: 'project_created',
      actor: 'human',
      message: `Project "${project.name}" created.`,
      timestamp: new Date().toISOString(),
    });

    // The raw composite token (auth + encryption key) is returned
    // exactly once, here at creation time.
    res.status(201).json({
      ...stripSecret(project),
      token: composeToken(rawToken, encryptionKey),
    });
  } catch (err) {
    // Same bug class as files.js's write handler (see that file's
    // comment): store.AccountSizeLimitError doesn't exist on the
    // currently-live store.js, so instanceof against it throws instead
    // of evaluating to false, which would crash this handler the same
    // way before ever reaching next(err). Generic statusCode check
    // instead, matching app.js's already-reconciled central handler.
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    next(err);
  }
});

// GET /api/projects - list all projects (no secrets included).
router.get('/', async (req, res, next) => {
  try {
    const index = await store.listProjects();
    //
    // SECURITY FIX (Session 4, applied here too as defense-in-depth):
    // this route's own comment always said "no secrets included," and
    // store.listProjects() here already only extracts id/name/createdAt
    // from the stored project blob -- so this stripSecret() call is a
    // no-op today. Adopting it anyway: it's the same pattern already
    // used correctly by the other three routes below (GET /:id,
    // regenerate-token, and implicitly by delete), and it means a
    // future change to listProjects() that accidentally widens what it
    // returns still can't leak tokenHash through this specific route.
    res.json(index.map(stripSecret));
  } catch (err) {
    next(err);
  }
});

// GET /api/projects/:projectId - fetch one project's metadata (no token).
router.get('/:projectId', async (req, res, next) => {
  try {
    let project;
    try {
      project = await store.getProject(req.params.projectId);
    } catch (err) {
      if (err instanceof store.InvalidProjectIdError) {
        logBlockedProjectIdAttempt(req, 'read', err);
        return res.status(400).json({ error: 'Invalid project id.' });
      }
      throw err;
    }
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    res.json(stripSecret(project));
  } catch (err) {
    next(err);
  }
});

// POST /api/projects/:projectId/regenerate-token
// Invalidates the old token immediately and returns a new raw token once.
router.post('/:projectId/regenerate-token', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    let project;
    try {
      project = await store.getProject(projectId);
    } catch (err) {
      if (err instanceof store.InvalidProjectIdError) {
        logBlockedProjectIdAttempt(req, 'regenerate-token', err);
        return res.status(400).json({ error: 'Invalid project id.' });
      }
      throw err;
    }
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    // Reuse THIS project's existing device code -- not a fresh
    // getOrCreateDeviceCode() call, which would be correct anyway
    // (same device, same server, same code either way) but reading
    // it directly off the project record avoids an extra query and
    // stays correct even if this project somehow predates the device
    // system (deviceCode undefined -> generateToken's no-arg fallback).
    const rawToken = generateToken(project.deviceCode);
    // A fresh key too -- see the creation route's comment on why this
    // is a real tradeoff (content encrypted under the OLD key becomes
    // unreadable with the new composite token) rather than an
    // oversight. Regenerating token but keeping the old key isn't an
    // option since the key is never stored server-side at all to
    // "keep" -- it only ever existed in whatever composite token was
    // last shown.
    const encryptionKey = generateEncryptionKey();
    const updated = {
      ...project,
      tokenHash: hashToken(rawToken),
      tokenGeneratedAt: new Date().toISOString(),
    };
    await store.saveProject(projectId, updated);
    await store.appendActivity(projectId, {
      id: nanoid(8),
      type: 'token_regenerated',
      actor: 'human',
      message: 'AI token regenerated. The previous token (and its content-encryption key) is now invalid.',
      timestamp: new Date().toISOString(),
    });

    res.json({ ...stripSecret(updated), token: composeToken(rawToken, encryptionKey) });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/projects/:projectId - remove a project entirely.
router.delete('/:projectId', async (req, res, next) => {
  try {
    const { projectId } = req.params;
    let project;
    try {
      project = await store.getProject(projectId);
    } catch (err) {
      if (err instanceof store.InvalidProjectIdError) {
        logBlockedProjectIdAttempt(req, 'delete', err);
        return res.status(400).json({ error: 'Invalid project id.' });
      }
      throw err;
    }
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    // store.removeProjectFromIndex() explicitly deletes aisapp_files
    // rows first, then the project row -- NOT via the schema's
    // declared ON DELETE CASCADE (see that function's own comment in
    // store.js for why: SQLite/Turso's foreign_keys pragma defaults
    // off, and isn't safely assumed to persist across the Serverless
    // SDK's request-scoped transport). Matches this file's own header
    // comment above -- a prior version of THIS specific comment
    // claimed the opposite (relying on FK cascade), which contradicted
    // both the header and the actual store.js code; corrected here.
    await store.removeProjectFromIndex(projectId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/** Never send tokenHash to the client -- it's an internal secret. */
function stripSecret(project) {
  const { tokenHash, ...rest } = project;
  return rest;
}

module.exports = router;
