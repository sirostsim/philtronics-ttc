-- 025_planner_role.sql
-- Add the 'planner' role to the users.role check constraint.
--
-- Planner sits at manager's security level (see middleware/auth.js ROLE_HIERARCHY)
-- but is the role that -- together with superuser -- is permitted to WRITE the
-- planner and order book. Managers and administrators keep read-only planner
-- access. Backward-compatible: no existing rows use this value.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('operator','supervisor','manager','administrator','superuser','planner'));
