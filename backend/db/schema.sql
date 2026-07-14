-- ============================================================
-- the-aisapp-project: Turso (libSQL) storage schema
-- Replaces local-JSON-file storage, since Vercel's serverless
-- filesystem is read-only/ephemeral. See backend/db/store.js
-- header for the full rationale.
--
-- SIZE CAPS: ~100KB per project, ~5MB per account, enforced via
-- SQLite triggers using RAISE(ABORT, ...) -- the SQLite equivalent
-- of a Postgres trigger raising an exception. Both were proven
-- against the REAL Turso/Limbo engine running locally (not a
-- simulation) before this file was written:
--   - A 150,000-byte single-project write was confirmed rejected.
--   - A write individually far under the 100KB/project cap, but
--     landing on a near-full account, was confirmed rejected
--     specifically by the ACCOUNT_CAP trigger (proven via distinct
--     RAISE messages per trigger, not inferred).
--   - Same-size and shrinking UPDATEs near the account cap were
--     confirmed to NOT be falsely rejected -- this is the
--     correctness-critical case: a naive account-total check that
--     doesn't subtract the row's OLD size before adding NEW would
--     double-count the row being updated and reject harmless
--     no-op/shrinking writes once the account is near-full. The
--     UPDATE triggers below explicitly subtract length(OLD.*)
--     before adding length(NEW.*) to avoid this.
--
-- Unlike Postgres's pg_column_size() (which measures TOAST-
-- *compressed* on-disk size and badly understates repetitive
-- content -- a real bug caught during the earlier Postgres attempt
-- at this same schema), SQLite's length() on a TEXT column returns
-- true uncompressed byte length with no equivalent trap. Confirmed
-- by testing with a maximally-repetitive string during setup.
-- ============================================================

-- NOTE ON ON DELETE CASCADE BELOW: aisapp_files.project_id declares
-- this for documentation/intent, but the application (store.js's
-- removeProjectFromIndex) does NOT rely on it -- SQLite/Turso's
-- foreign_keys pragma defaults OFF, confirmed via direct testing
-- (PRAGMA foreign_keys returned 0), and isn't safely assumed to
-- persist across the Serverless SDK's request-scoped fetch()
-- transport. store.js deletes aisapp_files rows explicitly before
-- the aisapp_projects row, so project deletion is correct regardless
-- of pragma state.

