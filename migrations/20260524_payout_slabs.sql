CREATE TABLE IF NOT EXISTS listener_payout_slabs (
    slab_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    start_duration INTEGER NOT NULL,
    end_duration INTEGER NOT NULL,
    payout_per_minute DECIMAL(10, 2) NULL, -- NULL indicates fallback to dynamic base payout
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID REFERENCES admins(admin_id) ON DELETE SET NULL,
    CONSTRAINT chk_start_duration CHECK (start_duration >= 0),
    CONSTRAINT chk_end_duration CHECK (end_duration >= start_duration),
    CONSTRAINT chk_payout_per_minute CHECK (payout_per_minute >= 0)
);

CREATE INDEX IF NOT EXISTS idx_listener_payout_slabs_start ON listener_payout_slabs(start_duration);
