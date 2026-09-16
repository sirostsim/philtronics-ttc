-- 031_planned_work_commitment_value.sql
-- Commitment value (GBP) for a planned job, taken from the MOB's Commitment
-- Value column when a job is created by pasting MOB rows. Lets non-KLA jobs (which
-- have no customer_orders link) still show a value on the planner; KLA jobs still
-- fall back to the order-book-derived value when this is null.
--
-- Additive and non-destructive.

ALTER TABLE planned_work ADD COLUMN IF NOT EXISTS commitment_value NUMERIC
  CHECK (commitment_value IS NULL OR commitment_value >= 0);
