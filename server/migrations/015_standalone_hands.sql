-- 015_standalone_hands.sql
-- Lets an operator raise a hand BEFORE starting a job (e.g. can't find the route
-- card, machine won't start, unsure what to run). Until now a raised hand was a
-- flag on an active timer, so an operator with no job running could not signal
-- for help.
--
-- A standalone hand is a row here with lowered_at IS NULL. The /raised-hands feed
-- unions these with timer-based hands so supervisors see them identically.
--
-- Lifecycle:
--   raised  -> row inserted, lowered_at NULL
--   lowered -> lowered_at set (by operator, supervisor, or Lower All)
--   started a job -> the hand transfers onto the new timer (hand_raised = TRUE)
--                    and this row is closed (lowered_at set, transferred = TRUE)
--   end of day -> any still-open rows auto-closed by the schedule

CREATE TABLE IF NOT EXISTS standalone_hands (
  id            TEXT        PRIMARY KEY,
  operator_id   TEXT        NOT NULL REFERENCES users(id),
  operator_name TEXT        NOT NULL,
  department    TEXT,
  raised_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lowered_at    TIMESTAMPTZ,                       -- NULL while raised
  transferred   BOOLEAN     NOT NULL DEFAULT FALSE,-- TRUE if carried onto a timer
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one open standalone hand per operator.
CREATE UNIQUE INDEX IF NOT EXISTS idx_standalone_hand_one_open
  ON standalone_hands (operator_id)
  WHERE lowered_at IS NULL;
