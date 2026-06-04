-- 014_availability_reasons.sql
-- Productivity availability tracking (stage one).
--
-- Productivity = active time / available time. Until now "available time" was a
-- fixed working day (480 min, or 300 on Friday) for every operator, which unfairly
-- penalised anyone who was in training, in a meeting, on a half-day, etc.
--
-- This migration introduces two things:
--
-- 1. availability_reasons — a managed list of pause/unavailable reasons. Each
--    reason is flagged is_available:
--      TRUE  = available but idle (e.g. tea break, waiting for materials). This
--              time STAYS in the denominator, so it does count against productivity.
--      FALSE = genuinely not available (training, meeting, absence, half-day,
--              late start). This time is SUBTRACTED from the denominator, so it
--              does NOT penalise the operator.
--
-- 2. unavailability_periods — recorded spans of non-available time per operator.
--    In stage one these are written when an operator pauses a timer using a
--    non-available reason. (Stage two adds an operator "Unavailable" action for
--    when no timer is running.)

CREATE TABLE IF NOT EXISTS availability_reasons (
  id            TEXT        PRIMARY KEY,
  label         TEXT        NOT NULL UNIQUE,
  is_available  BOOLEAN     NOT NULL DEFAULT TRUE,  -- TRUE = counts toward productivity
  sort_order    INTEGER     NOT NULL DEFAULT 100,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS unavailability_periods (
  id            TEXT        PRIMARY KEY,
  operator_id   TEXT        NOT NULL REFERENCES users(id),
  reason_id     TEXT        REFERENCES availability_reasons(id),
  reason_label  TEXT        NOT NULL,             -- denormalised snapshot of the label
  started_at    TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ,                      -- NULL while ongoing
  source        TEXT        NOT NULL DEFAULT 'pause', -- 'pause' (stage 1) | 'manual' (stage 2)
  timer_id      TEXT        REFERENCES timers(id),    -- the timer paused, if source = 'pause'
  created_by    TEXT        REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_unavail_operator_day
  ON unavailability_periods (operator_id, started_at);

-- Seed the agreed starting list. is_available = FALSE means "remove from the
-- available-time denominator". Managers can edit this list later (Admin).
INSERT INTO availability_reasons (id, label, is_available, sort_order) VALUES
  ('avr_break',      'Break',                 TRUE,  10),
  ('avr_materials',  'Waiting for materials', TRUE,  20),
  ('avr_machine',    'Machine / equipment issue', TRUE, 30),
  ('avr_other',      'Other',                 TRUE,  40),
  ('avr_training',   'Training',              FALSE, 50),
  ('avr_meeting',    'Meeting',               FALSE, 60),
  ('avr_absence',    'Absence / sickness',    FALSE, 70),
  ('avr_halfday',    'Half-day / left early', FALSE, 80),
  ('avr_late',       'Late start',            FALSE, 90)
ON CONFLICT (label) DO NOTHING;
