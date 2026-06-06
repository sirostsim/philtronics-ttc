-- 016_settings_defaults.sql
-- Per-customer configuration layer (WT-DESIGN-001), stage 1: seed every
-- configurable setting into the existing config key/value store, using the
-- CURRENT Philtronics behaviour as the default for each.
--
-- Nothing changes behaviour: the settings loader (server/settings.js) reads
-- these values, and every value below is exactly what was previously hard-coded.
-- An instance that never overrides a key behaves identically to before.
--
-- Structured values (per-weekday hours, label overrides) are stored as JSON
-- under a single key. Simple values are plain strings.

-- ── Branding ────────────────────────────────────────────────────────────────
INSERT INTO config (key, value) VALUES
  ('brand_customer_name', 'Philtronics Ltd')        ON CONFLICT (key) DO NOTHING;
INSERT INTO config (key, value) VALUES
  ('brand_primary_colour', '#2e75b6')               ON CONFLICT (key) DO NOTHING;
INSERT INTO config (key, value) VALUES
  ('brand_login_text', '')                          ON CONFLICT (key) DO NOTHING;
INSERT INTO config (key, value) VALUES
  ('brand_logo_url', '')                            ON CONFLICT (key) DO NOTHING;

-- ── Working hours ───────────────────────────────────────────────────────────
-- Timezone for all time-of-day rules.
INSERT INTO config (key, value) VALUES
  ('hours_timezone', 'Europe/London')               ON CONFLICT (key) DO NOTHING;
-- Day start (HH:MM, local).
INSERT INTO config (key, value) VALUES
  ('hours_start', '07:45')                           ON CONFLICT (key) DO NOTHING;
-- Per-weekday end times (JSON; null = non-working day). Mon-Thu 16:30, Fri 13:00.
INSERT INTO config (key, value) VALUES
  ('hours_end_by_day',
   '{"mon":"16:30","tue":"16:30","wed":"16:30","thu":"16:30","fri":"13:00","sat":null,"sun":null}')
   ON CONFLICT (key) DO NOTHING;
-- Break + lunch minutes deducted from the clock window to give the productivity
-- baseline. Mon-Thu: 15m break + 30m lunch = 45. Fri: 15m break = 15.
INSERT INTO config (key, value) VALUES
  ('hours_break_minutes',
   '{"mon":45,"tue":45,"wed":45,"thu":45,"fri":15,"sat":0,"sun":0}')
   ON CONFLICT (key) DO NOTHING;

-- ── Productivity / quality thresholds ────────────────────────────────────────
-- productivity_target_pct already seeded by migration 009 (default 80).
INSERT INTO config (key, value) VALUES
  ('warning_threshold_pct', '80')                    ON CONFLICT (key) DO NOTHING;
INSERT INTO config (key, value) VALUES
  ('overdue_threshold_pct', '100')                   ON CONFLICT (key) DO NOTHING;
-- Fallback warning for jobs with no target, in minutes (currently 2 hours).
INSERT INTO config (key, value) VALUES
  ('no_target_warning_minutes', '120')               ON CONFLICT (key) DO NOTHING;

-- ── Feature toggles (all ON = current behaviour) ─────────────────────────────
INSERT INTO config (key, value) VALUES ('feature_time_check', 'on')        ON CONFLICT (key) DO NOTHING;
INSERT INTO config (key, value) VALUES ('feature_raised_hands', 'on')      ON CONFLICT (key) DO NOTHING;
INSERT INTO config (key, value) VALUES ('feature_messaging', 'on')         ON CONFLICT (key) DO NOTHING;
INSERT INTO config (key, value) VALUES ('feature_availability', 'on')      ON CONFLICT (key) DO NOTHING;
INSERT INTO config (key, value) VALUES ('feature_quality_rft', 'on')       ON CONFLICT (key) DO NOTHING;
INSERT INTO config (key, value) VALUES ('feature_two_factor', 'on')        ON CONFLICT (key) DO NOTHING;

-- ── Terminology overrides (JSON; empty = use built-in labels) ────────────────
INSERT INTO config (key, value) VALUES ('terminology', '{}')               ON CONFLICT (key) DO NOTHING;
