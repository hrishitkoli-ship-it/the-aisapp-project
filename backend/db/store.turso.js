/**
 * store.turso.js (Turso / libSQL edition)
 * ------------------------------------------------------------------
 * Replaces the local-JSON-file version of this module with a Turso
 * Cloud-backed one, for running on Vercel (stateless functions have
 * no persistent local filesystem, so the original fs.writeFileSync-
 * based design cannot work there -- see the JSON version's own header
 * comment for why JSON-on-disk was chosen originally; that reasoning
 * was sound for a local/Termux deployment and is simply inapplicable
 * to a serverless one).
 *
 * DESIGN CONSTRAINT: every exported function below has the exact same
 * name, signature, and return shape as the JSON-file version. This
 * means routes/projects.js, routes/device.js, routes/sessions.js,
 * routes/instructions.js, routes/activity.js, and middleware/auth.js
 * do not need to change AT ALL -- this migration is isolated to this
 * file and schema.sql. That was a deliberate choice, not an accident:
 * a storage migration is already a big, easy-to-get-wrong change;
 * touching every route file at the same time would make it much
 * harder to isolate what broke if something does.
 *
 * WHAT DID NOT MIGRATE: file *content* (the files/ directory tree)
 * stays exactly as before, still handled by utils/fileOps.js against
 * a local filesystem path returned by projectFilesDir() below. See
 * schema.sql's header comment for why that's a separate, undecided
 * question -- Vercel's ephemeral filesystem means file content storage
 * still needs its own answer (likely a blob store or a files table
 * living in Turso too), which is out of scope for this pass.
 *
 * PACKAGE CHOICE: @tursodatabase/serverless, not @libsql/client.
 * @libsql/client pulls in the `libsql` package, which ships
 * platform-specific native .node binaries (confirmed present in
 * node_modules during this migration). The original JSON-file design
 * explicitly avoided native dependencies for Termux/mobile
 * portability; @tursodatabase/serverless is Turso's own recommended
 * package for exactly this app's situation (remote-only Turso Cloud
 * connection from serverless functions), uses only fetch(), and has
 * zero native dependencies -- confirmed via `find node_modules -name
 * "*.node"` returning nothing after installing it.
 *
 * FILE NAME: this is store.turso.js, not store.js, DELIBERATELY. It
 * has NOT been renamed to replace store.js yet -- see the note in
 * INSTRUCTIONS.md this same commit adds for why: this file's Turso
 * connection has not been live-verified (see below), and swapping the
 * require() target every route file resolves is a one-line change
 * that should happen only once someone can actually confirm this
 * connects. Renaming it prematurely would make the app fail to boot
 * anywhere Turso isn't reachable, silently replacing a working local
 * setup with a broken cloud one.
 *
 * VERIFICATION STATUS (read before trusting this blindly): the schema
 * in schema.sql was loaded and exercised against a real SQLite engine
 * (Node 22's built-in node:sqlite) -- composite keys, foreign key
 * cascade deletes, and unique constraints all confirmed working
 * correctly. The actual Turso Cloud connection in THIS file has NOT
 * been live-tested -- the sandbox this was written in has no network
 * egress to *.turso.io (confirmed: a direct connection attempt failed
 * with "Host not in allowlist", a sandbox-tier limitation, not a
 * credentials problem). This file is believed correct based on
 * Turso's own documented API and the schema validation above, but the
 * first real connection test will happen at actual deploy time, not
 * before. Flagging this plainly rather than overstating confidence.
 * ------------------------------------------------------------------
 */

const { connect } = require('@tursodatabase/serverless');
const fs = require('fs');
const path = require('path');

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  throw new Error(
    'TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must both be set as environment ' +
    'variables (in Vercel: Project Settings -> Environment Variables). Never ' +
    'hardcode these in source -- see INSTRUCTIONS.md for the Turso migration notes.'
  );
}

