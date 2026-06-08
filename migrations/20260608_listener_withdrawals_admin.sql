CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS listener_withdrawal_requests (
  request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listener_id UUID NOT NULL REFERENCES listeners(listener_id) ON DELETE CASCADE,
  payout_method VARCHAR(20) NOT NULL CHECK (payout_method IN ('upi', 'bank')),
  upi_id VARCHAR(255),
  account_number VARCHAR(32),
  ifsc_code VARCHAR(20),
  bank_name VARCHAR(120),
  account_holder_name VARCHAR(120),
  withdrawal_amount NUMERIC(12, 2) NOT NULL CHECK (withdrawal_amount > 0),
  tds_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (tds_amount >= 0),
  transaction_fee NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (transaction_fee >= 0),
  final_credit_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (final_credit_amount >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  transaction_id VARCHAR(120),
  remarks TEXT,
  approved_by UUID REFERENCES admins(admin_id) ON DELETE SET NULL,
  approved_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE listener_withdrawal_requests ADD COLUMN IF NOT EXISTS transaction_id VARCHAR(120);
ALTER TABLE listener_withdrawal_requests ADD COLUMN IF NOT EXISTS remarks TEXT;
ALTER TABLE listener_withdrawal_requests ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES admins(admin_id) ON DELETE SET NULL;
ALTER TABLE listener_withdrawal_requests ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_listener_withdrawal_requests_listener_created
  ON listener_withdrawal_requests(listener_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_listener_withdrawal_requests_status
  ON listener_withdrawal_requests(status);

CREATE INDEX IF NOT EXISTS idx_listener_withdrawal_requests_created
  ON listener_withdrawal_requests(created_at DESC);

CREATE TABLE IF NOT EXISTS listener_withdrawal_audit_logs (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID REFERENCES listener_withdrawal_requests(request_id) ON DELETE SET NULL,
  listener_id UUID REFERENCES listeners(listener_id) ON DELETE SET NULL,
  admin_id UUID REFERENCES admins(admin_id) ON DELETE SET NULL,
  previous_status VARCHAR(20),
  new_status VARCHAR(20) NOT NULL,
  remarks TEXT,
  request_payload JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_listener_withdrawal_audit_request
  ON listener_withdrawal_audit_logs(request_id, created_at DESC);
