-- 017_timer_quantity_runs.sql
-- Supports timing a run of multiple contiguous route cards under one timer.
-- An operator enters a starting route card and a quantity N; on completion the
-- single run is expanded into N completed timer rows (one per contiguous route
-- card), each carrying its share of the time, each individually traceable and
-- independently reworkable.
--
-- Additive and non-destructive: existing rows get quantity = 1 and run_id NULL,
-- which is exactly today's behaviour, so rollback is clean (revert code; these
-- columns sit harmless).

-- How many route cards the original run was entered as covering. On expanded
-- per-card rows this is 1 (each row is a single card). Kept on the run for audit.
ALTER TABLE timers ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1;

-- Links every per-card row that came from the same timed run, so it is always
-- provable that "these cards were one run". NULL for ordinary single-card jobs.
ALTER TABLE timers ADD COLUMN IF NOT EXISTS run_id TEXT;

-- Fast lookup of all cards belonging to one run.
CREATE INDEX IF NOT EXISTS idx_timers_run_id ON timers (run_id) WHERE run_id IS NOT NULL;
