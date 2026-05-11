CREATE TABLE IF NOT EXISTS offer_banner_config (
    config_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(120) NOT NULL,
    headline VARCHAR(120) NOT NULL,
    subtext VARCHAR(200) NOT NULL,
    button_text VARCHAR(120) NOT NULL,
    countdown_prefix VARCHAR(120) NOT NULL DEFAULT 'Offer ends in',
    recharge_amount NUMERIC(10, 2) NOT NULL,
    discounted_amount NUMERIC(10, 2) NOT NULL,
    min_wallet_balance NUMERIC(10, 2) NOT NULL DEFAULT 5.00,
    starts_at TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID REFERENCES admins(admin_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_offer_banner_config_updated_at
    ON offer_banner_config(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_offer_banner_config_active
    ON offer_banner_config(is_active, expires_at);

INSERT INTO offer_banner_config (
    title,
    headline,
    subtext,
    button_text,
    countdown_prefix,
    recharge_amount,
    discounted_amount,
    min_wallet_balance,
    starts_at,
    expires_at,
    is_active
)
SELECT
    'Limited Time Offer',
    'Flat 25% OFF',
    'on recharge of INR 100',
    'Recharge for INR 75',
    'Offer ends in',
    100.00,
    75.00,
    5.00,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP + INTERVAL '7 days',
    FALSE
WHERE NOT EXISTS (SELECT 1 FROM offer_banner_config);
