/**
 * store.js
 * ------------------------------------------------------------------
 * A tiny, dependency-free JSON-file datastore.
 *
 * WHY NOT SQLITE: better-sqlite3 / sqlite3 require native compilation
 * (node-gyp, a C++ toolchain, Python). On Termux / mobile IDEs that
 * toolchain is often missing or painful to install. Plain JSON files
 * read/written through `fs` work identically on every platform Node
 * runs on, with zero native deps. For a single-user local tool, the
 * performance ceiling of JSON-on-disk is nowhere near a concern.
 *
 * Every project gets its own folder under /projects/<projectId>/:
 *   project.json    -> project metadata + AI token (hashed)
 *   sessions.json   -> AI Session Roster data
 *   instructions.json -> instructions + function-assignment gate
 *   activity.json   -> changelog / timeline of file edits
 *   files/          -> the actual workspace file tree
 *
 * All reads/writes go through this module so callers never touch
 * fs directly and we get one place to add file-locking style
 * protections (see withFileLock below).
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const PROJECTS_ROOT = path.join(__dirname, '..', '..', 'projects');

// Ensure the root projects directory exists on boot.
if (!fs.existsSync(PROJECTS_ROOT)) {
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

class InvalidProjectIdError extends Error {}

/**
 * SECURITY: projectId arrives as a raw URL path segment on every route
 * (human and AI alike) and was previously joined straight into a
 * filesystem path with no containment check -- unlike in-project file
 * paths, which already go through fileOps.js's safeResolve(). A
 * projectId like "../../../../etc" (reachable over HTTP: Express
 * decodes %2F in route params before handlers ever see them) would
 * resolve projectDir() outside PROJECTS_ROOT entirely. Most routes were
 * accidentally safe anyway because getProject() appends a fixed
 * "project.json" suffix after the join, so a traversal only succeeds if
 * a real project.json-shaped file happens to already exist at the
 * traversed destination -- but DELETE /api/projects/:projectId calls
 * projectDir() a second time, UNSUFFIXED, for the actual
 * fs.rmSync(..., { recursive: true, force: true }). If that coincidence
 * ever lines up, the delete route recursively force-deletes whatever
 * real directory the traversal points to. Confirmed via isolated /tmp
 * proof-of-concept during Session 4's audit -- not theoretical.
 *
 * Fix mirrors fileOps.js's safeResolve() philosophy exactly: verify
 * containment, and THROW rather than silently stripping "../" and
 * continuing -- a caller trying to walk out of the sandbox is exactly
 * the kind of thing that should surface as a loggable, visible failure
 * (see routes/projects.js), not be quietly rewritten into "worked fine."
 *
 * Real projectIds are always nanoid(10) (URL-safe alphabet only, no "/"
 * or "." possible), so this rejects everything a legitimate caller would
 * never send in the first place.
 */
function projectDir(projectId) {
  if (typeof projectId !== 'string' || !projectId) {
    throw new InvalidProjectIdError('projectId is required.');
  }
  const resolved = path.resolve(PROJECTS_ROOT, projectId);
  if (resolved !== PROJECTS_ROOT && !resolved.startsWith(PROJECTS_ROOT + path.sep)) {
    throw new InvalidProjectIdError(
      `projectId "${projectId}" resolves outside the projects root and was blocked.`
    );
  }
  return resolved;
}

function projectFilesDir(projectId) {
  return path.join(projectDir(projectId), 'files');
}

function jsonPath(projectId, name) {
  return path.join(projectDir(projectId), `${name}.json`);
}

/** Read a JSON file, returning `fallback` if it doesn't exist or is corrupt. */
function readJSON(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    // Corrupt file should never crash the server -- log and fall back.
    console.error(`[store] Failed to read ${filePath}:`, err.message);
    return fallback;
  }
}

/** Write JSON atomically-ish: write to temp file then rename, to reduce
 *  the chance of a half-written file if the process is killed mid-write
 *  (a real risk on mobile where the OS may kill backgrounded apps). */
function writeJSON(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * A very small in-process mutex per project, so two rapid API calls
 * (e.g. the user editing and an AI pushing at the same moment) can't
 * interleave reads/writes of the same JSON file and clobber each
 * other. This does NOT solve cross-process concurrency (out of scope
 * for a single local Node process) but it does solve the realistic
 * case of overlapping requests within this server.
 */
const locks = new Map(); // key -> Promise chain

function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn); // run fn regardless of prior rejection
  locks.set(key, next.catch(() => {})); // keep chain alive even on error
  return next;
}

