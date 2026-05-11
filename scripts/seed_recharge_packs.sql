-- Seed Recharge Packs for CallTo Wallet
-- Run this on the production PostgreSQL database

-- First, ensure the table exists (from migration)
CREATE TABLE IF NOT EXISTS recharge_packs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    amount DECIMAL(10, 2) NOT NULL,
    extra_percent_or_amount DECIMAL(10, 2) DEFAULT 0,
    badge_text VARCHAR(50),
    is_active BOOLEAN DEFAULT TRUE,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_recharge_packs_sort_order ON recharge_packs(sort_order);

-- Clear existing packs (if any) before seeding
DELETE FROM recharge_packs;

-- Insert default recharge pack plans
INSERT INTO recharge_packs (amount, extra_percent_or_amount, badge_text, sort_order) VALUES
    (10,    0,   NULL,          1),
    (50,    5,   NULL,          2),
    (100,   10,  'Popular',     3),
    (200,   15,  'Best Value',  4),
    (500,   20,  'Most Popular',5),
    (1000,  25,  'VIP',         6);
