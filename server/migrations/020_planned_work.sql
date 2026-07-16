-- 020_planned_work.sql
-- Forward planning board. Managers plan upcoming work; supervisors and above
-- view it on the Planner page as a Gantt-style timeline.
--
-- Duration is derived, not stored: at read time the item number is joined to
-- target_times. If a target exists, the required time is target x quantity; if
-- not, the manager's per-item estimate (estimated_minutes) is used instead. The
-- estimate is stored as a fallback so a later target change does not lose it.
--
-- Additive and non-destructive.

CREATE TABLE IF NOT EXISTS planned_work (
  id                TEXT        PRIMARY KEY,
  item_number       TEXT        NOT NULL,
  wo_number         TEXT,
  start_date        DATE        NOT NULL,
  quantity          INTEGER     NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  -- Per-item estimate in minutes, used only when the item has no target time.
  estimated_minutes INTEGER     CHECK (estimated_minutes IS NULL OR estimated_minutes >= 0),
  department        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        TEXT        REFERENCES users(id) ON DELETE SET NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by        TEXT        REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_planned_work_start ON planned_work (start_date);
