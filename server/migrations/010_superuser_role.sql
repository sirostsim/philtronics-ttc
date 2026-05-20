-- 010_superuser_role.sql
-- Add superuser role to the role check constraint

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('operator','supervisor','manager','administrator','superuser'));
