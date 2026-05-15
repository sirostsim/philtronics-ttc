-- 002_add_timer_fields.sql
-- Add time_check, workstation and wo_number fields to timers table

ALTER TABLE timers ADD COLUMN IF NOT EXISTS time_check  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE timers ADD COLUMN IF NOT EXISTS workstation TEXT;
ALTER TABLE timers ADD COLUMN IF NOT EXISTS wo_number   TEXT;

CREATE INDEX IF NOT EXISTS idx_timers_wo_number ON timers (wo_number);
