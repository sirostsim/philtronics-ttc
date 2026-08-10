-- 027_pause_events.sql
-- Append-only log of pause reasons that carry a free-text note.
--
-- timers.pause_reason is transient (cleared on resume) and available reasons like
-- 'Other' write no unavailability_period, so an 'Other' pause left no lasting
-- trace. This table persists the operator's typed detail for later review. It is
-- deliberately separate from unavailability_periods so it does NOT affect the
-- productivity / availability maths -- it is a record only.

CREATE TABLE IF NOT EXISTS pause_events (
  id            TEXT        PRIMARY KEY,
  timer_id      TEXT        REFERENCES timers(id) ON DELETE SET NULL,
  operator_id   TEXT        NOT NULL REFERENCES users(id),
  operator_name TEXT        NOT NULL,
  reason_id     TEXT,                             -- availability_reasons id snapshot (nullable)
  reason_label  TEXT        NOT NULL,             -- denormalised reason label
  note          TEXT,                             -- free-text detail (e.g. for 'Other')
  department    TEXT,
  paused_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pause_events_operator  ON pause_events (operator_id);
CREATE INDEX IF NOT EXISTS idx_pause_events_paused_at ON pause_events (paused_at);
