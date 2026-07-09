-- 019_user_avatars.sql
-- Adds an optional profile image URL to each user. The image itself lives in
-- Cloudflare R2 (object storage); the database only stores the public URL that
-- points to it. Additive and non-destructive: existing users get NULL and
-- continue to show their initials, so the feature degrades gracefully.

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
