/**
 * routes/projects.js
 * ------------------------------------------------------------------
 * Human-facing project management: create a project (which mints its
 * AI token), list all projects, fetch one, regenerate its token, or
 * delete it. These routes are only ever called from the browser UI,
 * so they don't require requireAIToken -- the device itself is the
 * trust boundary, per the "no cloud auth" requirement.
 * ------------------------------------------------------------------
 */

const express = require('express');
const { nanoid } = require('nanoid');
const store = require('../db/store');
const { generateToken, generateDeviceCode, hashToken } = require('../utils/tokens');

const router = express.Router();

/**
 * SECURITY: store.projectDir() (called internally by getProject(),
 * regenerate, and delete below) now throws InvalidProjectIdError for any
 * projectId that would resolve outside PROJECTS_ROOT -- see db/store.js
 * for the full writeup of what this closes. Every route below that reads
 * req.params.projectId needs to catch that throw specifically and fail
 * closed with a clean 400, instead of letting it become an unhandled
 * 500. Mirrors how routes/files.js already catches PathSafetyError from
 * fileOps.js's safeResolve() -- same shape, same "log it, don't just
 * swallow it" reasoning, so a human watching the activity timeline can
 * see someone (or something) tried to walk out of the sandbox.
 *
 * Best-effort only: if projectId is malicious, there is no real project
 * whose activity.json we can safely write into (that's the whole point
 * of the block), so this logs to the ROOT-level activity concept instead
 * of a per-project one. There is no root activity log today -- rather
 * than invent one for a single call site, this logs to the server
 * console, which is the one sink that's always safe to write to
 * regardless of what projectId contained. A future session wiring up a
 * proper root-level security log (outside a single project) can replace
 * this without touching the containment logic itself.
 */
function logBlockedProjectIdAttempt(req, action, err) {
  console.warn(
    `[security] Blocked a ${action} attempt with an unsafe projectId ` +
    `(path: "${req.params.projectId}"): ${err.message}`
  );
}

// POST /api/projects  { name, description }
// Creates a new project folder + metadata + a fresh AI token.
router.post('/', async (req, res, next) => {
  const { name, description } = req.body || {};

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Project "name" is required.' });
  }

  try {
    const id = nanoid(10);
    const deviceCode = await store.getOrCreateDeviceCode(generateDeviceCode);
    const rawToken = generateToken(deviceCode);

    const project = {
      id,
      name: name.trim(),
      description: (description || '').trim(),
      deviceCode,
      tokenHash: hashToken(rawToken),
      createdAt: new Date().toISOString(),
      tokenGeneratedAt: new Date().toISOString(),
    };

    // Scaffold the on-disk structure for this project.
    store.ensureProjectFilesDir(id);
    await store.saveProject(id, project);
    await store.saveSessions(id, []);
    await store.saveInstructions(id, { notes: '', functionalities: [], assignments: [] });
    await store.appendActivity(id, {
      id: nanoid(8),
      type: 'project_created',
      actor: 'human',
      message: `Project "${project.name}" created.`,
      timestamp: new Date().toISOString(),
    });

    await store.addProjectToIndex({ id, name: project.name, createdAt: project.createdAt });

    // The raw token is returned exactly once, here at creation time.
    res.status(201).json({
      ...stripSecret(project),
      token: rawToken,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/projects - list all projects (no secrets included).
router.get('/', (req, res) => {
  const index = store.listProjects();
  res.json(index);
});

// GET /api/projects/:projectId - fetch one project's metadata (no token).
router.get('/:projectId', (req, res) => {
  let project;
  try {
    project = store.getProject(req.params.projectId);
  } catch (err) {
    if (err instanceof store.InvalidProjectIdError) {
      logBlockedProjectIdAttempt(req, 'read', err);
      return res.status(400).json({ error: 'Invalid project id.' });
    }
    throw err;
  }
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  res.json(stripSecret(project));
});

// POST /api/projects/:projectId/regenerate-token
// Invalidates the old token immediately and returns a new raw token once.
// The device code embedded in the token is preserved -- only the key
// portion rotates. (Projects created before the device-code split have
// no deviceCode field; this backfills it from the device identity
// rather than erroring, so pre-existing projects keep working.)
router.post('/:projectId/regenerate-token', async (req, res, next) => {
  const { projectId } = req.params;
  try {
    let project;
    try {
      project = store.getProject(projectId);
    } catch (err) {
      if (err instanceof store.InvalidProjectIdError) {
        logBlockedProjectIdAttempt(req, 'regenerate-token', err);
        return res.status(400).json({ error: 'Invalid project id.' });
      }
      throw err;
    }
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    const deviceCode = project.deviceCode || (await store.getOrCreateDeviceCode(generateDeviceCode));
    const rawToken = generateToken(deviceCode);
    const updated = {
      ...project,
      deviceCode,
      tokenHash: hashToken(rawToken),
      tokenGeneratedAt: new Date().toISOString(),
    };
    await store.saveProject(projectId, updated);
    await store.appendActivity(projectId, {
      id: nanoid(8),
      type: 'token_regenerated',
      actor: 'human',
      message: 'AI token regenerated. The previous token is now invalid.',
      timestamp: new Date().toISOString(),
    });

    res.json({ ...stripSecret(updated), token: rawToken });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/projects/:projectId - remove a project entirely.
router.delete('/:projectId', async (req, res, next) => {
  const { projectId } = req.params;
  try {
    let project;
    try {
      project = store.getProject(projectId);
    } catch (err) {
      if (err instanceof store.InvalidProjectIdError) {
        logBlockedProjectIdAttempt(req, 'delete', err);
        return res.status(400).json({ error: 'Invalid project id.' });
      }
      throw err;
    }
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    // store.projectDir() throws InvalidProjectIdError under the same
    // condition as the getProject() call above, so in practice this can't
    // hit the catch below without the earlier one having already caught
    // it first -- but this is the exact call site the Session 4 audit
    // found actually vulnerable (unsuffixed, unlike getProject()'s
    // internal jsonPath() call), so it gets its own explicit guard rather
    // than relying on that being true forever as this file changes.
    try {
      store.projectDir(projectId);
    } catch (err) {
      if (err instanceof store.InvalidProjectIdError) {
        logBlockedProjectIdAttempt(req, 'delete', err);
        return res.status(400).json({ error: 'Invalid project id.' });
      }
      throw err;
    }

    store.removeProjectDir(projectId);
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
