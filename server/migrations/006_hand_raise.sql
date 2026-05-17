-- 006_hand_raise.sql
-- Add hand-raise flag to active timers

ALTER TABLE timers ADD COLUMN IF NOT EXISTS hand_raised BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_timers_hand_raised ON timers (hand_raised) WHERE hand_raised = TRUE;
