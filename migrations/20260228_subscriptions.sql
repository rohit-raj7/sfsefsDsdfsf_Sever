-- Subscriptions table for ₹999/year Random Premium plan
CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id),
  plan_type VARCHAR(30) NOT NULL DEFAULT 'random_premium',
  price DECIMAL(10, 2) NOT NULL DEFAULT 999.00,
  starts_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  payment_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Daily random call limit tracking for free users
ALTER TABLE users
ADD COLUMN IF NOT EXISTS random_calls_today INTEGER DEFAULT 0;

ALTER TABLE users
ADD COLUMN IF NOT EXISTS last_random_call_date DATE;

-- Index for fast subscription lookups
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_active
ON subscriptions(user_id, is_active)
WHERE is_active = TRUE;
