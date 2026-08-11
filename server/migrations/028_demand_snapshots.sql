-- 028_demand_snapshots.sql
-- Push/Pull: retain each Tuesday's KLA upload so demand can be diffed week over
-- week. Unlike customer_orders (which REPLACES the live order book each upload
-- and keeps no history), these tables archive every weekly snapshot of BOTH
-- sheets: the commercial order book and the priority-requirements demand list.
--
-- One demand_snapshots row per (customer, snapshot_date) upload; re-uploading a
-- week replaces it (the route deletes the snapshot first, cascading its lines).
--
-- Additive and non-destructive.

CREATE TABLE IF NOT EXISTS demand_snapshots (
  id                   TEXT        PRIMARY KEY,
  customer             TEXT        NOT NULL,
  snapshot_date        DATE        NOT NULL,      -- the Tuesday the export represents
  order_lines_count    INTEGER     NOT NULL DEFAULT 0,
  priority_lines_count INTEGER     NOT NULL DEFAULT 0,
  order_book_value     NUMERIC(16,2) NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by          TEXT        REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (customer, snapshot_date)
);

-- Order book lines for a snapshot (mirrors customer_orders, but history-scoped).
CREATE TABLE IF NOT EXISTS snapshot_order_lines (
  id            TEXT        PRIMARY KEY,
  snapshot_id   TEXT        NOT NULL REFERENCES demand_snapshots(id) ON DELETE CASCADE,
  po_number     TEXT,
  po_line       TEXT,
  item_number   TEXT        NOT NULL,
  description   TEXT,
  required_by   DATE,
  due_date      DATE,
  ordered_qty   INTEGER     NOT NULL DEFAULT 0,
  bal_due_qty   INTEGER     NOT NULL DEFAULT 0,
  line_value    NUMERIC(14,2),
  rework        BOOLEAN     NOT NULL DEFAULT FALSE
);

-- Priority-requirements (demand/pull) lines for a snapshot.
CREATE TABLE IF NOT EXISTS snapshot_priority_lines (
  id            TEXT        PRIMARY KEY,
  snapshot_id   TEXT        NOT NULL REFERENCES demand_snapshots(id) ON DELETE CASCADE,
  top_demand    TEXT,
  wo_number     TEXT,
  line_item     TEXT,
  start_date    DATE,                             -- Open Planned/WO Start date (need date)
  item_number   TEXT        NOT NULL,             -- Material (= Part Number)
  description   TEXT,
  qty           NUMERIC(12,3) NOT NULL DEFAULT 1  -- Qty Needed Per Slot
);

CREATE INDEX IF NOT EXISTS idx_snap_order_snap    ON snapshot_order_lines (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_snap_order_item    ON snapshot_order_lines (item_number);
CREATE INDEX IF NOT EXISTS idx_snap_priority_snap ON snapshot_priority_lines (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_snap_priority_item ON snapshot_priority_lines (item_number);
