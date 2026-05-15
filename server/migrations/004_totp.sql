-- 004_totp.sql
-- Add TOTP two-factor authentication fields to users table

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Short-lived challenge tokens for mid-login TOTP verification (5 min TTL)
CREATE TABLE IF NOT EXISTS totp_challenges (
  id         TEXT        PRIMARY KEY,
  user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT        NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_totp_challenges_token   ON totp_challenges (token);
CREATE INDEX IF NOT EXISTS idx_totp_challenges_expires ON totp_challenges (expires_at);
