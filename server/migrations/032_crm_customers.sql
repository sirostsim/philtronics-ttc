-- 032_crm_customers.sql
-- CRM / RFQ module (Phase 1): canonical customer organisations, and an alias
-- table that maps the messy historical/source names (e.g. "Spts", "BRIDMET
-- LIMITED") to a single canonical customer, so the SharePoint import is
-- deterministic and repeatable. See docs/crm-rfq-spec.md.
--
-- Tables start empty: customers are populated by the import and the UI. The
-- alias->canonical mapping lives in code (the importer), which upserts here.
--
-- Additive and non-destructive.

CREATE TABLE IF NOT EXISTS customers (
  id          TEXT        PRIMARY KEY,
  name        TEXT        NOT NULL UNIQUE,   -- canonical display name, e.g. "SPTS (KLA)"
  code        TEXT,                          -- optional short code
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  TEXT        REFERENCES users(id) ON DELETE SET NULL
);

-- One canonical customer has many source-name aliases. Aliases are stored
-- lower-cased and matched case-insensitively by the importer.
CREATE TABLE IF NOT EXISTS customer_aliases (
  id          TEXT        PRIMARY KEY,
  customer_id TEXT        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  alias       TEXT        NOT NULL UNIQUE    -- lower-cased source name
);

CREATE INDEX IF NOT EXISTS idx_customer_aliases_customer ON customer_aliases (customer_id);
