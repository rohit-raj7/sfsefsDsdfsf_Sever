-- ============================================
-- Dost Talk - Database Schema for AWS RDS PostgreSQL
-- ============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- USERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS users (
    user_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone_number VARCHAR(15) UNIQUE,
    email VARCHAR(255) UNIQUE,
    password_hash VARCHAR(255),
    auth_provider VARCHAR(20) DEFAULT 'phone' CHECK (auth_provider IN ('phone', 'google', 'facebook', 'email')),
    google_id VARCHAR(255) UNIQUE,
    facebook_id VARCHAR(255) UNIQUE,
    full_name VARCHAR(100),
    display_name VARCHAR(50),
    gender VARCHAR(10) CHECK (gender IN ('Male', 'Female', 'Other')),
    mobile_number VARCHAR(15), -- User's mobile number for contact
     languages TEXT[], -- Array of languages: ['Hindi', 'English', 'Kannada']
    date_of_birth DATE,
    city VARCHAR(100),
    country VARCHAR(100),
    avatar_url TEXT,
    bio TEXT,
    is_verified BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    wallet_balance DECIMAL(10, 2) DEFAULT 0.0,
    account_type VARCHAR(20) DEFAULT 'user' CHECK (account_type IN ('user', 'listener', 'both')),
    is_first_time_user BOOLEAN DEFAULT FALSE,
    offer_used BOOLEAN DEFAULT FALSE,
    offer_minutes_limit INTEGER,
    offer_flat_price DECIMAL(10, 2),
    fcm_token TEXT, -- For push notifications
    last_seen TIMESTAMP, -- Last seen timestamp for presence
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

-- ============================================
-- LISTENERS/EXPERTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS listeners (
    listener_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
    original_name VARCHAR(100), -- Real name (private)
    professional_name VARCHAR(100) NOT NULL, -- Display name
    age INTEGER,
    mobile_number VARCHAR(15), -- Listener's mobile number for payment/contact
    specialties TEXT[], -- Array of topics: ['Confidence', 'Marriage', 'Career']
    experiences TEXT[], -- Array of personal experiences: ['Love Failure', 'Job Loss', etc]
    languages TEXT[], -- Array of languages: ['Hindi', 'English', 'Kannada']
    rate_per_minute DECIMAL(10, 2) NOT NULL,
    user_rate_per_min DECIMAL(10, 2) NOT NULL,
    listener_payout_per_min DECIMAL(10, 2) NOT NULL,
    CHECK (listener_payout_per_min <= user_rate_per_min),
    currency VARCHAR(3) DEFAULT 'INR',
    average_rating DECIMAL(3, 2) DEFAULT 0.0,
    total_ratings INTEGER DEFAULT 0,
    total_calls INTEGER DEFAULT 0,
    total_minutes INTEGER DEFAULT 0,
    total_earning DECIMAL(10, 2) DEFAULT 0.0,
    is_online BOOLEAN DEFAULT FALSE,
    wallet_balance DECIMAL(10, 2) DEFAULT 0.0,
    last_active_at TIMESTAMP,
    is_available BOOLEAN DEFAULT TRUE,
    is_active BOOLEAN DEFAULT TRUE,
    is_busy BOOLEAN DEFAULT FALSE,
    is_verified BOOLEAN DEFAULT FALSE,
    verification_status VARCHAR(20) DEFAULT 'pending' CHECK (verification_status IN ('pending', 'approved', 'rejected')),
    voice_verified BOOLEAN DEFAULT FALSE,
    voice_verification_url TEXT,
    profile_image TEXT,
    background_image TEXT,
    experience_years INTEGER,
    education TEXT,
    certifications TEXT[] DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- OTP VERIFICATION TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS otp_verification (
    otp_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone_number VARCHAR(15) NOT NULL,
    otp_code VARCHAR(6) NOT NULL,
    is_verified BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for quick OTP lookup
CREATE INDEX idx_otp_phone ON otp_verification(phone_number, is_verified);

-- ============================================
-- LANGUAGE PREFERENCES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS user_languages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    language VARCHAR(50) NOT NULL,
    proficiency_level VARCHAR(20) CHECK (proficiency_level IN ('Native', 'Fluent', 'Basic')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- CALLS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS calls (
    call_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    caller_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    listener_id UUID REFERENCES listeners(listener_id) ON DELETE SET NULL,
    call_type VARCHAR(20) CHECK (call_type IN ('audio', 'video', 'random')),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'ringing', 'ongoing', 'completed', 'missed', 'rejected', 'cancelled')),
    started_at TIMESTAMP,
    ended_at TIMESTAMP,
    duration_seconds INTEGER DEFAULT 0,
    rate_per_minute DECIMAL(10, 2),
    total_cost DECIMAL(10, 2) DEFAULT 0.0,
    billed_minutes INTEGER,
    offer_applied BOOLEAN DEFAULT FALSE,
    offer_flat_price DECIMAL(10, 2),
    offer_minutes_limit INTEGER,
    is_rated BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for call history queries
CREATE INDEX idx_calls_caller ON calls(caller_id, created_at DESC);
CREATE INDEX idx_calls_listener ON calls(listener_id, created_at DESC);

-- ============================================
-- CALL RECORDS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS call_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    call_id UUID REFERENCES calls(call_id) ON DELETE SET NULL,
    user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    listener_id UUID REFERENCES listeners(listener_id) ON DELETE SET NULL,
    minutes INTEGER NOT NULL,
    user_charge DECIMAL(10, 2) NOT NULL,
    listener_earn DECIMAL(10, 2) NOT NULL,
    started_at TIMESTAMP,
    ended_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_call_records_user ON call_records(user_id, created_at DESC);
CREATE INDEX idx_call_records_listener ON call_records(listener_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_records_call_id ON call_records(call_id) WHERE call_id IS NOT NULL;

-- ============================================
-- CALL BILLING AUDIT LOG
-- ============================================
CREATE TABLE IF NOT EXISTS call_billing_audit (
    audit_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    call_id UUID REFERENCES calls(call_id) ON DELETE SET NULL,
    user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    listener_id UUID REFERENCES listeners(listener_id) ON DELETE SET NULL,
    minutes INTEGER NOT NULL,
    user_charge DECIMAL(10, 2) NOT NULL,
    listener_earn DECIMAL(10, 2) NOT NULL,
    user_rate_per_min DECIMAL(10, 2) NOT NULL,
    listener_payout_per_min DECIMAL(10, 2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_call_billing_audit_created_at ON call_billing_audit(created_at DESC);

-- ============================================
-- RATE CONFIGURATION TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS rate_config (
    config_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    normal_per_minute_rate DECIMAL(10, 2) NOT NULL,
    first_time_offer_enabled BOOLEAN DEFAULT FALSE,
    offer_minutes_limit INTEGER,
    offer_flat_price DECIMAL(10, 2),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rate_config_audit (
    audit_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    admin_id UUID REFERENCES admins(admin_id) ON DELETE SET NULL,
    previous_config JSONB,
    new_config JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rate_config_audit_created_at ON rate_config_audit(created_at DESC);

-- ============================================
-- OFFER BANNER CONFIGURATION TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS offer_banner_config (
    config_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(120) NOT NULL,
    headline VARCHAR(120) NOT NULL,
    subtext VARCHAR(200) NOT NULL,
    button_text VARCHAR(120) NOT NULL,
    countdown_prefix VARCHAR(120) NOT NULL DEFAULT 'Offer ends in',
    recharge_amount DECIMAL(10, 2) NOT NULL,
    discounted_amount DECIMAL(10, 2) NOT NULL,
    min_wallet_balance DECIMAL(10, 2) NOT NULL DEFAULT 5.00,
    starts_at TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID REFERENCES admins(admin_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_offer_banner_config_updated_at ON offer_banner_config(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_offer_banner_config_active ON offer_banner_config(is_active, expires_at);

-- ============================================
-- CHATS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS chats (
    chat_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user1_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    user2_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    last_message TEXT,
    last_message_at TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user1_id, user2_id)
);

-- Index for chat lookup
CREATE INDEX idx_chats_users ON chats(user1_id, user2_id);

-- ============================================
-- MESSAGES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS messages (
    message_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chat_id UUID REFERENCES chats(chat_id) ON DELETE CASCADE,
    sender_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    message_type VARCHAR(20) DEFAULT 'text' CHECK (message_type IN ('text', 'image', 'audio', 'video', 'file')),
    message_content TEXT NOT NULL,
    media_url TEXT,
    file_url TEXT,
    file_key TEXT,
    file_name TEXT,
    file_type VARCHAR(120),
    file_size BIGINT,
    uploaded_at TIMESTAMP,
    receiver_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    deleted_for UUID[] DEFAULT '{}',
    is_deleted_for_everyone BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMP,
    deleted_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
    is_read BOOLEAN DEFAULT FALSE,
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for message retrieval
CREATE INDEX idx_messages_chat ON messages(chat_id, created_at DESC);

-- ============================================
-- CONTACT MESSAGES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS contact_messages (
    contact_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source VARCHAR(20) NOT NULL CHECK (source IN ('contact', 'support')),
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_contact_messages_created_at ON contact_messages(created_at DESC);
CREATE INDEX idx_contact_messages_source ON contact_messages(source);

-- ============================================
-- DELETE ACCOUNT REQUESTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS delete_account_requests (
    request_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(20),
    reason TEXT NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'listener')),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_delete_requests_created_at ON delete_account_requests(created_at DESC);
CREATE INDEX idx_delete_requests_role ON delete_account_requests(role);
CREATE INDEX idx_delete_requests_status ON delete_account_requests(status);

-- ============================================
-- RATINGS & REVIEWS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS ratings (
    rating_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    call_id UUID REFERENCES calls(call_id) ON DELETE CASCADE,
    listener_id UUID REFERENCES listeners(listener_id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    rating DECIMAL(2, 1) CHECK (rating >= 1.0 AND rating <= 5.0),
    review_text TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for listener ratings
CREATE INDEX idx_ratings_listener ON ratings(listener_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_call_id ON ratings(call_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_user_listener_unique
ON ratings(user_id, listener_id)
WHERE user_id IS NOT NULL AND listener_id IS NOT NULL;

-- ============================================
-- APP RATINGS & FEEDBACK TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS app_ratings (
    app_rating_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    rating DECIMAL(2, 1) NOT NULL CHECK (rating >= 1.0 AND rating <= 5.0),
    feedback TEXT,
    source VARCHAR(30) DEFAULT 'mobile',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_app_ratings_created ON app_ratings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_ratings_user ON app_ratings(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_ratings_user_unique
ON app_ratings(user_id)
WHERE user_id IS NOT NULL;

-- ============================================
-- TRANSACTIONS/WALLET TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS transactions (
    transaction_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    transaction_type VARCHAR(20) CHECK (transaction_type IN ('credit', 'debit', 'refund', 'withdrawal')),
    amount DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'INR',
    description TEXT,
    payment_method VARCHAR(50),
    payment_gateway_id TEXT,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
    related_call_id UUID REFERENCES calls(call_id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for transaction history
CREATE INDEX idx_transactions_user ON transactions(user_id, created_at DESC);

-- ============================================
-- USER WALLET TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS wallets (
    wallet_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
    balance DECIMAL(10, 2) DEFAULT 0.0,
    currency VARCHAR(3) DEFAULT 'INR',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS call_gifts (
    gift_event_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    call_id UUID NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
    sender_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    listener_id UUID REFERENCES listeners(listener_id) ON DELETE SET NULL,
    listener_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    client_request_id VARCHAR(120) NOT NULL,
    gift_id VARCHAR(64) NOT NULL,
    gift_name VARCHAR(120) NOT NULL,
    asset_key VARCHAR(120) NOT NULL,
    gift_category VARCHAR(64) NOT NULL,
    rarity VARCHAR(32) NOT NULL,
    original_coin_amount DECIMAL(10, 2),
    coin_amount DECIMAL(10, 2) NOT NULL CHECK (coin_amount > 0),
    gift_description TEXT,
    sender_display_name VARCHAR(120),
    sender_avatar_url TEXT,
    listener_share_percent DECIMAL(5, 2) DEFAULT 50.00,
    listener_earning DECIMAL(10, 2) DEFAULT 0.00,
    platform_commission DECIMAL(10, 2) DEFAULT 0.00,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_call_gifts_sender_request
ON call_gifts(sender_id, client_request_id);

CREATE INDEX IF NOT EXISTS idx_call_gifts_call_created
ON call_gifts(call_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_gifts_listener_created
ON call_gifts(listener_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS call_gift_audit_logs (
    audit_log_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    gift_event_id UUID REFERENCES call_gifts(gift_event_id) ON DELETE SET NULL,
    sender_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    listener_id UUID REFERENCES listeners(listener_id) ON DELETE SET NULL,
    listener_user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    call_id UUID REFERENCES calls(call_id) ON DELETE SET NULL,
    gift_id VARCHAR(64),
    client_request_id VARCHAR(120),
    status VARCHAR(20) NOT NULL CHECK (status IN ('completed', 'duplicate', 'failed')),
    reason TEXT,
    request_payload JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_call_gift_audit_call_created
ON call_gift_audit_logs(call_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_gift_audit_sender_created
ON call_gift_audit_logs(sender_id, created_at DESC);

-- ============================================
-- GIFT CATALOG / REVENUE / WITHDRAWALS
-- ============================================
CREATE TABLE IF NOT EXISTS gifts (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    original_coin_amount DECIMAL(10, 2),
    coin_amount DECIMAL(10, 2) NOT NULL CHECK (coin_amount >= 0),
    category VARCHAR(64) NOT NULL,
    priority INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    icon_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gift_settings (
    singleton_key BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton_key = TRUE),
    listener_gift_share_percent NUMERIC(5, 2) NOT NULL DEFAULT 50.00,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS listener_gift_wallets (
    listener_id UUID PRIMARY KEY REFERENCES listeners(listener_id) ON DELETE CASCADE,
    total_earnings DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    available_balance DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    pending_withdrawals DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    total_withdrawn DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS listener_gift_earnings_ledger (
    ledger_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    listener_id UUID NOT NULL REFERENCES listeners(listener_id) ON DELETE CASCADE,
    gift_event_id UUID UNIQUE REFERENCES call_gifts(gift_event_id) ON DELETE CASCADE,
    transaction_id UUID REFERENCES transactions(transaction_id) ON DELETE SET NULL,
    amount DECIMAL(10, 2) NOT NULL CHECK (amount >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'withdrawn', 'reversed')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_listener_gift_ledger_listener_created
ON listener_gift_earnings_ledger(listener_id, created_at DESC);

CREATE TABLE IF NOT EXISTS listener_gift_withdrawal_requests (
    request_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    listener_id UUID NOT NULL REFERENCES listeners(listener_id) ON DELETE CASCADE,
    amount DECIMAL(10, 2) NOT NULL CHECK (amount > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'processed')),
    remarks TEXT,
    approved_by UUID REFERENCES admins(admin_id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_listener_gift_withdrawals_listener
ON listener_gift_withdrawal_requests(listener_id);

INSERT INTO gift_settings (listener_gift_share_percent)
SELECT 50.00
WHERE NOT EXISTS (SELECT 1 FROM gift_settings);

INSERT INTO gifts (id, name, original_coin_amount, coin_amount, category, priority, is_active, icon_url)
SELECT 'coffee', 'Coffee', 'A warm caffeine boost for an easy, cozy moment.', 29.00, 29.00, 'trending', 10, TRUE, NULL WHERE NOT EXISTS (SELECT 1 FROM gifts WHERE id = 'coffee');
INSERT INTO gifts (id, name, original_coin_amount, coin_amount, category, priority, is_active, icon_url)
SELECT 'rose', 'Rose', 'A timeless red rose that says you made my day.', 39.00, 39.00, 'romantic', 20, TRUE, NULL WHERE NOT EXISTS (SELECT 1 FROM gifts WHERE id = 'rose');
INSERT INTO gifts (id, name, original_coin_amount, coin_amount, category, priority, is_active, icon_url)
SELECT 'chocolate', 'Chocolate', 'A sweet premium treat to make the call feel warmer.', 49.00, 49.00, 'romantic', 30, TRUE, NULL WHERE NOT EXISTS (SELECT 1 FROM gifts WHERE id = 'chocolate');
INSERT INTO gifts (id, name, original_coin_amount, coin_amount, category, priority, is_active, icon_url)
SELECT 'teddy_bear', 'Teddy Bear', 'A soft plush surprise for comfort, cuteness, and charm.', 99.00, 99.00, 'romantic', 40, TRUE, NULL WHERE NOT EXISTS (SELECT 1 FROM gifts WHERE id = 'teddy_bear');
INSERT INTO gifts (id, name, original_coin_amount, coin_amount, category, priority, is_active, icon_url)
SELECT 'cake', 'Cake', 'A celebratory cake for birthdays, wins, and sweet moments.', 129.00, 129.00, 'celebration', 50, TRUE, NULL WHERE NOT EXISTS (SELECT 1 FROM gifts WHERE id = 'cake');
INSERT INTO gifts (id, name, original_coin_amount, coin_amount, category, priority, is_active, icon_url)
SELECT 'bouquet', 'Bouquet', 'A lush bouquet for elegant appreciation and admiration.', 159.00, 159.00, 'romantic', 60, TRUE, NULL WHERE NOT EXISTS (SELECT 1 FROM gifts WHERE id = 'bouquet');
INSERT INTO gifts (id, name, original_coin_amount, coin_amount, category, priority, is_active, icon_url)
SELECT 'perfume', 'Perfume', 'A designer fragrance drop with polished premium energy.', 299.00, 299.00, 'luxury', 70, TRUE, NULL WHERE NOT EXISTS (SELECT 1 FROM gifts WHERE id = 'perfume');
INSERT INTO gifts (id, name, original_coin_amount, coin_amount, category, priority, is_active, icon_url)
SELECT 'diamond_ring', 'Diamond Ring', 'A sparkling symbol of deep admiration and standout attention.', 399.00, 399.00, 'luxury', 80, TRUE, NULL WHERE NOT EXISTS (SELECT 1 FROM gifts WHERE id = 'diamond_ring');
INSERT INTO gifts (id, name, original_coin_amount, coin_amount, category, priority, is_active, icon_url)
SELECT 'luxury_watch', 'Luxury Watch', 'A refined timepiece that feels exclusive, bold, and sharp.', 499.00, 499.00, 'luxury', 90, TRUE, NULL WHERE NOT EXISTS (SELECT 1 FROM gifts WHERE id = 'luxury_watch');
INSERT INTO gifts (id, name, original_coin_amount, coin_amount, category, priority, is_active, icon_url)
SELECT 'sports_car', 'Sports Car', 'A blazing supercar gift for unforgettable grand entrances.', 899.00, 899.00, 'luxury', 100, TRUE, NULL WHERE NOT EXISTS (SELECT 1 FROM gifts WHERE id = 'sports_car');
INSERT INTO gifts (id, name, original_coin_amount, coin_amount, category, priority, is_active, icon_url)
SELECT 'private_jet', 'Private Jet', 'A sky-high flex that turns the moment instantly premium.', 1199.00, 1199.00, 'luxury', 110, TRUE, NULL WHERE NOT EXISTS (SELECT 1 FROM gifts WHERE id = 'private_jet');
INSERT INTO gifts (id, name, original_coin_amount, coin_amount, category, priority, is_active, icon_url)
SELECT 'golden_crown', 'Golden Crown', 'A royal tribute for listeners who made the call exceptional.', 1499.00, 1499.00, 'luxury', 120, TRUE, NULL WHERE NOT EXISTS (SELECT 1 FROM gifts WHERE id = 'golden_crown');
INSERT INTO gifts (id, name, original_coin_amount, coin_amount, category, priority, is_active, icon_url)
SELECT 'palace', 'Palace', 'A majestic palace gift reserved for truly iconic moments.', 1999.00, 1999.00, 'luxury', 130, TRUE, NULL WHERE NOT EXISTS (SELECT 1 FROM gifts WHERE id = 'palace');

-- ============================================
-- LISTENER PAYMENT DETAILS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS listener_payment_details (
    payment_detail_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    listener_id UUID UNIQUE REFERENCES listeners(listener_id) ON DELETE CASCADE,
    payment_method VARCHAR(20) CHECK (payment_method IN ('upi', 'bank')),
    mobile_number VARCHAR(15), -- Mobile number for payment
    -- UPI Fields
    upi_id VARCHAR(255),
    aadhaar_number VARCHAR(12),
    pan_number VARCHAR(10),
    name_as_per_pan VARCHAR(100),
    -- Bank Fields
    account_number VARCHAR(20),
    ifsc_code VARCHAR(11),
    bank_name VARCHAR(100),
    account_holder_name VARCHAR(100),
    pan_aadhaar_bank VARCHAR(20),
    -- Common
    is_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- FAVORITES/BOOKMARKS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS favorites (
    favorite_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    listener_id UUID REFERENCES listeners(listener_id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, listener_id)
);

-- ============================================
-- BLOCKED USERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS blocked_users (
    block_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    blocker_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    blocked_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(blocker_id, blocked_id)
);

-- ============================================
-- REPORTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS reports (
    report_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reporter_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
    reported_user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    report_type VARCHAR(50),
    description TEXT,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'resolved', 'dismissed')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- NOTIFICATION OUTBOX TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS notification_outbox (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(255) NOT NULL,
    body TEXT NOT NULL,
    target_role VARCHAR(20) NOT NULL, -- 'USER' or 'LISTENER'
    target_user_ids UUID[], -- NULL means 'All' for the role
    schedule_at TIMESTAMP, -- NULL means send immediately
    repeat_interval VARCHAR(20) CHECK (repeat_interval IN ('daily', 'weekly')),
    status VARCHAR(20) DEFAULT 'PENDING',
    created_by UUID REFERENCES admins(admin_id) ON DELETE SET NULL,
    retry_count INT DEFAULT 0,
    last_error TEXT,
    delivered_at TIMESTAMP,
    delivered_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_outbox_status_schedule ON notification_outbox(status, schedule_at);

-- ============================================
-- NOTIFICATION DELIVERIES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS notification_deliveries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    outbox_id UUID REFERENCES notification_outbox(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'PENDING', -- 'SENT', 'FAILED'
    delivered_at TIMESTAMP,
    error_message TEXT,
    last_error TEXT,
    retry_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_deliveries_outbox ON notification_deliveries(outbox_id);

-- ============================================
-- NOTIFICATIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS notifications (
    notification_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    notification_type VARCHAR(50),
    is_read BOOLEAN DEFAULT FALSE,
    data JSONB, -- Additional data in JSON format
    source_outbox_id UUID REFERENCES notification_outbox(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for user notifications
CREATE INDEX idx_notifications_user ON notifications(user_id, is_read, created_at DESC);

-- ============================================
-- LISTENER AVAILABILITY TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS listener_availability (
    availability_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    listener_id UUID REFERENCES listeners(listener_id) ON DELETE CASCADE,
    day_of_week INTEGER CHECK (day_of_week >= 0 AND day_of_week <= 6), -- 0 = Sunday
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    is_available BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- FUNCTIONS & TRIGGERS
-- ============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_listeners_updated_at BEFORE UPDATE ON listeners
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to update listener ratings
CREATE OR REPLACE FUNCTION update_listener_rating()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE listeners
    SET average_rating = (
        SELECT COALESCE(AVG(rating), 0)
        FROM ratings
        WHERE listener_id = NEW.listener_id
    ),
    total_ratings = (
        SELECT COUNT(*)
        FROM ratings
        WHERE listener_id = NEW.listener_id
    )
    WHERE listener_id = NEW.listener_id;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to auto-update listener ratings
CREATE TRIGGER update_listener_rating_trigger
    AFTER INSERT OR UPDATE ON ratings
    FOR EACH ROW EXECUTE FUNCTION update_listener_rating();

-- ============================================
-- SAMPLE DATA (Optional - for testing)
-- ============================================

-- Insert sample user (Male - Regular User)
INSERT INTO users (phone_number, email, full_name, display_name, gender, city, country, is_verified, account_type)
VALUES ('+919876543210', 'user@example.com', 'Rahul Kumar', 'Rahul', 'Male', 'Delhi', 'India', TRUE, 'user');

-- Insert sample listener users
INSERT INTO users (phone_number, email, full_name, display_name, gender, city, country, is_verified, account_type)
VALUES 
    ('+919876543211', 'khushi@example.com', 'Khushi Sharma', 'Khushi', 'Female', 'Delhi', 'India', TRUE, 'listener'),
    ('+919876543212', 'shrddha@example.com', 'Shrddha Patel', 'Shrddha', 'Female', 'Lucknow', 'India', TRUE, 'listener'),
    ('+919876543213', 'manisha@example.com', 'Manisha Shah', 'Manisha', 'Female', 'Ahmedabad', 'India', TRUE, 'listener');

-- Insert sample listeners
INSERT INTO listeners (user_id, professional_name, age, specialties, languages, rate_per_minute, user_rate_per_min, listener_payout_per_min, average_rating, total_ratings, is_online, is_available, is_verified)
SELECT 
    user_id,
    display_name,
    CASE 
        WHEN display_name = 'Khushi' THEN 23
        WHEN display_name = 'Shrddha' THEN 25
        ELSE 25
    END,
    CASE 
        WHEN display_name = 'Khushi' THEN ARRAY['Confidence', 'Relationship']
        WHEN display_name = 'Shrddha' THEN ARRAY['Confidence', 'Career']
        ELSE ARRAY['Confidence', 'Mental Health']
    END,
    ARRAY['Hindi', 'English'],
    5.00,
    5.00,
    1.00,
    CASE 
        WHEN display_name = 'Khushi' THEN 4.4
        WHEN display_name = 'Shrddha' THEN 5.0
        ELSE 4.4
    END,
    CASE 
        WHEN display_name = 'Shrddha' THEN 150
        ELSE 100
    END,
    TRUE,
    TRUE,
    TRUE
FROM users
WHERE account_type = 'listener';

-- ============================================
-- ADMINS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS admins (
    admin_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP
);

-- ============================================
-- LISTENER PAYOUT SLABS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS listener_payout_slabs (
    slab_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    start_duration INTEGER NOT NULL,
    end_duration INTEGER NOT NULL,
    payout_per_minute DECIMAL(10, 2) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_by UUID REFERENCES admins(admin_id) ON DELETE SET NULL,
    CONSTRAINT chk_start_duration CHECK (start_duration >= 0),
    CONSTRAINT chk_end_duration CHECK (end_duration >= start_duration),
    CONSTRAINT chk_payout_per_minute CHECK (payout_per_minute >= 0)
);

-- ============================================
-- INDEXES FOR PERFORMANCE
-- ============================================

CREATE INDEX idx_users_phone ON users(phone_number);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_listeners_online ON listeners(is_online, is_available);
CREATE INDEX idx_listeners_rating ON listeners(average_rating DESC);
CREATE INDEX idx_listener_payout_slabs_start ON listener_payout_slabs(start_duration);

-- ============================================
-- END OF SCHEMA
-- ============================================