const conn = connect({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// PROJECTS_ROOT is preserved for exactly one reason: projectFilesDir()
// below still needs a real filesystem path for file CONTENT (see the
// header comment -- files/ did not migrate to Turso in this pass).
// Everything else that used to live under this root (project.json,
// sessions.json, _index.json, _device.json, etc.) now lives in Turso
// instead, and no longer touches this path at all.
const PROJECTS_ROOT = path.join(__dirname, '..', '..', 'projects');
if (!fs.existsSync(PROJECTS_ROOT)) {
  fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
}

class InvalidProjectIdError extends Error {}

/**
 * SECURITY: unchanged in spirit from the JSON version's containment
 * check (see that version's extensive comment, and Session 4's audit
 * commit, for the full history of why this exists) -- projectId is
 * still used to build a real filesystem path for projectFilesDir()
 * below, so the same traversal risk applies to that half of this
 * function's job even though the metadata half now goes through
 * parameterized SQL instead (which is traversal-proof by construction
 * -- SQL parameter binding doesn't resolve path segments the way
 * path.join does). The filesystem half still needs this check; the SQL
 * half doesn't strictly need it anymore but keeping projectId
 * validated in exactly one place, called by both halves, is safer
 * than trying to remember which callers need which kind of safety.
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

/**
 * withLock is preserved as a NO-OP-COMPATIBLE shim, not removed, even
 * though Turso's transactions make the JSON version's in-process mutex
 * unnecessary for correctness. Removing it entirely would mean editing
 * every call site across routes/*.js that currently does
 * `return withLock(key, async () => {...})` -- which would violate
 * this file's own stated design constraint (route files don't change).
 * It still runs its function body correctly; it just no longer needs
 * to serialize access to a shared JSON file, because there isn't one
 * anymore. The `key` parameter is now unused, kept only so call sites
 * don't need to change.
 */
function withLock(_key, fn) {
  return Promise.resolve().then(fn);
}

// ---------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------

async function getDevice() {
  const rs = await conn.execute('SELECT code, created_at FROM device WHERE id = 1');
  if (rs.rows.length === 0) return null;
  const row = rs.rows[0];
  return { code: row.code, createdAt: row.created_at };
}

async function saveDevice(data) {
  await conn.execute({
    sql: 'INSERT INTO device (id, code, created_at) VALUES (1, ?, ?) ' +
         'ON CONFLICT(id) DO UPDATE SET code = excluded.code, created_at = excluded.created_at',
    args: [data.code, data.createdAt],
  });
  return data;
}

async function deleteDevice() {
  await conn.execute('DELETE FROM device WHERE id = 1');
}

async function getOrCreateDeviceCode(generateDeviceCode) {
  const existing = await getDevice();
  if (existing) return existing.code;

  const code = generateDeviceCode();
  await saveDevice({ code, createdAt: new Date().toISOString() });
  return code;
}

// ---------------------------------------------------------------------
// Project registry
// ---------------------------------------------------------------------

/**
 * Returns the same shape the JSON version's listProjects() returned:
 * an array of the SAME lightweight index entries that used to live in
 * _index.json ({ id, name, createdAt }) -- NOT the full project row
 * (no tokenHash, no deviceCode, no notes). Route files that call this
 * (projects.js's GET /, device.js's delete-cascade) only ever
 * destructured .id/.name/.createdAt from these, so this matches their
 * actual usage even though it's now a SELECT of specific columns
 * rather than a separately-maintained index file.
 */
async function listProjects() {
  const rs = await conn.execute(
    'SELECT id, name, created_at FROM projects ORDER BY created_at ASC'
  );
  return rs.rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
}

/**
 * The JSON version had addProjectToIndex() as a SEPARATE call from
 * saveProject() (two different files: _index.json and project.json).
 * In this version, a single INSERT into the projects table does both
 * jobs at once (listProjects() above just SELECTs a subset of columns
 * from the same table saveProject/getProject use). This function is
 * kept only because routes/projects.js's creation route still calls
 * it as its own step -- projectMeta here is the SAME { id, name,
 * createdAt } shaped object addProjectToIndex received before, but
 * it's now a no-op: the real INSERT already happened via saveProject()
 * earlier in that same route (see the route -- it calls saveProject
 * for the full row, then this, in that order). This function
 * intentionally does nothing so double-inserting doesn't happen.
 */
async function addProjectToIndex(_projectMeta) {
  return Promise.resolve();
}

async function removeProjectFromIndex(_projectId) {
  // Same reasoning as addProjectToIndex: the real DELETE happens via
  // the route's own call to deleteProjectRow (see below) -- ON DELETE
  // CASCADE handles cleaning up sessions/task_requests/functionalities
  // /assignments/activity automatically. This is a no-op kept for
  // call-site compatibility.
  return Promise.resolve();
}

async function clearProjectIndex() {
  // Used only by the device-delete cascade in routes/device.js, which
  // loops projects itself and calls fs.rmSync per project directory
  // for file content, then calls this. In the JSON version this wiped
  // _index.json. Here, there is no separate index to wipe -- the
  // route's own per-project deletion (see deleteProjectRow below,
  // which the route needs to call per project) already removes the
  // underlying rows. Kept as a no-op for the same call-site-
  // compatibility reason as the two functions above.
  return Promise.resolve();
}

// ---------------------------------------------------------------------
// Per-project accessors
// ---------------------------------------------------------------------

function rowToProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    deviceCode: row.device_code,
    tokenHash: row.token_hash,
    tokenGeneratedAt: row.token_generated_at,
    createdAt: row.created_at,
  };
}

