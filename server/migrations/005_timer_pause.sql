-- 005_timer_pause.sql
-- Add pause/resume support to timers

ALTER TABLE timers ADD COLUMN IF NOT EXISTS paused_at            TIMESTAMPTZ;
ALTER TABLE timers ADD COLUMN IF NOT EXISTS total_paused_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE timers ADD COLUMN IF NOT EXISTS pause_reason         TEXT;
-- 'manual' = operator/supervisor paused, 'schedule' = outside working hours
ALTER TABLE timers ADD COLUMN IF NOT EXISTS pause_type           TEXT;

CREATE INDEX IF NOT EXISTS idx_timers_paused ON timers (paused_at) WHERE paused_at IS NOT NULL;
