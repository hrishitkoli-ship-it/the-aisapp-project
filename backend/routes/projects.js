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
const fs = require('fs');
const { nanoid } = require('nanoid');
const store = require('../db/store');
const { generateToken, hashToken } = require('../utils/tokens');

const router = express.Router();

// POST /api/projects  { name, description }
// Creates a new project folder + metadata + a fresh AI token.
router.post('/', async (req, res) => {
  const { name, description } = req.body || {};

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Project "name" is required.' });
  }

  const id = nanoid(10);
  const rawToken = generateToken();

  const project = {
    id,
    name: name.trim(),
    description: (description || '').trim(),
    tokenHash: hashToken(rawToken),
    createdAt: new Date().toISOString(),
    tokenGeneratedAt: new Date().toISOString(),
  };

  // Scaffold the on-disk structure for this project.
  fs.mkdirSync(store.projectFilesDir(id), { recursive: true });
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
});

// GET /api/projects - list all projects (no secrets included).
router.get('/', (req, res) => {
  const index = store.listProjects();
  res.json(index);
});

// GET /api/projects/:projectId - fetch one project's metadata (no token).
router.get('/:projectId', (req, res) => {
  const project = store.getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  res.json(stripSecret(project));
});

// POST /api/projects/:projectId/regenerate-token
// Invalidates the old token immediately and returns a new raw token once.
router.post('/:projectId/regenerate-token', async (req, res) => {
  const { projectId } = req.params;
  const project = store.getProject(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });

  const rawToken = generateToken();
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
    message: 'AI token regenerated. The previous token is now invalid.',
    timestamp: new Date().toISOString(),
  });

  res.json({ ...stripSecret(updated), token: rawToken });
});

// DELETE /api/projects/:projectId - remove a project entirely.
router.delete('/:projectId', async (req, res) => {
  const { projectId } = req.params;
  const project = store.getProject(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found.' });

  fs.rmSync(store.projectDir(projectId), { recursive: true, force: true });
  await store.removeProjectFromIndex(projectId);
  res.json({ success: true });
});

/** Never send tokenHash to the client -- it's an internal secret. */
function stripSecret(project) {
  const { tokenHash, ...rest } = project;
  return rest;
}

module.exports = router;
