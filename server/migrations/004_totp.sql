-- 004_totp.sql
-- Add TOTP two-factor authentication fields to users table
-- Applied to manager and administrator roles only

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial session tokens for mid-login TOTP verification
-- These are short-lived (5 minutes) and single-use
CREATE TABLE IF NOT EXISTS totp_challenges (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token        TEXT NOT NULL UNIQUE,
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_totp_challenges_token   ON totp_challenges (token);
CREATE INDEX IF NOT EXISTS idx_totp_challenges_expires ON totp_challenges (expires_at);
