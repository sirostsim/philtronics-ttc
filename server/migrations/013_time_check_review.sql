-- 013_time_check_review.sql
-- Adds review workflow state to Time Check jobs.
--
-- When a Time Check timer is completed it becomes a "pending review": a manager
-- is prompted (live and via a homepage queue) to optionally set the measured
-- completion time as the new Target Time for that item number.
--
-- Lifecycle of tc_review_status:
--   NULL        -> not a pending review (default; all historical rows stay NULL)
--   'pending'   -> awaiting a manager decision
--   'applied'   -> a manager set/updated the item's target from this measurement
--   'dismissed' -> a manager decided not to change the target
--   'superseded'-> auto-cleared because another review for the same item was applied
--
-- Note: this migration deliberately does NOT backfill existing completed
-- Time Check jobs to 'pending'. Only jobs completed after this deploys enter
-- the queue, so managers are not faced with a large historical backlog.

ALTER TABLE timers ADD COLUMN IF NOT EXISTS tc_review_status   TEXT;
ALTER TABLE timers ADD COLUMN IF NOT EXISTS tc_reviewed_by     TEXT REFERENCES users(id);
ALTER TABLE timers ADD COLUMN IF NOT EXISTS tc_reviewed_at     TIMESTAMPTZ;
ALTER TABLE timers ADD COLUMN IF NOT EXISTS tc_applied_seconds INTEGER;

-- Fast lookup / count of the pending queue.
CREATE INDEX IF NOT EXISTS idx_timers_tc_pending
  ON timers (tc_review_status)
  WHERE tc_review_status = 'pending';
