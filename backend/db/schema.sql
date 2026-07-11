-- schema.sql
-- ------------------------------------------------------------------
-- Turso (libSQL) schema for the AI-Collaborative Hub.
--
-- Ported directly from the JSON shapes in the current backend/db/store.js
-- (local-file version). Every table below maps to a JSON file or a
-- nested array field from that file:
--
--   projects/_device.json          -> device
--   projects/_index.json           -> projects (the index; project.json
--                                    itself is folded into the same row
--                                    rather than kept separate, since
--                                    _index.json and project.json
--                                    together WERE one project's full
--                                    identity split across two files
--                                    for no reason a relational store
--                                    needs to preserve)
--   projects/<id>/sessions.json    -> sessions
--   sessions[].taskQueue[]         -> task_requests (was a nested
--                                    array on each session; genuinely
--                                    relational -- one session has many
--                                    requests -- so it becomes its own
--                                    table with a foreign key, not a
--                                    JSON blob column)
--   projects/<id>/instructions.json (notes field) -> projects.notes
--   instructions.functionalities[] -> functionalities
--   instructions.assignments[]     -> assignments
--   projects/<id>/activity.json    -> activity
--
-- NOT ported: the files/ directory tree (actual workspace file
-- content). That is out of scope for this schema -- see the migration
-- notes in INSTRUCTIONS.md for why file *content* staying on a
-- filesystem-like store (or a separate blob table) is a distinct
-- decision from moving metadata into SQL, and hasn't been made here.
-- ------------------------------------------------------------------

-- One row ever, in practice (one device = one human's permanent
-- identity). Kept as a real table rather than a single hardcoded row
-- elsewhere so the shape stays honest: "this can only ever be 0 or 1
-- rows" is enforced by the app layer (getOrCreateDeviceCode), not
-- assumed by the schema.
CREATE TABLE IF NOT EXISTS device (
  id INTEGER PRIMARY KEY CHECK (id = 1), -- enforces at most one row
  code TEXT NOT NULL UNIQUE,             -- the permanent 12-char code
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,                   -- nanoid(10), e.g. "wpQmtw82Lb"
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  device_code TEXT NOT NULL,             -- FK-like reference to device.code;
                                          -- not a real FK constraint because
                                          -- old rows can predate device
                                          -- existing at all (see the
                                          -- backfill logic in the current
                                          -- regenerate-token route) --
                                          -- a hard FK would reject exactly
                                          -- the case that route is built
                                          -- to handle gracefully.
  token_hash TEXT NOT NULL,              -- SHA-256 hex, never the raw token
  token_generated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT ''         -- was instructions.json's "notes" field
);

CREATE INDEX IF NOT EXISTS idx_projects_device_code ON projects(device_code);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT NOT NULL,                      -- the AI-chosen or nanoid(8) session id;
                                          -- NOT globally unique -- only unique
                                          -- per project, same as the JSON version
                                          -- where each project had its own
                                          -- sessions.json array
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  function TEXT NOT NULL DEFAULT '',
  current_task TEXT NOT NULL DEFAULT 'Idle',
  status TEXT NOT NULL DEFAULT 'active',
  registered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)           -- composite key: uniqueness is
                                          -- scoped to the project, matching
                                          -- how the JSON version worked
                                          -- (sessions.findIndex((s) => s.id === id)
                                          -- was always searched within one
                                          -- project's array, never globally)
);

CREATE TABLE IF NOT EXISTS task_requests (
  id TEXT PRIMARY KEY,                   -- nanoid(8), globally unique is fine
                                          -- here since these were never looked
                                          -- up by anything other than this id
  project_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,       -- which session's queue this sits in
  from_session_id TEXT NOT NULL,
  from_label TEXT NOT NULL,
  message TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id, target_session_id) REFERENCES sessions(project_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_requests_target ON task_requests(project_id, target_session_id);

CREATE TABLE IF NOT EXISTS functionalities (
  id TEXT PRIMARY KEY,                   -- nanoid(8)
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL               -- 'human' or 'AI:<sessionId>'
);

CREATE TABLE IF NOT EXISTS assignments (
  id TEXT PRIMARY KEY,                   -- nanoid(8)
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  function_name TEXT NOT NULL,
  session_id TEXT NOT NULL,
  session_label TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  proposed_by TEXT NOT NULL,             -- 'human' or 'AI:<sessionId>'
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  approved INTEGER NOT NULL DEFAULT 0,   -- SQLite has no real boolean;
                                          -- 0/1, same convention the rest
                                          -- of this schema uses throughout
  created_at TEXT NOT NULL,
  decided_at TEXT                        -- nullable: null until approved/rejected
);

-- THE APPROVAL GATE, preserved at the schema level, not just the route
-- level: nothing in this table's definition or triggers lets a row
-- reach approved = 1 without going through application code that
-- checks the caller was human-authenticated (the actual enforcement
-- still lives in routes/instructions.js -- there being no AI-facing
-- route capable of UPDATE-ing this column -- exactly as it does today;
-- this schema does not attempt to re-implement that as a DB-level
-- CHECK constraint, because "was this UPDATE issued by a
-- human-authenticated request" is not something SQL can express. The
-- gate's integrity depends on route-level discipline before and after
-- this migration alike -- flagged here so that discipline isn't lost
-- sight of once storage is Turso instead of a JSON file.)

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,                   -- nanoid(8)
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,                   -- 'human' or 'AI:<sessionId>'
  message TEXT NOT NULL,
  path TEXT,                             -- nullable: only file_write/file_delete entries have this
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_project_time ON activity(project_id, timestamp DESC);

-- NOTE ON THE 1000-ENTRY CAP: the JSON version's appendActivity()
-- trimmed to the most recent 1000 entries on every write (log.slice(0,
-- 1000)), because an unbounded array in a single JSON file would grow
-- that file forever. A real database does not have that problem --
-- SQL can paginate/limit at query time (see the existing activity.js
-- route's `?limit=` param) without needing to physically delete old
-- rows just to keep a file small. This schema does NOT reintroduce
-- that cap by default; if unbounded activity history per project is
-- undesirable for a different reason (Turso's free-tier row-count
-- limits, cost, etc.), that's a product decision for whoever owns this
-- migration to make deliberately, not something to inherit silently
-- from a constraint that no longer applies.
