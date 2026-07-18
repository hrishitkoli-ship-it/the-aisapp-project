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

const crypto = require('crypto');
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
// The serverless SDK requires https:// not libsql:// -- convert if needed.
// Also strip any stray quote characters that may have been copied into the env var.
const tursoUrl = TURSO_DATABASE_URL.replace(/^libsql:\/\//, 'https://').replace(/['"]/g, '').trim();
const client = connect({ url: tursoUrl, authToken: TURSO_AUTH_TOKEN });

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
 * Thrown when a query references a column or table that schema.sql
 * declares but the LIVE database doesn't actually have -- this
 * project's own recurring failure mode (see Session Ledger: an
 * earlier live incident where the Turso schema had simply never been
 * applied). Without this, that class of error surfaces as an opaque
 * "Internal server error." with the real cause visible only in
 * server-side logs the person reporting the bug usually can't see.
 * statusCode 500 (not 503) deliberately -- this isn't a transient
 * "try again" condition, it needs a schema fix, and 503 would
 * misleadingly suggest otherwise to a caller retrying automatically.
 */
class SchemaDriftError extends Error {
  constructor(message) {
    super(
      `Database schema is out of date: ${message}. schema.sql declares ` +
        'this, but the live database doesn\'t have it -- someone needs to ' +
        'apply the current schema.sql (or the missing ALTER TABLE) via the ' +
        'Turso dashboard SQL console. This is a server configuration issue, ' +
        'not something wrong with your request.'
    );
    this.statusCode = 500;
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
 *
 * ALSO detects "no such column"/"no such table" -- standard SQLite
 * error phrasing, verified against a real local libSQL engine (not
 * assumed) -- and wraps it as SchemaDriftError instead of letting it
 * pass through as an opaque generic error. Added while investigating
 * a live "Internal server error" report on project creation; couldn't
 * confirm this specific pattern IS what's happening live without
 * server-side log access, but it's this project's own documented
 * recurring failure mode, and hardening it here makes it immediately
 * diagnosable from the response alone if it's the cause now or ever
 * recurs for a different column/table later.
 */
function translateDbError(err) {
  const msg = err?.message || String(err);
  const projectMatch = msg.match(/PROJECT_CAP:(.+?)(?:'|"|$)/);
  if (projectMatch) return new ProjectSizeLimitError(projectMatch[1].trim());
  const accountMatch = msg.match(/ACCOUNT_CAP:(.+?)(?:'|"|$)/);
  if (accountMatch) return new AccountSizeLimitError(accountMatch[1].trim());
  const schemaMatch = msg.match(/no such (?:column|table): ([\w.]+)/i);
  if (schemaMatch) return new SchemaDriftError(schemaMatch[0]);
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
  const result = await run(
    'SELECT code, created_at, device_secret_hash, tos_accepted_at FROM aisapp_devices ORDER BY created_at ASC LIMIT 1'
  );
  const row = result.rows[0];
  return row
    ? {
        code: row.code,
        createdAt: row.created_at,
        deviceSecretHash: row.device_secret_hash || null,
        tosAcceptedAt: row.tos_accepted_at || null,
      }
    : null;
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
 * Sets device_secret_hash on the existing device row via UPDATE --
 * NOT the JSON-object-spread merge pattern an earlier, now-obsolete
 * version of this feature used (built against the old fs-JSON store,
 * before this Turso migration landed; that version's "spread the
 * existing object first" reasoning doesn't apply to a real SQL row --
 * there's no risk of accidentally clobbering `code`/`created_at` here,
 * since UPDATE only touches the column named). Requires a device row
 * to already exist (i.e. getOrCreateDeviceCode must have run at least
 * once) -- see getOrCreateDeviceSecretHash below for how the caller
 * handles the "no device yet at all" case.
 */
async function setDeviceSecretHash(code, hash) {
  await run('UPDATE aisapp_devices SET device_secret_hash = ? WHERE code = ?', [hash, code]);
}

/**
 * Returns { hash, raw?, isNew } for this device's write-gate secret,
 * creating one (and, if necessary, the device row itself) on first
 * use. See middleware/auth.js's requireDeviceSecret for why this is
 * lazy rather than a hard boot-time requirement, and
 * utils/tokens.js's generateDeviceSecret for why this must be a
 * value independent from the device code itself.
 *
 * Handles a genuinely new case the old fs-JSON version never needed
 * to: a Turso-backed device row might not exist AT ALL yet (no
 * project has ever been created on this Turso database), unlike the
 * old version where getDevice()/saveDevice() operated on a single
 * local file that either existed or didn't, with no "created but
 * incomplete" state possible mid-write. Here, if no row exists,
 * this creates one with BOTH a fresh device code AND the secret in
 * one INSERT, rather than trying to UPDATE a row that isn't there yet.
 */
async function getOrCreateDeviceSecretHash(generateDeviceCode, generateDeviceSecret, hashSecret) {
  const existing = await getDevice();

  if (existing && existing.deviceSecretHash) {
    return { hash: existing.deviceSecretHash, isNew: false };
  }

  const raw = generateDeviceSecret();
  const hash = hashSecret(raw);

  if (existing) {
    // Device row exists (has a code already) but no secret yet --
    // UPDATE just the new column, code/created_at untouched.
    await setDeviceSecretHash(existing.code, hash);
  } else {
    // No device row at all -- create one with a fresh code AND the
    // secret together, single INSERT.
    const code = generateDeviceCode();
    await run('INSERT INTO aisapp_devices (code, created_at, device_secret_hash) VALUES (?, ?, ?)', [
      code,
      new Date().toISOString(),
      hash,
    ]);
  }

  return { hash, raw, isNew: true };
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

/**
 * Marks this device's Terms & Privacy as accepted. Idempotent --
 * accepting twice just updates the timestamp, no error.
 */
async function acceptTos(deviceCode) {
  await run('UPDATE aisapp_devices SET tos_accepted_at = ? WHERE code = ?', [
    new Date().toISOString(),
    deviceCode,
  ]);
}

/** True only if this device exists AND has explicitly accepted. A
 *  device that doesn't exist yet (shouldn't normally happen for a
 *  file-write call, since creating the project that owns the file
 *  already required a device to exist -- see routes/projects.js) is
 *  treated as NOT accepted, failing closed rather than open. */
async function hasAcceptedTos(deviceCode) {
  if (!deviceCode) return false;
  const result = await run('SELECT tos_accepted_at FROM aisapp_devices WHERE code = ?', [deviceCode]);
  return !!result.rows[0]?.tos_accepted_at;
}

/** Same check as hasAcceptedTos, but for callers that haven't (and
 *  can't yet) resolved a deviceCode -- specifically, project creation
 *  itself, which is the ONE place a ToS gate needs to run before a
 *  device row is guaranteed to exist by anything upstream of it, per
 *  spec (#16: acceptance required before the first project can be
 *  created, not just before the first file write). Reads the single/
 *  first device row directly via getDevice(), matching that
 *  function's own already-established single-device contract (see
 *  its header comment) rather than introducing a second, different
 *  device-resolution strategy. No device row at all -> false, same
 *  fail-closed behavior as hasAcceptedTos(undefined). */
async function hasDeviceAcceptedTos() {
  const device = await getDevice();
  return !!device?.tosAcceptedAt;
}

// ---------------------------------------------------------------------
// Migration blobs (see schema.sql's aisapp_migration_blobs comment for
// the full design). Fixed size ceiling enforced here in application
// code rather than a DB trigger, since these rows are deliberately
// outside the per-project/per-account size-cap system above -- a
// trigger written against THOSE limits would be the wrong limit for
// a completely different kind of data.
// ---------------------------------------------------------------------

const MIGRATION_BLOB_MAX_BYTES = 50 * 1024; // 50KB -- generous for a handful of tokens, not a data-smuggling route
const MIGRATION_BLOB_TTL_MINUTES = 10;

class MigrationBlobTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 413;
  }
}

async function createMigrationBlob(ciphertext) {
  const byteSize = Buffer.byteLength(ciphertext, 'utf-8');
  if (byteSize > MIGRATION_BLOB_MAX_BYTES) {
    throw new MigrationBlobTooLargeError(
      `Migration payload is ${byteSize} bytes; the limit is ${MIGRATION_BLOB_MAX_BYTES} bytes ` +
        '(this is meant for a few tokens/notes, not bulk data).'
    );
  }

  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const expiresAt = new Date(Date.now() + MIGRATION_BLOB_TTL_MINUTES * 60 * 1000).toISOString();
  await run('INSERT INTO aisapp_migration_blobs (id, ciphertext, expires_at) VALUES (?, ?, ?)', [
    id,
    ciphertext,
    expiresAt,
  ]);
  return { id, expiresAt };
}

/**
 * Fetches and IMMEDIATELY DELETES a migration blob (single-use).
 * Returns null if it never existed, already expired, or was already
 * consumed -- callers can't distinguish these three cases from the
 * return value alone, which is deliberate: telling an attacker
 * "that ID never existed" vs. "that ID expired" vs. "that ID was
 * already used" leaks more than a human redeeming their own link
 * ever needs to know.
 *
 * CORRECTED (Session 4, found during a general bug-hunt pass, not
 * assumed from reading -- verified against a real local libSQL engine
 * before and after): this used to run a separate
 * `SELECT ... WHERE expires_at > datetime('now')` followed by an
 * unconditional `DELETE ... WHERE id = ?`. Two independent bugs:
 *
 *   1. `expires_at` is stored as `new Date(...).toISOString()`
 *      ('2026-07-17T14:33:01.456Z' -- 'T' separator, milliseconds, 'Z').
 *      SQLite's `datetime('now')` produces '2026-07-17 14:33:01' --
 *      space separator, no ms, no 'Z'. Comparing these as plain SQL
 *      strings is a lexicographic comparison, and 'T' (0x54) sorts
 *      AFTER ' ' (0x20) -- so for any expiry on the same UTC calendar
 *      day as "now" (i.e. essentially always, given a 10-minute TTL),
 *      `expires_at > datetime('now')` evaluated true REGARDLESS OF THE
 *      ACTUAL TIME. The TTL was pure decoration; nothing ever expired
 *      on its own. Confirmed empirically (not just reasoned about) --
 *      a blob with `expires_at` 5 minutes in the past was still
 *      returned as valid by the old query, every time, in a real
 *      engine test.
 *   2. The SELECT and DELETE were two separate awaited round-trips,
 *      not one atomic operation -- two concurrent requests for the
 *      same id could both pass the SELECT before either's DELETE
 *      landed, both receiving the ciphertext. This violates the
 *      single-use guarantee this function's own docstring (and
 *      routes/migration.js's, and migration.js's) explicitly promise.
 *
 * Fixed by collapsing to one atomic `DELETE ... RETURNING` -- the row
 * is removed unconditionally on id match in a single round-trip (no
 * race window), then expiry is checked in JS via `new Date(...)`,
 * which parses both formats unambiguously and sidesteps the string-
 * comparison format mismatch entirely rather than trying to make the
 * SQL-side comparison correct instead.
 */
async function consumeMigrationBlob(id) {
  const result = await run(
    'DELETE FROM aisapp_migration_blobs WHERE id = ? RETURNING ciphertext, expires_at',
    [id]
  );
  const row = result.rows[0];
  if (!row) return null;
  const isExpired = new Date(row.expires_at).getTime() <= Date.now();
  return isExpired ? null : row.ciphertext;
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
  SchemaDriftError,
  MigrationBlobTooLargeError,
  PROJECT_SIZE_LIMIT_BYTES,
  ACCOUNT_SIZE_LIMIT_BYTES,
  MIGRATION_BLOB_MAX_BYTES,
  MIGRATION_BLOB_TTL_MINUTES,
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
  getOrCreateDeviceSecretHash,
  setDeviceSecretHash,
  acceptTos,
  hasAcceptedTos,
  hasDeviceAcceptedTos,
  createMigrationBlob,
  consumeMigrationBlob,
  getProject,
  saveProject,
  getSessions,
  saveSessions,
  getInstructions,
  saveInstructions,
  getActivity,
  appendActivity,
};

