-- Additive: saved trading plans for /v1/trade-pilot/trading-plans. Safe to re-run.
BEGIN;

CREATE TABLE IF NOT EXISTS tp_trading_plans (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  analysis_id integer NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
  variant text NOT NULL,
  account_type text NOT NULL,
  trading_capital text NOT NULL,
  loss_limit text NOT NULL,
  risk_style text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tp_trading_plans_user_analysis_variant_unique
  ON tp_trading_plans (user_id, analysis_id, variant);

COMMIT;
