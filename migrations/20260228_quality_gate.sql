-- Quality Gate: Probation, Auto-Demotion, and Strike System

-- Add quality gate columns to listeners
ALTER TABLE listeners
ADD COLUMN IF NOT EXISTS quality_status VARCHAR(20) DEFAULT 'probation';
-- Values: 'probation', 'active', 'warning', 'suspended', 'banned'

ALTER TABLE listeners
ADD COLUMN IF NOT EXISTS probation_calls_remaining INTEGER DEFAULT 10;

ALTER TABLE listeners
ADD COLUMN IF NOT EXISTS warning_reason TEXT;

ALTER TABLE listeners
ADD COLUMN IF NOT EXISTS suspension_reason TEXT;

ALTER TABLE listeners
ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMP;

ALTER TABLE listeners
ADD COLUMN IF NOT EXISTS strike_count INTEGER DEFAULT 0;

ALTER TABLE listeners
ADD COLUMN IF NOT EXISTS avg_call_duration_seconds INTEGER DEFAULT 0;

ALTER TABLE listeners
ADD COLUMN IF NOT EXISTS hangup_rate DECIMAL(5, 2) DEFAULT 0.0;

ALTER TABLE listeners
ADD COLUMN IF NOT EXISTS short_calls_streak INTEGER DEFAULT 0;

-- Listener reports/strikes table
CREATE TABLE IF NOT EXISTS listener_reports (
  report_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listener_id UUID NOT NULL REFERENCES listeners(listener_id),
  reporter_user_id UUID NOT NULL REFERENCES users(user_id),
  call_id UUID REFERENCES calls(call_id),
  report_type VARCHAR(20) NOT NULL CHECK (report_type IN ('silent', 'rude', 'fake', 'boring')),
  description TEXT,
  strike_applied BOOLEAN DEFAULT FALSE,
  reviewed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_listener_reports_listener
ON listener_reports(listener_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_listeners_quality_status
ON listeners(quality_status);
