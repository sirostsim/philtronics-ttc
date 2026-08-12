-- 029_planned_work_works_order.sql
-- Add our internal Works Order number to planned_work.
--
-- NOTE ON NAMING: planned_work.wo_number actually holds KLA's Purchasing Document
-- (the order-book matching key: item + PO + PO-line). It is relabelled
-- "Purchasing Document" in the UI. THIS column, works_order, is OUR internal work
-- order, which is not on either uploaded sheet -- the planner types it in. It is
-- display-only and is NEVER used for order-book matching. Additive/non-destructive.

ALTER TABLE planned_work ADD COLUMN IF NOT EXISTS works_order TEXT;
