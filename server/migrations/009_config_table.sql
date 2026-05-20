-- 009_config_table.sql
-- General key/value config store for site-wide settings

CREATE TABLE IF NOT EXISTS config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT REFERENCES users(id)
);

-- Default productivity target: 80%
INSERT INTO config (key, value) VALUES ('productivity_target_pct', '80')
ON CONFLICT (key) DO NOTHING;
