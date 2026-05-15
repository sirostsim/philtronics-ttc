-- 003_target_times.sql
-- Target time to complete per item number (hours + minutes)

CREATE TABLE IF NOT EXISTS target_times (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_number  TEXT NOT NULL UNIQUE,
  hours        INTEGER NOT NULL DEFAULT 0 CHECK (hours >= 0 AND hours < 100),
  minutes      INTEGER NOT NULL DEFAULT 0 CHECK (minutes >= 0 AND minutes < 60),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_target_times_item ON target_times (item_number);