-- ---- Device identity ----
-- Keyed by the code itself (not a hardcoded single row) so this can
-- genuinely support multiple devices later -- e.g. once device-code
-- generation moves client-side (browser localStorage, one per
-- browser/PWA-install) rather than being a single server-side
-- identity, which stops making sense once a shared Vercel deployment
-- serves multiple physical devices as clients rather than being one
-- Termux-hosted server IS the device. For now, getOrCreateDeviceCode
-- in store.js treats "the first/only row" as the answer, matching
-- the existing single-device contract routes/device.js and
-- tokens.js's generateToken(deviceCode) already assume -- this table
-- shape just avoids needing another migration when that assumption
-- changes.
--
-- code TEXT PRIMARY KEY NOT NULL (Session 4, NOT NULL added
-- explicitly): tested directly against a real local Turso/Limbo
-- engine and confirmed that SQLite's PRIMARY KEY constraint does NOT
-- imply NOT NULL for a TEXT column the way it would in Postgres/
-- MySQL, or the way INTEGER PRIMARY KEY's special rowid-aliasing
-- behavior makes it feel like it does in SQLite itself -- an INSERT
-- omitting `code` entirely was confirmed to succeed, silently storing
-- a NULL primary key, which store.js's getOrCreateDeviceSecretHash and
-- getOrCreateDeviceCode both implicitly assume can never happen ("a
-- row can't exist without its code set" was this session's stated
-- reasoning for treating getOrCreateDeviceCode's existing logic as
-- safe under this schema -- correct for every INSERT this session's
-- own code performs, but not structurally guaranteed by the schema
-- itself before this line, which is the gap this closes).
--
-- device_secret_hash (Session 4, added alongside the NOT NULL fix
-- above): gates human-facing WRITE routes now that "no cloud auth,
-- device is the boundary" can no longer mean "anyone who can reach
-- the server" once this is genuinely public -- see SECURITY.md §3b,
-- which flagged this exact gap as open and undecided until now, and
-- middleware/auth.js's requireDeviceSecret for the actual enforcement.
-- NULLABLE, not NOT NULL: a device row can legitimately exist with no
-- secret yet (freshly created, first write request hasn't arrived to
-- trigger lazy creation -- see requireDeviceSecret's own comment on
-- why this is lazy rather than a hard boot-time requirement). This is
-- the SHA-256 hash only, same convention as aisapp_projects storing
-- token hashes rather than raw tokens -- the raw secret is shown to
-- the human exactly once, at creation, never persisted or retrievable
-- again by design. Added as a column on the EXISTING table, not a new
-- table: one more attribute of the same device identity (code +
-- created_at + now also a write-gate secret), not a separate concept
-- needing its own relation. Deliberately narrow and additive (one
-- nullable column plus the NOT NULL fix above, no change to any
-- existing column's meaning, no new table, no change to
-- aisapp_projects' foreign key relationship) rather than a schema
-- redesign, out of respect for this being actively-owned territory
-- (see this file's own extensive header on how carefully the rest of
-- this schema was verified) -- a narrow addition alongside that work
-- is a different kind of change than deciding the underlying
-- architecture, which stays out of scope here same as it was earlier
-- this session when the device-identity gap itself was found and
-- deliberately left for the owning session to resolve.
CREATE TABLE aisapp_devices (
  code TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  device_secret_hash TEXT
);

CREATE TABLE aisapp_projects (
  id TEXT PRIMARY KEY,
  device_code TEXT REFERENCES aisapp_devices(code),
  project TEXT NOT NULL DEFAULT '{}',
  sessions TEXT NOT NULL DEFAULT '[]',
  instructions TEXT NOT NULL DEFAULT '{"notes":"","functionalities":[],"assignments":[]}',
  activity TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE aisapp_files (
  project_id TEXT NOT NULL REFERENCES aisapp_projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  last_modified_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, path)
);

CREATE INDEX aisapp_files_project_idx ON aisapp_files(project_id);

-- ---- Per-row caps (~100KB / project row, ~100KB / file) ----

CREATE TRIGGER aisapp_projects_size_check_insert
BEFORE INSERT ON aisapp_projects
WHEN (length(NEW.project) + length(NEW.sessions) + length(NEW.instructions) + length(NEW.activity)) > 102400
BEGIN
  SELECT RAISE(ABORT, 'PROJECT_CAP:This project has reached its ~100KB storage limit.');
END;

CREATE TRIGGER aisapp_projects_size_check_update
BEFORE UPDATE ON aisapp_projects
WHEN (length(NEW.project) + length(NEW.sessions) + length(NEW.instructions) + length(NEW.activity)) > 102400
BEGIN
  SELECT RAISE(ABORT, 'PROJECT_CAP:This project has reached its ~100KB storage limit.');
END;

CREATE TRIGGER aisapp_files_size_check_insert
BEFORE INSERT ON aisapp_files
WHEN length(NEW.content) > 102400
BEGIN
  SELECT RAISE(ABORT, 'PROJECT_CAP:This project has reached its ~100KB storage limit.');
END;

CREATE TRIGGER aisapp_files_size_check_update
BEFORE UPDATE ON aisapp_files
WHEN length(NEW.content) > 102400
BEGIN
  SELECT RAISE(ABORT, 'PROJECT_CAP:This project has reached its ~100KB storage limit.');
END;

-- ---- Account-wide cap (~5MB total across everything) ----
-- NOTE the UPDATE variants subtract length(OLD.*) before adding
-- length(NEW.*) -- see header comment for why this matters.

CREATE TRIGGER aisapp_account_size_check_projects_insert
BEFORE INSERT ON aisapp_projects
WHEN (
  (SELECT COALESCE(SUM(length(project)+length(sessions)+length(instructions)+length(activity)), 0) FROM aisapp_projects)
  + (SELECT COALESCE(SUM(length(content)), 0) FROM aisapp_files)
  + length(NEW.project) + length(NEW.sessions) + length(NEW.instructions) + length(NEW.activity)
) > 5242880
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_CAP:Your account has reached its ~5MB total storage limit.');
END;

CREATE TRIGGER aisapp_account_size_check_projects_update
BEFORE UPDATE ON aisapp_projects
WHEN (
  (SELECT COALESCE(SUM(length(project)+length(sessions)+length(instructions)+length(activity)), 0) FROM aisapp_projects)
  + (SELECT COALESCE(SUM(length(content)), 0) FROM aisapp_files)
  - (length(OLD.project)+length(OLD.sessions)+length(OLD.instructions)+length(OLD.activity))
  + (length(NEW.project)+length(NEW.sessions)+length(NEW.instructions)+length(NEW.activity))
) > 5242880
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_CAP:Your account has reached its ~5MB total storage limit.');
END;

CREATE TRIGGER aisapp_account_size_check_files_insert
BEFORE INSERT ON aisapp_files
WHEN (
  (SELECT COALESCE(SUM(length(project)+length(sessions)+length(instructions)+length(activity)), 0) FROM aisapp_projects)
  + (SELECT COALESCE(SUM(length(content)), 0) FROM aisapp_files)
  + length(NEW.content)
) > 5242880
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_CAP:Your account has reached its ~5MB total storage limit.');
END;

CREATE TRIGGER aisapp_account_size_check_files_update
BEFORE UPDATE ON aisapp_files
WHEN (
  (SELECT COALESCE(SUM(length(project)+length(sessions)+length(instructions)+length(activity)), 0) FROM aisapp_projects)
  + (SELECT COALESCE(SUM(length(content)), 0) FROM aisapp_files)
  - length(OLD.content) + length(NEW.content)
) > 5242880
BEGIN
  SELECT RAISE(ABORT, 'ACCOUNT_CAP:Your account has reached its ~5MB total storage limit.');
END;

