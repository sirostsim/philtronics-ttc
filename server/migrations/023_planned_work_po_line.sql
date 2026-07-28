-- 023_planned_work_po_line.sql
-- Capture the SAP schedule line (the order book "Item" column, e.g. 60) that a
-- planned job was created from. Together with item + PO it uniquely identifies an
-- order line across weekly uploads, so partial-quantity allocation ("3 of 7
-- planned, 4 remaining") can be computed exactly even when the same part appears
-- on the same PO across several lines. NULL for jobs added manually.
--
-- Additive and non-destructive.

ALTER TABLE planned_work ADD COLUMN IF NOT EXISTS source_po_line TEXT;
