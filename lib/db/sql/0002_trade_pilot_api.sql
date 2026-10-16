-- Additive: TradePilot client-area API (/v1/trade-pilot). Safe to re-run.
BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS external_id text,
  ADD COLUMN IF NOT EXISTS account_mode text;

CREATE UNIQUE INDEX IF NOT EXISTS users_external_id_account_mode_unique
  ON users (external_id, account_mode);

CREATE TABLE IF NOT EXISTS tp_idempotency_keys (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL,
  request_hash text NOT NULL,
  status_code integer,
  response jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tp_idempotency_user_key_unique
  ON tp_idempotency_keys (user_id, key);

COMMIT;
