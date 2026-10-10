-- 033_crm_rfqs.sql
-- CRM / RFQ module (Phase 1): the RFQ record and its children.
--   rfqs             - one part-quote request (matches the customer form)
--   rfq_assignees    - the internal people working it (ActionBy, can be several)
--   rfq_events       - the structured activity feed (replaces the free-text
--                      ActionComments log); internal vs customer-facing
--   rfq_attachments  - build packages / quote PDFs (R2); files land in Phase 2
--
-- Part numbers share the item-number namespace (target_times / order book).
-- Time estimates are stored in MINUTES (consistent with target_times) and shown
-- as hours in the UI. Pricing stays in Sage; we keep a quoted value + quote ref.
-- SLA metrics (days-to-complete, time-to-first-action) are computed from the
-- timestamps, not stored. See docs/crm-rfq-spec.md and docs/crm-rfq-phase1-plan.md.
--
-- Additive and non-destructive.

CREATE TABLE IF NOT EXISTS rfqs (
  id                       TEXT          PRIMARY KEY,
  rfq_number               TEXT          UNIQUE,          -- our ref, e.g. RFQ-2026-0042
  customer_id              TEXT          NOT NULL REFERENCES customers(id),
  part_number              TEXT,                          -- item-number namespace
  part_name                TEXT,
  revision                 TEXT,
  co_number                TEXT,
  quote_type               TEXT          CHECK (quote_type IS NULL OR quote_type IN ('new','up_rev')),
  priority                 TEXT          CHECK (priority IS NULL OR priority IN ('A','B','C')),
  date_required_by         DATE,
  free_issue               BOOLEAN,                       -- nullable (unknown)
  potential_units_annual   INTEGER,
  potential_revenue_annual NUMERIC(14,2),
  request_comments         TEXT,                          -- customer's notes
  contact_email            TEXT,
  status                   TEXT          NOT NULL DEFAULT 'open'
                             CHECK (status IN ('open','awaiting_response','completed','declined')),
  build_minutes            INTEGER,                       -- internal
  inspection_minutes       INTEGER,                       -- internal
  test_minutes             INTEGER,                       -- internal
  quoted_value             NUMERIC(14,2),                 -- internal (from Sage Sales Cost)
  quote_ref                TEXT,                          -- the QN#### reference
  quoted_at                DATE,
  sage_ref                 TEXT,                          -- reserved for Phase 4 Sage link
  source_created_at        TIMESTAMPTZ,                   -- original SharePoint Created (SLA/history)
  first_action_at          TIMESTAMPTZ,                   -- first internal action (SLA)
  completed_at             TIMESTAMPTZ,                   -- reached completed/declined
  external_source_id       TEXT          UNIQUE,          -- SharePoint Item ID; null for native rows
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by               TEXT          REFERENCES users(id) ON DELETE SET NULL,
  updated_at               TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_by               TEXT          REFERENCES users(id) ON DELETE SET NULL
);

-- ActionBy can be several people. user_id is null for an imported name that does
-- not match a Work Time user (name carries the display fallback).
CREATE TABLE IF NOT EXISTS rfq_assignees (
  id       TEXT PRIMARY KEY,
  rfq_id   TEXT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  name     TEXT
);

-- The activity feed. visibility is the internal/shared boundary for the eventual
-- customer portal. author_id is null for imported entries (author_name fallback).
CREATE TABLE IF NOT EXISTS rfq_events (
  id           TEXT        PRIMARY KEY,
  rfq_id       TEXT        NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  type         TEXT        NOT NULL,   -- comment / status_change / assignment / quote_issued / customer_message
  body         TEXT,
  visibility   TEXT        NOT NULL DEFAULT 'internal'
                 CHECK (visibility IN ('internal','customer')),
  author_id    TEXT        REFERENCES users(id) ON DELETE SET NULL,
  author_name  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rfq_attachments (
  id            TEXT        PRIMARY KEY,
  rfq_id        TEXT        NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  kind          TEXT,                                 -- build_package / quote_pdf / other
  filename      TEXT,
  r2_key        TEXT,
  content_type  TEXT,
  size_bytes    INTEGER,
  visibility    TEXT        NOT NULL DEFAULT 'internal'
                  CHECK (visibility IN ('internal','customer')),
  uploaded_by   TEXT        REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rfqs_customer    ON rfqs (customer_id);
CREATE INDEX IF NOT EXISTS idx_rfqs_status      ON rfqs (status);
CREATE INDEX IF NOT EXISTS idx_rfqs_part        ON rfqs (part_number);
CREATE INDEX IF NOT EXISTS idx_rfq_assignees_rfq ON rfq_assignees (rfq_id);
CREATE INDEX IF NOT EXISTS idx_rfq_events_rfq    ON rfq_events (rfq_id);
CREATE INDEX IF NOT EXISTS idx_rfq_attach_rfq    ON rfq_attachments (rfq_id);
