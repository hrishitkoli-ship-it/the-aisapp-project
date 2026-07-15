/**
 * fileOps.js
 * ------------------------------------------------------------------
 * Turso-backed file operations for a project's workspace, replacing
 * the original real-filesystem implementation (see store.js's header
 * comment for why -- Vercel's serverless filesystem is read-only and
 * ephemeral).
 *
 * The original two concerns are preserved exactly, just backed by
 * `aisapp_files` rows instead of real files on disk:
 *
 * 1. PATH SAFETY: there's no real filesystem to resolve against
 *    anymore, so "escaping the sandbox" is redefined as a purely
 *    LOGICAL check on the path string itself: normalize it (collapse
 *    "./" and "../" segments the same way a filesystem would), and
 *    reject if the normalized result tries to climb above the
 *    project's own namespace (starts with ".." or is an absolute
 *    path). This preserves the identical security property -- an
 *    agent cannot address any file outside its own project's rows --
 *    without needing a real directory to contain it. Exactly like the
 *    original, this THROWS on an escape attempt rather than silently
 *    stripping "../" and continuing, so the route layer can log it as
 *    a security_alert the human actually sees.
 *
 * 2. CONFLICT DETECTION: each row in aisapp_files carries its own
 *    `version` integer directly. A write can supply `expectedVersion`;
 *    a mismatch returns a conflict without writing, exactly like
 *    before. `force: true` bypasses the check.
 *
 * Uses store.run() (parameterized SQL against the shared Turso
 * client) rather than a query-builder API -- see store.js for the
 * client setup and the same "network path unverified, schema/trigger
 * logic proven locally" honesty note that applies here too.
 * ------------------------------------------------------------------
 */

const store = require('../db/store');

class PathSafetyError extends Error {}

/**
 * Normalizes a logical relative path the same way a filesystem would
 * (collapsing "a/../b" -> "b", "./a" -> "a") and throws PathSafetyError
 * if the result would climb outside the project's namespace.
 *
 * Deliberately mirrors the original safeResolve()'s "throw, don't
 * silently rewrite" philosophy -- see file header.
 */
function safeNormalize(relPath) {
  const raw = relPath || '';
  if (raw.includes('\0')) {
    throw new PathSafetyError('Path contains a null byte and was blocked.');
  }

  // Split on both slash directions (a pasted Windows-style path
  // shouldn't get a free pass just because it uses backslashes),
  // filter out empty/"." segments, then walk segments collapsing
  // ".." exactly like path.resolve() would.
  const parts = raw.split(/[\\/]+/).filter((seg) => seg !== '' && seg !== '.');
  const stack = [];
  for (const seg of parts) {
    if (seg === '..') {
      if (stack.length === 0) {
        throw new PathSafetyError(
          `Path "${relPath}" resolves outside the project workspace and was blocked.`
        );
      }
      stack.pop();
    } else {
      stack.push(seg);
    }
  }

  const normalized = stack.join('/');
  // A leading "/" in the ORIGINAL input (absolute-looking path) is
  // also a red flag even though the split/filter above already
  // stripped it structurally -- an agent writing "/etc/passwd"
  // shouldn't quietly become "etc/passwd" inside the project.
  if (raw.startsWith('/') || raw.startsWith('\\')) {
    throw new PathSafetyError(`Path "${relPath}" is an absolute path and was blocked.`);
  }

  return normalized;
}

/** Recursively-shaped { name, type, path, children? } tree for the UI,
 *  built from a flat list of aisapp_files rows for this project.
 *
 *  PERFORMANCE FIX (item 3 of the human's fix/feature prompt --
 *  "project load is slow"): this previously selected the FULL
 *  `content` column for every file just to compute `size` via
 *  Buffer.byteLength() -- meaning a tree load transferred the entire
 *  byte content of every file in the project over the network from
 *  Turso, even though content is never used for anything else here.
 *  For any project with substantial file content, that's real,
 *  unnecessary I/O on the one request that runs on every single
 *  project-open.
 *
 *  Fixed by computing size SERVER-SIDE via octet_length(content)
 *  instead of transferring content at all. Verified this wasn't a
 *  silent correctness regression before shipping it, not assumed:
 *  SQLite's plain length() returns CHARACTER count for a TEXT column,
 *  not byte count (confirmed directly: length('café') = 4,
 *  octet_length('café') = 5) -- length() would have silently produced
 *  WRONG (smaller) sizes for any file with non-ASCII content, which
 *  is the exact kind of thing that looks fine in a plain-ASCII test
 *  and breaks quietly in production for real content. octet_length()
 *  was tested directly against a local libSQL-compatible engine with
 *  a real multi-byte string (emoji + accented + CJK characters) and
 *  its result matched Node's own Buffer.byteLength() exactly (20
 *  bytes for both), confirming both correctness and that it's the
 *  right function, not a guess from documentation alone. Also dropped
 *  the `version` column from this same query -- selected but never
 *  actually used anywhere in this function's output, same over-
 *  fetching pattern on a smaller scale. */
