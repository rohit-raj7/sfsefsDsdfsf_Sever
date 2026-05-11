-- ============================================
-- Listener rate + billing migration (2026-02-09)
-- ============================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC(10, 2) DEFAULT 0.0;

ALTER TABLE listeners
  ADD COLUMN IF NOT EXISTS user_rate_per_min NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS listener_payout_per_min NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS total_earning NUMERIC(10, 2) DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC(10, 2) DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

UPDATE listeners
SET user_rate_per_min = COALESCE(user_rate_per_min, rate_per_minute, 4.00),
    listener_payout_per_min = COALESCE(
      listener_payout_per_min,
      ROUND(COALESCE(rate_per_minute, 4.00) * 0.25, 2)
    )
WHERE user_rate_per_min IS NULL OR listener_payout_per_min IS NULL;

ALTER TABLE listeners
  ALTER COLUMN user_rate_per_min SET NOT NULL,
  ALTER COLUMN listener_payout_per_min SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'listeners_payout_rate_check'
  ) THEN
    ALTER TABLE listeners
      ADD CONSTRAINT listeners_payout_rate_check
      CHECK (listener_payout_per_min <= user_rate_per_min);
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS call_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id UUID REFERENCES calls(call_id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  listener_id UUID REFERENCES listeners(listener_id) ON DELETE SET NULL,
  minutes INTEGER NOT NULL,
  user_charge NUMERIC(10, 2) NOT NULL,
  listener_earn NUMERIC(10, 2) NOT NULL,
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_records_call_id
  ON call_records(call_id) WHERE call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_call_records_user
  ON call_records(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_records_listener
  ON call_records(listener_id, created_at DESC);

CREATE TABLE IF NOT EXISTS call_billing_audit (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id UUID REFERENCES calls(call_id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  listener_id UUID REFERENCES listeners(listener_id) ON DELETE SET NULL,
  minutes INTEGER NOT NULL,
  user_charge NUMERIC(10, 2) NOT NULL,
  listener_earn NUMERIC(10, 2) NOT NULL,
  user_rate_per_min NUMERIC(10, 2) NOT NULL,
  listener_payout_per_min NUMERIC(10, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_call_billing_audit_created_at
  ON call_billing_audit(created_at DESC);
