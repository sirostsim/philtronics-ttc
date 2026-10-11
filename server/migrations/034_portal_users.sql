-- 034_portal_users.sql
-- CRM customer portal (Phase 3): EXTERNAL customer identities, deliberately kept
-- OUT of the internal `users` table and the role hierarchy. An external customer
-- contact can never satisfy an internal requireRole/requireAuth check because it
-- is not an internal user at all. See docs/crm-portal-plan.md section 0.
--
--   portal_users   - a customer's portal login, bound to a customer (tenant)
--   portal_invites - invite tokens (we store a HASH, never the raw token)
--
-- Additive and non-destructive.

CREATE TABLE IF NOT EXISTS portal_users (
  id            TEXT        PRIMARY KEY,
  customer_id   TEXT        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  email         TEXT        NOT NULL UNIQUE,        -- stored lower-cased
  password_hash TEXT,                               -- null until an invite is accepted
  full_name     TEXT,
  totp_secret   TEXT,                               -- optional 2FA (later)
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_by    TEXT        REFERENCES users(id) ON DELETE SET NULL,  -- internal admin who invited
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS portal_invites (
  id          TEXT        PRIMARY KEY,
  customer_id TEXT        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  email       TEXT        NOT NULL,                 -- stored lower-cased
  full_name   TEXT,
  token_hash  TEXT        NOT NULL UNIQUE,          -- sha256 of the emailed token
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  invited_by  TEXT        REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portal_users_customer   ON portal_users (customer_id);
CREATE INDEX IF NOT EXISTS idx_portal_invites_customer ON portal_invites (customer_id);
CREATE INDEX IF NOT EXISTS idx_portal_invites_email    ON portal_invites (email);
