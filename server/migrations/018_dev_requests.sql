-- 018_dev_requests.sql
-- "Dev Requests": a light forum where supervisors and above can request system
-- improvements, discuss them, and upvote. Visible to supervisor+ ; status is
-- controlled solely by the superuser. Authors edit their own request and their
-- own comments; the superuser can edit/delete anything. The thread stays open
-- in every status, including 'declined'.
--
-- Additive and non-destructive: three new tables, nothing existing touched.

CREATE TABLE IF NOT EXISTS dev_requests (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'requested',
  author_id    TEXT NOT NULL,
  author_name  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- last_activity_at advances on new comments so the list can sort by liveliness
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Status is one of a fixed set. Enforced in app code too; this is a safety net.
-- requested -> under_review -> planned -> in_progress -> done ; plus declined.
CREATE INDEX IF NOT EXISTS idx_dev_requests_status   ON dev_requests (status);
CREATE INDEX IF NOT EXISTS idx_dev_requests_activity ON dev_requests (last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_dev_requests_author   ON dev_requests (author_id);

CREATE TABLE IF NOT EXISTS dev_request_comments (
  id           TEXT PRIMARY KEY,
  request_id   TEXT NOT NULL REFERENCES dev_requests(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  author_id    TEXT NOT NULL,
  author_name  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited       BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_dev_comments_request ON dev_request_comments (request_id, created_at);

CREATE TABLE IF NOT EXISTS dev_request_votes (
  request_id   TEXT NOT NULL REFERENCES dev_requests(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (request_id, user_id)   -- one vote per user per request
);
CREATE INDEX IF NOT EXISTS idx_dev_votes_request ON dev_request_votes (request_id);
