/**
 * store.js
 * ------------------------------------------------------------------
 * Turso (libSQL) -backed datastore, replacing the original
 * JSON-file-on-disk implementation.
 *
 * WHY THIS CHANGED FROM JSON FILES: this app moved from a
 * local/Termux deployment to Vercel. Vercel's serverless functions
 * run on a read-only filesystem, and even the one writable path
 * (/tmp) is wiped between invocations and isn't shared across
 * concurrent instances -- every write the old store.js made would
 * either throw or silently vanish.
 *
 * WHY TURSO SPECIFICALLY (over Postgres/Supabase, which this file
 * briefly used instead): project owner's explicit choice. Uses
 * `@tursodatabase/serverless` -- per the turso-db skill, this is the
 * correct package for a Vercel/edge environment specifically (pure
 * `fetch()`, no native bindings), as opposed to `@tursodatabase/database`
 * (native, file-based) or the older `@libsql/client` (legacy package
 * name, per the skill's own warning -- do not reintroduce it).
 *
 * SIZE CAPS: ~100KB per project, ~5MB per account, enforced via
 * SQLite triggers (see db/schema.sql) using RAISE(ABORT, '<tag>:<msg>').
 * Both caps were proven against the REAL Turso/Limbo engine running
 * locally via @tursodatabase/database (the native package makes this
 * possible without needing network access to the actual cloud
 * instance -- same engine, just file-based instead of remote) before
 * this file was written:
 *   - A 150,000-byte single-project write was confirmed rejected.
 *   - An individually-small write that only crossed the ACCOUNT total
 *     (not the per-project cap) was confirmed rejected specifically
 *     by the account trigger, via a distinct RAISE message.
 *   - Same-size and shrinking UPDATEs near the account cap were
 *     confirmed NOT falsely rejected -- the critical correctness
 *     case for the OLD-subtraction arithmetic in the UPDATE triggers.
 *
 * IMPORTANT HONESTY NOTE: the SCHEMA + TRIGGER LOGIC above was
 * proven against the real engine. The actual NETWORK PATH this file
 * uses (@tursodatabase/serverless hitting your real
 * *.turso.io cloud instance) could NOT be tested from the sandboxed
 * environment this was written in -- outbound network access to
 * turso.io is blocked by that environment's egress allowlist, and no
 * working MCP connector was available either. This file was written
 * carefully against the documented Serverless SDK API (see the
 * turso-db skill's "SDK: Serverless" section) and mirrors the exact
 * query patterns already proven correct via the native package
 * locally, but the live cloud connection itself is unverified by me.
 * Test it against your real database before trusting it with real
 * data -- e.g. create a project through the UI and confirm it
 * actually shows up on a page reload.
 *
 * Every exported function name and error class matches what this
 * file exported when it was briefly Postgres-backed, which itself
 * matched the ORIGINAL synchronous JSON-file store.js -- so
 * routes/*.js needed no further changes for this swap.
 * ------------------------------------------------------------------
 */

const { connect } = require('@tursodatabase/serverless');

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
  // Fail loudly and immediately on boot rather than letting every
  // request fail mysteriously later -- a missing env var on Vercel
  // is the single most common deployment mistake, and a clear crash
  // message here is much easier to debug than a generic 500 on the
  // first API call.
  throw new Error(
    'store.js: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set as ' +
      'environment variables. On Vercel: Project Settings -> Environment ' +
      'Variables. Locally: a .env file loaded via dotenv before this module ' +
      'is required. NEVER paste these directly into chat with an AI ' +
      'assistant -- set them directly in Vercel\'s dashboard.'
  );
}

// connect() is synchronous and does no I/O until the first query, per
// the Serverless SDK docs -- safe to create once at module scope and
// reuse across requests within the same warm serverless instance.
const client = connect({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });

