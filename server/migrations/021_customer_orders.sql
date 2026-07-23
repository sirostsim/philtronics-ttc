-- 021_customer_orders.sql
-- Imported customer order books (e.g. KLA's weekly SAP export). Each upload
-- REPLACES that customer's rows (latest snapshot wins). The Planner "available
-- to build" offering reads from here: items whose effective date (Required By,
-- falling back to Current Due Date) falls within the shippable window.
--
-- The raw import is kept whole; filtering (8-week window, rework, zero balance)
-- happens at read time so it can change without a re-upload.
--
-- Additive and non-destructive.

CREATE TABLE IF NOT EXISTS customer_orders (
  id            TEXT        PRIMARY KEY,
  customer      TEXT        NOT NULL,
  po_number     TEXT,                 -- Purchasing Document
  po_line       TEXT,                 -- Item (line within the PO)
  item_number   TEXT        NOT NULL, -- Part Number
  description   TEXT,                 -- Material Description
  required_by   DATE,                 -- NULL when the source had the 12/30/9999 sentinel
  due_date      DATE,                 -- Current Due Date
  quantity      INTEGER     NOT NULL DEFAULT 0,  -- Bal Due Qty (outstanding)
  line_value    NUMERIC(14,2),        -- commercial value of the line
  rework        BOOLEAN     NOT NULL DEFAULT FALSE,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by   TEXT        REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_orders_customer ON customer_orders (customer);
CREATE INDEX IF NOT EXISTS idx_customer_orders_item     ON customer_orders (item_number);
