/**
 * routes/projects.js
 * ------------------------------------------------------------------
 * Human-facing project management: create a project (which mints its
 * AI token), list all projects, fetch one, regenerate its token, or
 * delete it. These routes are only ever called from the browser UI,
 * so they don't require requireAIToken -- the device itself is the
 * trust boundary, per the "no cloud auth" requirement.
 *
 * CORRECTION (found live, not assumed -- see KNOWN_ISSUES.md): an
 * earlier version of this file's comments described store.js as
 * Turso-backed with a real SQL schema (aisapp_projects table, FK
 * cascades, assertValidProjectId()). None of that exists -- store.js
 * is still the original fs-based JSON datastore (see its own header
 * comment). That mismatch caused two real bugs: new projects were
 * missing from single-item lookups (create only wrote the index row,
 * never the per-project file getProject() actually reads), and
 * delete only removed the index row too, silently leaving the entire
 * per-project directory orphaned on disk despite reporting success.
 * Both are fixed below by calling store.saveProject()/
 * removeProjectDir() explicitly, same as the pre-Turso-attempt
 * version of this file did.
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
      name: name.trim(),
      description: (description || '').trim(),
      deviceCode,
      tokenHash: hashToken(rawToken),
      createdAt: new Date().toISOString(),
      tokenGeneratedAt: new Date().toISOString(),
    };

    // store.js is still the fs-based datastore (see its own header
    // comment) -- NOT Turso-backed, despite what an earlier version of
    // this comment claimed. addProjectToIndex only writes the
    // lightweight list-view row into _index.json; store.getProject()
    // (used by regenerate-token and delete, below) reads a SEPARATE
    // per-project file that nothing else writes. Skipping saveProject
    // here meant a project existed in the list but 404s on every
    // single-project lookup immediately after creation -- found live,
    // not assumed (see KNOWN_ISSUES.md). saveSessions/saveInstructions
    // genuinely don't need an eager call the way saveProject does:
    // store.getSessions()/getInstructions() both default to a sensible
    // empty shape when their file is missing, unlike getProject()'s
    // null-means-404 fallback.
    await store.saveProject(id, project);
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
    if (err instanceof store.AccountSizeLimitError) {
      return res.status(413).json({ error: err.message });
    }
    next(err);
  }
});

// GET /api/projects - list all projects (no secrets included).
//
// REGRESSION FIX (Session 4, 2nd occurrence -- see KNOWN_ISSUES.md for
// the full writeup): this exact leak (tokenHash returned in the clear
// to any unauthenticated caller) was found and fixed once already this
// session, then came back when this file was independently rewritten
// to fix the separate project.json/removeProjectDir bugs, working from
// a base that predated the first fix. Re-applying here. See
// KNOWN_ISSUES.md for why this is being logged there too this time,
// not just fixed silently -- a fix that isn't visible outside the diff
// itself is exactly the kind of thing that's easy to lose again in the
// next rewrite of this same actively-churning file.
router.get('/', async (req, res, next) => {
  try {
    const index = await store.listProjects();
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

    const deviceCode = project.deviceCode || (await store.getOrCreateDeviceCode(generateDeviceCode));
    const rawToken = generateToken(deviceCode);
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
      deviceCode,
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

    // store.js is fs-based, not Turso -- there is no FK cascade.
    // removeProjectFromIndex only drops the _index.json row; the
    // actual per-project directory (project.json, sessions.json,
    // instructions.json, files/) needs its own explicit removal, or
    // "delete" silently leaves everything on disk while claiming
    // success -- found live, not assumed (see KNOWN_ISSUES.md). This
    // is also the exact call site Session 4 found genuinely
    // vulnerable to a path-traversal projectId (KFS #2) -- projectDir()
    // (called inside removeProjectDir) still validates before
    // touching the filesystem, same as it always did, but gets its
    // own explicit catch here (rather than relying on the central
    // handler) for the same specific logging the getProject() lookup
    // above already gets.
    try {
      store.removeProjectDir(projectId);
    } catch (err) {
      if (err instanceof store.InvalidProjectIdError) {
        logBlockedProjectIdAttempt(req, 'delete', err);
        return res.status(400).json({ error: 'Invalid project id.' });
      }
      throw err;
    }
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