const PROJECT_SIZE_LIMIT_BYTES = 100 * 1024; // ~100KB per project
const ACCOUNT_SIZE_LIMIT_BYTES = 5 * 1024 * 1024; // ~5MB whole account
// Leave headroom below the hard cap so proactive trimming (activity
// log) kicks in before the database trigger ever needs to fire.
const PROJECT_SIZE_SOFT_TARGET_BYTES = Math.floor(PROJECT_SIZE_LIMIT_BYTES * 0.9);

class InvalidProjectIdError extends Error {}

class ProjectSizeLimitError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 413;
  }
}

class AccountSizeLimitError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 413;
  }
}

/**
 * SECURITY: preserved from the original store.js. projectId arrives
 * as a raw URL path segment; real projectIds are always nanoid(10)
 * (URL-safe alphabet only). Validating the shape up front and
 * throwing (rather than silently coercing) keeps the same "loud
 * failure, loggable by the caller" philosophy as the rest of this
 * app's security posture.
 */
function assertValidProjectId(projectId) {
  if (typeof projectId !== 'string' || !projectId) {
    throw new InvalidProjectIdError('projectId is required.');
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) {
    throw new InvalidProjectIdError(
      `projectId "${projectId}" has an invalid shape and was blocked.`
    );
  }
}

/**
 * Translates a raw Turso/SQLite trigger error into a clean typed
 * error where possible. Our triggers RAISE(ABORT, 'TAG:message') --
 * TAG is either PROJECT_CAP or ACCOUNT_CAP (see db/schema.sql) so we
 * can tell the two apart and surface the right error class + the
 * human-readable message that follows the colon.
 */
