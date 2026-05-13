-- 001_initial_schema.sql – PostgreSQL version
-- Philtronics Time-to-Complete initial schema

-- ─── USERS ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            TEXT        PRIMARY KEY,
  username      TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  full_name     TEXT        NOT NULL,
  role          TEXT        NOT NULL CHECK (role IN ('operator','supervisor','manager','administrator')),
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Case-insensitive unique index on username
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));

-- ─── TIMERS ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS timers (
  id               TEXT        PRIMARY KEY,
  item_number      TEXT        NOT NULL,
  operator_id      TEXT        NOT NULL REFERENCES users(id),
  operator_name    TEXT        NOT NULL,
  started_at       TIMESTAMPTZ NOT NULL,
  completed_at     TIMESTAMPTZ,
  duration_seconds INTEGER     CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  status           TEXT        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active','completed','cancelled')),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       TEXT        NOT NULL REFERENCES users(id),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by       TEXT        REFERENCES users(id)
);

-- Partial unique index: one active timer per operator
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
  id           TEXT        PRIMARY KEY,
  timer_id     TEXT        REFERENCES timers(id),
  action       TEXT        NOT NULL,
  performed_by TEXT        NOT NULL REFERENCES users(id),
  reason       TEXT,
  details      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_timer   ON audit_log (timer_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_log (performed_by);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);

-- ─── ITEM MASTER ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS item_master (
  id          TEXT        PRIMARY KEY,
  item_number TEXT        NOT NULL UNIQUE,
  description TEXT,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── MIGRATION TRACKING ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS migrations (
  id         SERIAL PRIMARY KEY,
  filename   TEXT   NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
