-- 024_planned_work_ordered_qty.sql
-- Snapshot the ordered quantity (the order line's Bal Due Qty) at the moment a
-- job is planned. This lets drift detection tell an intentional partial
-- allocation ("3 of 5 planned") apart from a genuine order-quantity change:
-- qty drift now fires only when the CURRENT ordered qty differs from this
-- snapshot, not merely when the planned qty is less than the order. NULL for
-- jobs added manually with no order-book link, and for jobs planned before this
-- column existed (those simply raise no qty drift).
--
-- Additive and non-destructive.

ALTER TABLE planned_work ADD COLUMN IF NOT EXISTS source_ordered_qty INTEGER;
