-- 022_planned_work_source.sql
-- Snapshot the customer required date at the moment a job is planned, so a
-- planned job can be linked back to its order line (item + PO/WO). This enables
-- MRP-style backward scheduling now, and drift highlighting later (when a
-- re-upload moves or drops the underlying order). NULL for jobs added manually
-- with no order-book link.
--
-- Additive and non-destructive.

ALTER TABLE planned_work ADD COLUMN IF NOT EXISTS source_required_by DATE;
