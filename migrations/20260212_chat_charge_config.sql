-- Chat Charge Config table
-- Only one active config (latest by updated_at)
CREATE TABLE IF NOT EXISTS chat_charge_config (
    config_id SERIAL PRIMARY KEY,
    charging_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    free_message_limit INTEGER NOT NULL DEFAULT 5,
    message_block_size INTEGER NOT NULL DEFAULT 2,
    charge_per_message_block NUMERIC(10, 2) NOT NULL DEFAULT 1.00,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed default config if table is empty
INSERT INTO chat_charge_config (charging_enabled, free_message_limit, message_block_size, charge_per_message_block)
SELECT FALSE, 5, 2, 1.00
WHERE NOT EXISTS (SELECT 1 FROM chat_charge_config);
