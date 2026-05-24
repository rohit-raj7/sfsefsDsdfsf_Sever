ALTER TABLE listener_global_rate_config ADD COLUMN IF NOT EXISTS increment_interval_mins INTEGER DEFAULT 0;
ALTER TABLE listener_global_rate_config ADD COLUMN IF NOT EXISTS payout_increment NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE listener_global_rate_config ADD COLUMN IF NOT EXISTS max_payout_rate NUMERIC(10,2) DEFAULT 0.00;