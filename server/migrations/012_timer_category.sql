-- 012_timer_category.sql
-- Add timer_category to distinguish standard work from rework
-- Used for Right First Time (RFT) quality reporting

ALTER TABLE timers
  ADD COLUMN IF NOT EXISTS timer_category TEXT NOT NULL DEFAULT 'work'
  CHECK (timer_category IN ('work', 'rework'));

COMMENT ON COLUMN timers.timer_category IS
  'work = standard production timer (default). rework = corrective work on a previously completed assembly.';
