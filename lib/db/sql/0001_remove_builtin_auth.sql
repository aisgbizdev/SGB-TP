-- Removes the built-in login system. IRREVERSIBLE: the data in these tables
-- and columns is lost. Review, take a backup, then run manually
-- (psql "$DATABASE_URL" -f lib/db/sql/0001_remove_builtin_auth.sql), or let
-- `pnpm --filter @workspace/db run push` apply the same diff.
-- `users` itself is kept: ~30 tables reference it.
BEGIN;

DROP TABLE IF EXISTS web_handoff_codes;
-- pending_tiktok_signups has an FK to mobile_oauth_transactions: drop it first.
DROP TABLE IF EXISTS pending_tiktok_signups;
DROP TABLE IF EXISTS mobile_oauth_transactions;
DROP TABLE IF EXISTS reauth_tokens;
DROP TABLE IF EXISTS password_reset_tokens;
DROP TABLE IF EXISTS auth_events;
DROP TABLE IF EXISTS sessions;

DROP TYPE IF EXISTS auth_event_type;
DROP TYPE IF EXISTS session_platform;

ALTER TABLE users
  DROP COLUMN IF EXISTS password_hash,
  DROP COLUMN IF EXISTS google_id,
  DROP COLUMN IF EXISTS apple_id,
  DROP COLUMN IF EXISTS facebook_id,
  DROP COLUMN IF EXISTS tiktok_id,
  DROP COLUMN IF EXISTS tiktok_display_name,
  DROP COLUMN IF EXISTS tiktok_avatar_url,
  DROP COLUMN IF EXISTS security_question,
  DROP COLUMN IF EXISTS security_answer_hash,
  DROP COLUMN IF EXISTS failed_reset_attempts,
  DROP COLUMN IF EXISTS reset_locked_until;

COMMIT;
