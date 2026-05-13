-- 001_initial_schema.sql
-- Initial database schema for Philtronics Time-to-Complete system

-- ─── USERS ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            TEXT    PRIMARY KEY,               -- UUID
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  full_name     TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('operator','supervisor','manager','administrator')),
  is_active     INTEGER NOT NULL DEFAULT 1,        -- 0 = disabled
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ─── TIMERS ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS timers (
  id               TEXT    PRIMARY KEY,            -- UUID
  item_number      TEXT    NOT NULL,
  operator_id      TEXT    NOT NULL REFERENCES users(id),
  operator_name    TEXT    NOT NULL,               -- denormalised for export stability
  started_at       TEXT    NOT NULL,               -- UTC ISO8601
  completed_at     TEXT,                           -- UTC ISO8601; NULL = active
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  status           TEXT    NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','completed','cancelled')),
  notes            TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  created_by       TEXT    NOT NULL REFERENCES users(id),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_by       TEXT    REFERENCES users(id)
);

-- Only one active timer per operator (partial index acts as unique constraint)
CREATE UNIQUE INDEX IF NOT EXISTS idx_timers_one_active_per_operator
  ON timers (operator_id)
  WHERE status = 'active';

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_timers_operator    ON timers (operator_id);
CREATE INDEX IF NOT EXISTS idx_timers_started_at  ON timers (started_at);
CREATE INDEX IF NOT EXISTS idx_timers_item_number ON timers (item_number);
CREATE INDEX IF NOT EXISTS idx_timers_status      ON timers (status);

-- ─── AUDIT LOG ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,                    -- UUID
  timer_id    TEXT REFERENCES timers(id),
  action      TEXT NOT NULL,                       -- cancel | adjust | login_fail | etc.
  performed_by TEXT NOT NULL REFERENCES users(id),
  reason      TEXT,
  details     TEXT,                                -- JSON blob of changed fields
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_timer    ON audit_log (timer_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor    ON audit_log (performed_by);
CREATE INDEX IF NOT EXISTS idx_audit_created  ON audit_log (created_at);

-- ─── ITEM MASTER (optional autocomplete) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS item_master (
  id          TEXT PRIMARY KEY,
  item_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