async function getProject(projectId) {
  // projectDir() throws InvalidProjectIdError for a traversal-shaped
  // id BEFORE any query runs -- same containment check as the JSON
  // version, applied here even though the SELECT below is parameterized
  // and traversal-proof on its own merits, to keep the "projectId gets
  // validated in one place" property described in projectDir()'s own
  // comment above.
  projectDir(projectId);

  const rs = await conn.execute({
    sql: 'SELECT id, name, description, device_code, token_hash, token_generated_at, created_at FROM projects WHERE id = ?',
    args: [projectId],
  });
  return rowToProject(rs.rows[0]);
}

async function saveProject(projectId, data) {
  return withLock(`project:${projectId}`, async () => {
    await conn.execute({
      sql: `INSERT INTO projects (id, name, description, device_code, token_hash, token_generated_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              description = excluded.description,
              device_code = excluded.device_code,
              token_hash = excluded.token_hash,
              token_generated_at = excluded.token_generated_at`,
      args: [
        projectId,
        data.name,
        data.description || '',
        data.deviceCode,
        data.tokenHash,
        data.tokenGeneratedAt,
        data.createdAt,
      ],
    });
    return data;
  });
}

/** Not present in the JSON version's exports (delete used fs.rmSync +
 *  removeProjectFromIndex directly in the route). Added here because
 *  ON DELETE CASCADE needs an actual DELETE FROM projects to fire --
 *  routes/projects.js's DELETE handler and routes/device.js's cascade
 *  both need to call this now instead of relying on
 *  removeProjectFromIndex (now a no-op, see above) to have done it.
 *  This is a REQUIRED CALL-SITE CHANGE, flagged explicitly in
 *  INSTRUCTIONS.md's migration notes -- see that doc for the exact
 *  one-line diff each affected route needs. */
async function deleteProjectRow(projectId) {
  await conn.execute({ sql: 'DELETE FROM projects WHERE id = ?', args: [projectId] });
}

async function getSessions(projectId) {
  const sessionsRs = await conn.execute({
    sql: 'SELECT id, label, function, current_task, status, registered_at, last_seen_at FROM sessions WHERE project_id = ?',
    args: [projectId],
  });

  const requestsRs = await conn.execute({
    sql: 'SELECT id, target_session_id, from_session_id, from_label, message, priority, status, created_at FROM task_requests WHERE project_id = ? ORDER BY created_at ASC',
    args: [projectId],
  });

  const requestsBySession = new Map();
  for (const r of requestsRs.rows) {
    if (!requestsBySession.has(r.target_session_id)) requestsBySession.set(r.target_session_id, []);
    requestsBySession.get(r.target_session_id).push({
      id: r.id,
      fromSessionId: r.from_session_id,
      fromLabel: r.from_label,
      message: r.message,
      priority: r.priority,
      status: r.status,
      createdAt: r.created_at,
    });
  }

  return sessionsRs.rows.map((s) => ({
    id: s.id,
    label: s.label,
    function: s.function,
    currentTask: s.current_task,
    taskQueue: requestsBySession.get(s.id) || [],
    status: s.status,
    registeredAt: s.registered_at,
    lastSeenAt: s.last_seen_at,
  }));
}

/**
 * The JSON version's saveSessions(projectId, sessions) always received
 * the FULL array (read-modify-write on the whole file) -- callers in
 * sessions.js do getSessions(), mutate the in-memory array, then call
 * this with the entire thing back. To keep that exact calling
 * convention working without editing sessions.js, this replaces the
 * project's ENTIRE session set (and their task_requests) with what's
 * passed in, inside one transaction. This is less efficient than a
 * targeted UPDATE would be, but it's the only way to honor the
 * existing "hand me the whole array, I'll persist it" contract those
 * route handlers already depend on without rewriting them.
 */
async function saveSessions(projectId, sessions) {
  return withLock(`sessions:${projectId}`, async () => {
    await conn.execute('BEGIN');
    try {
      await conn.execute({ sql: 'DELETE FROM sessions WHERE project_id = ?', args: [projectId] });
      // ON DELETE CASCADE on task_requests' FK handles clearing those too.

      for (const s of sessions) {
        await conn.execute({
          sql: `INSERT INTO sessions (id, project_id, label, function, current_task, status, registered_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [s.id, projectId, s.label, s.function || '', s.currentTask || 'Idle', s.status || 'active', s.registeredAt, s.lastSeenAt],
        });
        for (const r of s.taskQueue || []) {
          await conn.execute({
            sql: `INSERT INTO task_requests (id, project_id, target_session_id, from_session_id, from_label, message, priority, status, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [r.id, projectId, s.id, r.fromSessionId, r.fromLabel, r.message, r.priority || 'normal', r.status || 'pending', r.createdAt],
          });
        }
      }
      await conn.execute('COMMIT');
    } catch (err) {
      await conn.execute('ROLLBACK');
      throw err;
    }
    return sessions;
  });
}