// ---------------------------------------------------------------------
// Project registry (list of all projects, lives at projects/_index.json)
// ---------------------------------------------------------------------

const INDEX_PATH = path.join(PROJECTS_ROOT, '_index.json');

function listProjects() {
  return readJSON(INDEX_PATH, []);
}

function saveProjectIndex(index) {
  writeJSON(INDEX_PATH, index);
}

function addProjectToIndex(projectMeta) {
  return withLock('_index', () => {
    const index = listProjects();
    index.push(projectMeta);
    saveProjectIndex(index);
    return projectMeta;
  });
}

function removeProjectFromIndex(projectId) {
  return withLock('_index', () => {
    const index = listProjects().filter((p) => p.id !== projectId);
    saveProjectIndex(index);
  });
}

/** Empties the project registry entirely. Used only by the delete-device
 *  cascade (routes/device.js), where every project is being removed at
 *  once -- deliberately separate from removeProjectFromIndex's
 *  filter-one-out semantics rather than looping that per project. */
function clearProjectIndex() {
  return withLock('_index', () => {
    saveProjectIndex([]);
  });
}

// ---------------------------------------------------------------------
// Device identity (permanent 12-char code, lives at projects/_device.json)
//
// One per device install, generated once on first project creation,
// never regenerated -- only deletion removes it. Every project created
// on this device stamps its token with this same code as a fixed
// prefix, so a human's identity is stable across every project they
// create, while each project still gets its own independently
// rotatable key portion (see utils/tokens.js).
// ---------------------------------------------------------------------

const DEVICE_PATH = path.join(PROJECTS_ROOT, '_device.json');

function getDevice() {
  return readJSON(DEVICE_PATH, null);
}

function saveDevice(data) {
  return withLock('_device', () => {
    writeJSON(DEVICE_PATH, data);
    return data;
  });
}

function deleteDevice() {
  return withLock('_device', () => {
    if (fs.existsSync(DEVICE_PATH)) fs.rmSync(DEVICE_PATH);
  });
}

/**
 * Returns this device's permanent 12-char code, creating it on first
 * use. Never regenerated once created -- only deleteDevice() removes
 * it, and the next project created after that gets a brand new code.
 * Takes generateDeviceCode as a parameter rather than requiring
 * utils/tokens.js directly, to avoid a require() cycle (tokens.js has
 * no need to depend on store.js, and shouldn't gain one just for this).
 */
async function getOrCreateDeviceCode(generateDeviceCode) {
  const existing = getDevice();
  if (existing) return existing.code;

  const code = generateDeviceCode();
  await saveDevice({ code, createdAt: new Date().toISOString() });
  return code;
}

// ---------------------------------------------------------------------
// Per-project accessors
// ---------------------------------------------------------------------

function getProject(projectId) {
  return readJSON(jsonPath(projectId, 'project'), null);
}

function saveProject(projectId, data) {
  return withLock(`project:${projectId}`, () => {
    writeJSON(jsonPath(projectId, 'project'), data);
    return data;
  });
}

function getSessions(projectId) {
  return readJSON(jsonPath(projectId, 'sessions'), []);
}

function saveSessions(projectId, sessions) {
  return withLock(`sessions:${projectId}`, () => {
    writeJSON(jsonPath(projectId, 'sessions'), sessions);
    return sessions;
  });
}

function getInstructions(projectId) {
  return readJSON(jsonPath(projectId, 'instructions'), {
    notes: '',
    functionalities: [],
    assignments: [],
  });
}

function saveInstructions(projectId, data) {
  return withLock(`instructions:${projectId}`, () => {
    writeJSON(jsonPath(projectId, 'instructions'), data);
    return data;
  });
}

function getActivity(projectId) {
  return readJSON(jsonPath(projectId, 'activity'), []);
}

function appendActivity(projectId, entry) {
  return withLock(`activity:${projectId}`, () => {
    const log = getActivity(projectId);
    log.unshift(entry); // newest first
    // Cap the log so it can't grow unbounded on a long-running project.
    const trimmed = log.slice(0, 1000);
    writeJSON(jsonPath(projectId, 'activity'), trimmed);
    return trimmed;
  });
}

module.exports = {
  PROJECTS_ROOT,
  InvalidProjectIdError,
  projectDir,
  projectFilesDir,
  withLock,
  listProjects,
  addProjectToIndex,
  removeProjectFromIndex,
  clearProjectIndex,
  getDevice,
  saveDevice,
  deleteDevice,
  getOrCreateDeviceCode,
  getProject,
  saveProject,
  getSessions,
  saveSessions,
  getInstructions,
  saveInstructions,
  getActivity,
  appendActivity,
};
