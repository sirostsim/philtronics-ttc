-- 030_planned_work_assignees.sql
-- Assign one or more operatives to a planned job. Supervisors and above set the
-- assignment (a lighter permission than editing the plan); each assigned user
-- sees the job on their personal "My Work" board. Many-to-many: a job can have
-- several assignees and a user can have several jobs.
--
-- Additive and non-destructive.

CREATE TABLE IF NOT EXISTS planned_work_assignees (
  planned_work_id TEXT        NOT NULL REFERENCES planned_work(id) ON DELETE CASCADE,
  user_id         TEXT        NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by     TEXT        REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (planned_work_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_pwa_user ON planned_work_assignees (user_id);
CREATE INDEX IF NOT EXISTS idx_pwa_job  ON planned_work_assignees (planned_work_id);
