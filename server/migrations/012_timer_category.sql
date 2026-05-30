-- 012_timer_category.sql
-- Add timer_category to distinguish standard work from rework
-- Used for Right First Time (RFT) quality reporting

CREATE TYPE timer_category_enum AS (label TEXT); -- guard against re-run
DO $$
BEGIN
  ALTER TABLE timers ADD COLUMN IF NOT EXISTS timer_category TEXT
    NOT NULL DEFAULT 'work'
    CHECK (timer_category IN ('work', 'rework'));
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

COMMENT ON COLUMN timers.timer_category IS
  'work = standard production timer (default). '
  'rework = corrective work on a previously completed assembly.';