async function buildFileTree(projectId) {
  const result = await store.run(
    'SELECT path, octet_length(content) AS size, updated_at FROM aisapp_files WHERE project_id = ?',
    [projectId]
  );

  const root = { children: new Map() };

  for (const row of result.rows) {
    const segments = row.path.split('/');
    let node = root;
    segments.forEach((seg, i) => {
      const isLeaf = i === segments.length - 1;
      if (!node.children.has(seg)) {
        node.children.set(
          seg,
          isLeaf
            ? {
                name: seg,
                type: 'file',
                path: segments.slice(0, i + 1).join('/'),
                size: row.size,
                modifiedAt: row.updated_at,
                children: null,
              }
            : {
                name: seg,
                type: 'directory',
                path: segments.slice(0, i + 1).join('/'),
                children: new Map(),
              }
        );
      }
      node = node.children.get(seg);
    });
  }

  function toArray(node) {
    if (!node.children) return undefined;
    return Array.from(node.children.values())
      .map((child) => {
        if (child.type === 'file') {
          const { children, ...rest } = child;
          return rest;
        }
        return { ...child, children: toArray(child) };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  return toArray(root);
}

async function readFileContent(projectId, relPath) {
  const normalized = safeNormalize(relPath);
  const result = await store.run(
    'SELECT content FROM aisapp_files WHERE project_id = ? AND path = ?',
    [projectId, normalized]
  );
  return result.rows[0]?.content ?? null;
}

/**
 * Writes file content with optimistic-concurrency conflict detection.
 * Returns { conflict: true, currentVersion, lastModifiedBy, lastModifiedAt }
 * if expectedVersion was supplied and didn't match, WITHOUT writing.
 * Otherwise writes and returns { conflict: false, version }.
 */
async function writeFileContent(projectId, relPath, content, { expectedVersion, force } = {}) {
  const normalized = safeNormalize(relPath);

  const existingResult = await store.run(
    'SELECT version, last_modified_by, updated_at FROM aisapp_files WHERE project_id = ? AND path = ?',
    [projectId, normalized]
  );
  const existing = existingResult.rows[0];

  if (!force && expectedVersion !== undefined && expectedVersion !== null) {
    if (existing && existing.version !== expectedVersion) {
      return {
        conflict: true,
        currentVersion: existing.version,
        lastModifiedBy: existing.last_modified_by,
        lastModifiedAt: existing.updated_at,
      };
    }
  }

  const newVersion = (existing?.version || 0) + 1;

  // SQLite/Turso upsert: INSERT ... ON CONFLICT(project_id, path) DO UPDATE.
  await store.run(
    `INSERT INTO aisapp_files (project_id, path, content, version, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(project_id, path) DO UPDATE SET
       content = excluded.content,
       version = excluded.version,
       updated_at = excluded.updated_at`,
    [projectId, normalized, content, newVersion]
  );

  return { conflict: false, version: newVersion };
}

/** Attach "who last wrote this" after the fact (called from the route,
 *  which knows the actor label at the point writeFileContent succeeds). */
async function stampLastModifiedBy(projectId, relPath, actorLabel) {
  const normalized = safeNormalize(relPath);
  await store.run(
    'UPDATE aisapp_files SET last_modified_by = ? WHERE project_id = ? AND path = ?',
    [actorLabel, projectId, normalized]
  );
}

/** Deletes a single file OR every file whose path starts with
 *  relPath + "/" (a "directory" in this flat-row model is just a
 *  path prefix, so deleting one means deleting all rows under it). */
async function deleteFileOrDir(projectId, relPath) {
  const normalized = safeNormalize(relPath);

  const existsResult = await store.run(
    `SELECT 1 as found FROM aisapp_files WHERE project_id = ? AND (path = ? OR path LIKE ?) LIMIT 1`,
    [projectId, normalized, `${normalized}/%`]
  );
  if (existsResult.rows.length === 0) return false;

  await store.run(
    `DELETE FROM aisapp_files WHERE project_id = ? AND (path = ? OR path LIKE ?)`,
    [projectId, normalized, `${normalized}/%`]
  );

  return true;
}

/** Returns the tracked version metadata for a file, or null if untracked. */
async function getFileVersion(projectId, relPath) {
  const normalized = safeNormalize(relPath);
  const result = await store.run(
    'SELECT version, last_modified_by, updated_at FROM aisapp_files WHERE project_id = ? AND path = ?',
    [projectId, normalized]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    version: row.version,
    lastModifiedBy: row.last_modified_by,
    lastModifiedAt: row.updated_at,
  };
}

module.exports = {
  safeNormalize,
  buildFileTree,
  readFileContent,
  writeFileContent,
  stampLastModifiedBy,
  deleteFileOrDir,
  getFileVersion,
  PathSafetyError,
};
