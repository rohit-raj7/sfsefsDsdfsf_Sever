-- Migration to create recharge_packs table
CREATE TABLE IF NOT EXISTS recharge_packs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    amount DECIMAL(10, 2) NOT NULL,
    extra_percent_or_amount DECIMAL(10, 2) DEFAULT 0.0,
    badge_text VARCHAR(50),
    is_active BOOLEAN DEFAULT TRUE,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for sorting
CREATE INDEX idx_recharge_packs_sort_order ON recharge_packs(sort_order);

-- Seed initial data based on hardcoded list in mobile
INSERT INTO recharge_packs (amount, extra_percent_or_amount, badge_text, sort_order) VALUES
(25, 0, NULL, 1),
(50, 6, NULL, 2),
(100, 15, NULL, 3),
(140, 20, 'Value Pack', 4),
(200, 25, NULL, 5),
(300, 35, 'Popular', 6),
(500, 35, NULL, 7),
(900, 35, NULL, 8),
(1900, 35, NULL, 9),
(9800, 35, NULL, 10);
