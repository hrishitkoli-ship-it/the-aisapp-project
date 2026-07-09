/**
 * fileOps.js
 * ------------------------------------------------------------------
 * Low-level, identity-agnostic file operations for a project's
 * workspace folder. Two concerns are handled centrally here so every
 * caller (human routes, AI routes) gets them automatically:
 *
 * 1. PATH SAFETY: every relative path from a request is resolved
 *    against the project's files/ directory and verified to still be
 *    inside it. This blocks "../../etc/passwd"-style traversal from
 *    a malicious or buggy AI agent.
 *
 * 2. CONFLICT DETECTION: each file's last-known state is tracked in
 *    a sidecar ".versions.json" (per project, inside the project
 *    folder, NOT inside files/ so it never shows up in the user's own
 *    file tree). A write can optionally supply `expectedVersion`; if
 *    the file's current version doesn't match, we treat that as "this
 *    file changed underneath you" and return a conflict rather than
 *    silently overwriting -- this is what satisfies the "warning if
 *    an AI and the user are editing the same file simultaneously"
 *    requirement. Passing `force: true` bypasses the check once the
 *    caller has been warned and still wants to proceed.
 * ------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

class PathSafetyError extends Error {}

/**
 * Resolve relPath against baseDir, throwing PathSafetyError if it
 * would escape baseDir.
 *
 * IMPORTANT: this deliberately does NOT silently strip leading "../"
 * and continue -- an earlier version did that, which was technically
 * safe (the file access itself never escaped) but gave zero signal
 * that an escape was ATTEMPTED. Since this whole app exists to let
 * semi-trusted external AI agents touch the filesystem, a caller
 * trying to walk out of the sandbox is exactly the kind of thing the
 * human overseeing those agents should be able to see in the activity
 * timeline -- so we throw instead of quietly rewriting, and the route
 * layer logs the attempt (see routes/files.js).
 */
function safeResolve(baseDir, relPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, relPath || '');
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
    throw new PathSafetyError(
      `Path "${relPath}" resolves outside the project workspace and was blocked.`
    );
  }
  return resolved;
}

/** Recursively build a { name, type, path, children? } tree for the UI. */
function buildFileTree(baseDir) {
  if (!fs.existsSync(baseDir)) return [];

  function walk(dir, relPrefix) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.name !== '.versions.json')
      .map((entry) => {
        const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          return {
            name: entry.name,
            type: 'directory',
            path: relPath,
            children: walk(path.join(dir, entry.name), relPath),
          };
        }
        const stat = fs.statSync(path.join(dir, entry.name));
        return {
          name: entry.name,
          type: 'file',
          path: relPath,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => {
        // Directories first, then alphabetical -- standard file-explorer feel.
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  return walk(baseDir, '');
}

function readFileContent(baseDir, relPath) {
  const target = safeResolve(baseDir, relPath);
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return null;
  return fs.readFileSync(target, 'utf-8');
}

// ---- Version tracking for conflict detection ----

function versionsFilePath(baseDir) {
  // baseDir is .../projects/<id>/files -- store the sidecar one level up
  // so it lives at .../projects/<id>/.versions.json, invisible to the
  // user's own file tree (which only walks files/).
  return path.join(path.dirname(baseDir), '.versions.json');
}

function readVersions(baseDir) {
  const p = versionsFilePath(baseDir);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

function writeVersions(baseDir, versions) {
  fs.writeFileSync(versionsFilePath(baseDir), JSON.stringify(versions, null, 2), 'utf-8');
}

/**
 * Writes file content with optimistic-concurrency conflict detection.
 * Returns { conflict: true, currentVersion, lastModifiedBy, lastModifiedAt }
 * if expectedVersion was supplied and didn't match, WITHOUT writing.
 * Otherwise writes and returns { conflict: false, version }.
 */
function writeFileContent(baseDir, relPath, content, { expectedVersion, force } = {}) {
  const target = safeResolve(baseDir, relPath);
  const versions = readVersions(baseDir);
  const existing = versions[relPath];

  if (!force && expectedVersion !== undefined && expectedVersion !== null) {
    if (existing && existing.version !== expectedVersion) {
      return {
        conflict: true,
        currentVersion: existing.version,
        lastModifiedBy: existing.lastModifiedBy,
        lastModifiedAt: existing.lastModifiedAt,
      };
    }
  }

  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, content, 'utf-8');

  const newVersion = (existing?.version || 0) + 1;
  versions[relPath] = {
    version: newVersion,
    lastModifiedAt: new Date().toISOString(),
    lastModifiedBy: null, // filled in by the route layer via a second call if needed
  };
  writeVersions(baseDir, versions);

  return { conflict: false, version: newVersion };
}

/** Attach "who last wrote this" after the fact (called from the route,
 *  which knows the actor label at the point writeFileContent succeeds). */
function stampLastModifiedBy(baseDir, relPath, actorLabel) {
  const versions = readVersions(baseDir);
  if (versions[relPath]) {
    versions[relPath].lastModifiedBy = actorLabel;
    writeVersions(baseDir, versions);
  }
}

function deleteFileOrDir(baseDir, relPath) {
  const target = safeResolve(baseDir, relPath);
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { recursive: true, force: true });

  const versions = readVersions(baseDir);
  delete versions[relPath];
  writeVersions(baseDir, versions);
  return true;
}

/** Returns the tracked version metadata for a file, or null if untracked. */
function getFileVersion(baseDir, relPath) {
  const versions = readVersions(baseDir);
  return versions[relPath] || null;
}

module.exports = {
  safeResolve,
  buildFileTree,
  readFileContent,
  writeFileContent,
  stampLastModifiedBy,
  deleteFileOrDir,
  getFileVersion,
  PathSafetyError,
};
