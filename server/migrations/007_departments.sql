-- 007_departments.sql
-- Add department support to users and timers

ALTER TABLE users  ADD COLUMN IF NOT EXISTS department TEXT NOT NULL DEFAULT 'Production';
ALTER TABLE timers ADD COLUMN IF NOT EXISTS department TEXT NOT NULL DEFAULT 'Production';

-- Index for filtering timers by department
CREATE INDEX IF NOT EXISTS idx_timers_department ON timers (department);
CREATE INDEX IF NOT EXISTS idx_users_department  ON users  (department);