function translateDbError(err) {
  const msg = err?.message || String(err);
  const projectMatch = msg.match(/PROJECT_CAP:(.+?)(?:'|"|$)/);
  if (projectMatch) return new ProjectSizeLimitError(projectMatch[1].trim());
  const accountMatch = msg.match(/ACCOUNT_CAP:(.+?)(?:'|"|$)/);
  if (accountMatch) return new AccountSizeLimitError(accountMatch[1].trim());
  return err;
}

/** Runs a single parameterized statement, translating trigger errors
 *  into typed errors. Returns the raw Turso result ({ rows, ... }). */
async function run(sql, args = []) {
  try {
    return await client.execute(sql, args);
  } catch (err) {
    throw translateDbError(err);
  }
}

/** Real byte size of a project's own row (excludes files -- see
 *  getProjectRowSize below, used by the proactive trimming logic). */
async function getProjectRowSize(projectId) {
  const result = await run(
    `SELECT
       COALESCE((SELECT length(project)+length(sessions)+length(instructions)+length(activity)
                 FROM aisapp_projects WHERE id = ?), 0)
       + COALESCE((SELECT SUM(length(content)) FROM aisapp_files WHERE project_id = ?), 0)
       AS total`,
    [projectId, projectId]
  );
  return result.rows[0]?.total || 0;
}

// ---------------------------------------------------------------------
// Project registry
// ---------------------------------------------------------------------

/**
 * Lightweight index for the project list UI -- matches the original
 * shape (id/name/createdAt only, no token or heavy fields) by
 * pulling just those fields out of the stored `project` JSON blob.
 */
async function listProjects() {
  const result = await run(
    'SELECT id, project FROM aisapp_projects ORDER BY updated_at DESC'
  );
  return result.rows.map((row) => {
    const project = JSON.parse(row.project);
    return { id: project.id || row.id, name: project.name, createdAt: project.createdAt };
  });
}

/** Every project row's id for a specific device, used by the device
 *  delete-cascade (routes/device.js) to scope deletion to just that
 *  device's own projects -- NOT every project on the shared server,
 *  now that aisapp_devices can hold more than one device's identity. */
async function listProjectIdsForDevice(deviceCode) {
  const result = await run('SELECT id FROM aisapp_projects WHERE device_code = ?', [deviceCode]);
  return result.rows.map((row) => row.id);
}

async function addProjectToIndex(projectMeta) {
  assertValidProjectId(projectMeta.id);
  await run('INSERT INTO aisapp_projects (id, device_code, project) VALUES (?, ?, ?)', [
    projectMeta.id,
    projectMeta.deviceCode || null,
    JSON.stringify(projectMeta),
  ]);
  return projectMeta;
}

async function removeProjectFromIndex(projectId) {
  assertValidProjectId(projectId);
  // NOTE: schema.sql declares aisapp_files.project_id as a FOREIGN
  // KEY ... ON DELETE CASCADE, but this is NOT relied upon here.
  // Tested directly during development: SQLite/Turso's `foreign_keys`
  // pragma defaults to OFF (confirmed via `PRAGMA foreign_keys` ->
  // 0), and given the Serverless SDK's fetch()-based, potentially
  // per-request transport, there's no guarantee a `PRAGMA foreign_keys
  // = ON` set on one call would even persist to the next -- relying
  // on that would be the same kind of untested assumption that
  // caused a real bug here (a project delete silently leaving its
  // files behind, caught by testing, not by inspection). Deleting
  // explicitly in both tables is correct regardless of pragma state
  // or connection/session behavior.
  await run('DELETE FROM aisapp_files WHERE project_id = ?', [projectId]);
  await run('DELETE FROM aisapp_projects WHERE id = ?', [projectId]);
}

// ---------------------------------------------------------------------
// Device identity (permanent code, embedded as a fixed prefix in
// every project token created on this device -- see utils/tokens.js's
// generateToken(deviceCode)/generateDeviceCode).
//
// Ported from the pre-Turso JSON-file store.js (single _device.json
// file, one device = one server instance) to a proper keyed table --
// see schema.sql's aisapp_devices comment for why: a shared Vercel
// deployment serves multiple physical devices as clients, so a
// single hardcoded row stops matching reality the way it did for a
// Termux-hosted local server. getOrCreateDeviceCode below preserves
// the EXACT existing single-device contract for now (treats "the
// first/only row" as the answer) so routes/device.js and the current
// frontend need no changes yet -- the table shape just avoids a
// second migration whenever device-code generation moves client-side.
// ---------------------------------------------------------------------

async function getDevice() {
  const result = await run('SELECT code, created_at FROM aisapp_devices ORDER BY created_at ASC LIMIT 1');
  const row = result.rows[0];
  return row ? { code: row.code, createdAt: row.created_at } : null;
}

async function saveDevice(data) {
  await run('INSERT INTO aisapp_devices (code, created_at) VALUES (?, ?)', [
    data.code,
    data.createdAt,
  ]);
  return data;
}

async function deleteDevice() {
  await run('DELETE FROM aisapp_devices');
}

/**
 * Returns this device's permanent code, creating it on first use.
 * Never regenerated once created -- only deleteDevice() removes it,
 * and the next project created after that gets a brand new code.
 * Takes generateDeviceCode as a parameter rather than requiring
 * utils/tokens.js directly, to avoid a require() cycle (tokens.js has
 * no need to depend on store.js, and shouldn't gain one just for this)
 * -- same reasoning as the original JSON-file version of this function.
 */
async function getOrCreateDeviceCode(generateDeviceCode) {
  const existing = await getDevice();
  if (existing) return existing.code;

  const code = generateDeviceCode();
  await saveDevice({ code, createdAt: new Date().toISOString() });
  return code;
}

// ---------------------------------------------------------------------
// Per-project accessors
// ---------------------------------------------------------------------

async function getProject(projectId) {
  assertValidProjectId(projectId);
  const result = await run('SELECT project FROM aisapp_projects WHERE id = ?', [projectId]);
  const row = result.rows[0];
  return row ? JSON.parse(row.project) : null;
}

async function saveProject(projectId, data) {
  assertValidProjectId(projectId);
  await run(
    "UPDATE aisapp_projects SET project = ?, updated_at = datetime('now') WHERE id = ?",
    [JSON.stringify(data), projectId]
  );
  return data;
}

async function getSessions(projectId) {
  assertValidProjectId(projectId);
  const result = await run('SELECT sessions FROM aisapp_projects WHERE id = ?', [projectId]);
  const row = result.rows[0];
  return row ? JSON.parse(row.sessions) : [];
}

async function saveSessions(projectId, sessions) {
  assertValidProjectId(projectId);
  await run(
    "UPDATE aisapp_projects SET sessions = ?, updated_at = datetime('now') WHERE id = ?",
    [JSON.stringify(sessions), projectId]
  );
  return sessions;
}

async function getInstructions(projectId) {
  assertValidProjectId(projectId);
  const result = await run('SELECT instructions FROM aisapp_projects WHERE id = ?', [projectId]);
  const row = result.rows[0];
  return row
    ? JSON.parse(row.instructions)
    : { notes: '', functionalities: [], assignments: [] };
}

async function saveInstructions(projectId, data) {
  assertValidProjectId(projectId);
  await run(
    "UPDATE aisapp_projects SET instructions = ?, updated_at = datetime('now') WHERE id = ?",
    [JSON.stringify(data), projectId]
  );
  return data;
}

async function getActivity(projectId) {
  assertValidProjectId(projectId);
  const result = await run('SELECT activity FROM aisapp_projects WHERE id = ?', [projectId]);
  const row = result.rows[0];
  return row ? JSON.parse(row.activity) : [];
}

/**
 * Trims the activity log (oldest-first, since the log is stored
 * newest-first via unshift -- oldest entries sit at the END of the
 * array) until it's likely to fit within PROJECT_SIZE_SOFT_TARGET_BYTES.
 * Runs BEFORE the write is attempted, so a long-running project's
 * activity log self-manages instead of suddenly hard-rejecting once
 * it crosses 100KB.
 *
 * Deliberately conservative (drops in chunks of 20 rather than one
 * at a time) since re-measuring size is an extra round-trip each
 * time -- trimming a bit more than strictly necessary costs nothing
 * (activity history isn't precious the way a code file is) and
 * avoids a slow one-at-a-time loop under real usage.
 */
async function trimActivityToFit(projectId, candidateLog) {
  let log = candidateLog;
  if (log.length > 1000) log = log.slice(0, 1000);

  // Safety valve: stop trimming at 10 entries even if still over
  // budget -- at that point the problem is almost certainly the
  // OTHER fields (notes, functionalities, files), not the activity
  // log, and we shouldn't silently erase all history chasing a
  // budget it can't fix alone. The write attempt below will surface
  // a clear ProjectSizeLimitError in that case.
  while (log.length > 10) {
    const testActivitySize = Buffer.byteLength(JSON.stringify(log), 'utf-8');
    // getProjectRowSize includes the project's CURRENT (untrimmed)
    // activity too, so adding testActivitySize on top is a
    // deliberate overestimate -- safer to trim a bit more than
    // strictly needed than to under-trim and hit the hard trigger.
    const restEstimate = await getProjectRowSize(projectId);
    if (restEstimate + testActivitySize <= PROJECT_SIZE_SOFT_TARGET_BYTES) break;
    log = log.slice(0, Math.max(10, log.length - 20));
  }
  return log;
}

async function appendActivity(projectId, entry) {
  assertValidProjectId(projectId);
  const current = await getActivity(projectId);
  let log = [entry, ...current]; // newest first, matches original .unshift() ordering
  log = await trimActivityToFit(projectId, log);

  await run(
    "UPDATE aisapp_projects SET activity = ?, updated_at = datetime('now') WHERE id = ?",
    [JSON.stringify(log), projectId]
  );
  return log;
}

module.exports = {
  client,
  InvalidProjectIdError,
  ProjectSizeLimitError,
  AccountSizeLimitError,
  PROJECT_SIZE_LIMIT_BYTES,
  ACCOUNT_SIZE_LIMIT_BYTES,
  assertValidProjectId,
  getProjectRowSize,
  run,
  listProjects,
  listProjectIdsForDevice,
  addProjectToIndex,
  removeProjectFromIndex,
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