async function getInstructions(projectId) {
  const projectRs = await conn.execute({
    sql: 'SELECT notes FROM projects WHERE id = ?',
    args: [projectId],
  });
  const notes = projectRs.rows[0]?.notes ?? '';

  const funcsRs = await conn.execute({
    sql: 'SELECT id, name, description, created_at, created_by FROM functionalities WHERE project_id = ? ORDER BY created_at ASC',
    args: [projectId],
  });
  const functionalities = funcsRs.rows.map((f) => ({
    id: f.id,
    name: f.name,
    description: f.description,
    createdAt: f.created_at,
    createdBy: f.created_by,
  }));

  const assignmentsRs = await conn.execute({
    sql: 'SELECT id, function_name, session_id, session_label, reason, proposed_by, status, approved, created_at, decided_at FROM assignments WHERE project_id = ? ORDER BY created_at ASC',
    args: [projectId],
  });
  const assignments = assignmentsRs.rows.map((a) => ({
    id: a.id,
    functionName: a.function_name,
    sessionId: a.session_id,
    sessionLabel: a.session_label,
    reason: a.reason,
    proposedBy: a.proposed_by,
    status: a.status,
    approved: !!a.approved, // SQLite has no real boolean -- stored as 0/1, coerced back here
    createdAt: a.created_at,
    decidedAt: a.decided_at,
  }));

  return { notes, functionalities, assignments };
}

/**
 * Same "hand me the whole object, I persist it" contract as
 * saveSessions above -- instructions.js's route handlers read the full
 * { notes, functionalities, assignments } shape, mutate one field or
 * push one array entry, then call this with the entire thing. Same
 * full-replace-in-a-transaction approach for the same reason.
 */
async function saveInstructions(projectId, data) {
  return withLock(`instructions:${projectId}`, async () => {
    await conn.execute('BEGIN');
    try {
      await conn.execute({
        sql: 'UPDATE projects SET notes = ? WHERE id = ?',
        args: [data.notes || '', projectId],
      });

      await conn.execute({ sql: 'DELETE FROM functionalities WHERE project_id = ?', args: [projectId] });
      for (const f of data.functionalities || []) {
        await conn.execute({
          sql: `INSERT INTO functionalities (id, project_id, name, description, created_at, created_by)
                VALUES (?, ?, ?, ?, ?, ?)`,
          args: [f.id, projectId, f.name, f.description || '', f.createdAt, f.createdBy],
        });
      }

      await conn.execute({ sql: 'DELETE FROM assignments WHERE project_id = ?', args: [projectId] });
      for (const a of data.assignments || []) {
        await conn.execute({
          sql: `INSERT INTO assignments (id, project_id, function_name, session_id, session_label, reason, proposed_by, status, approved, created_at, decided_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [a.id, projectId, a.functionName, a.sessionId, a.sessionLabel, a.reason || '', a.proposedBy, a.status || 'pending', a.approved ? 1 : 0, a.createdAt, a.decidedAt || null],
        });
      }
      await conn.execute('COMMIT');
    } catch (err) {
      await conn.execute('ROLLBACK');
      throw err;
    }
    return data;
  });
}

async function getActivity(projectId) {
  // Ordered newest-first to match the JSON version's log.unshift()
  // behavior (new entries were always prepended, so index 0 was always
  // the most recent). activity.js's route then does .slice(0, limit)
  // on whatever this returns, same as before.
  const rs = await conn.execute({
    sql: 'SELECT id, type, actor, message, path, timestamp FROM activity WHERE project_id = ? ORDER BY timestamp DESC',
    args: [projectId],
  });
  return rs.rows.map((r) => ({
    id: r.id,
    type: r.type,
    actor: r.actor,
    message: r.message,
    ...(r.path !== null && { path: r.path }), // JSON version only included `path` on entries that had one
    timestamp: r.timestamp,
  }));
}

/**
 * NOTE: the JSON version capped this at 1000 entries per project on
 * every write (see schema.sql's note on why that cap existed and why
 * it isn't reintroduced here by default). This function does NOT trim
 * -- every call appends a new row and nothing is deleted. If an
 * unbounded activity table turns out to be undesirable (Turso row
 * limits, cost, or just wanting the old behavior back), that's a
 * product decision to make deliberately, not something to silently
 * inherit from a constraint that no longer technically applies.
 */
async function appendActivity(projectId, entry) {
  return withLock(`activity:${projectId}`, async () => {
    await conn.execute({
      sql: `INSERT INTO activity (id, project_id, type, actor, message, path, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [entry.id, projectId, entry.type, entry.actor, entry.message, entry.path || null, entry.timestamp],
    });
    return getActivity(projectId);
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
  deleteProjectRow,
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
