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
-- TRUSTED DEVICES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS trusted_devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
    device_id VARCHAR(255) NOT NULL,
    platform VARCHAR(50),
    device_name VARCHAR(255),
    app_version VARCHAR(50),
    is_trusted BOOLEAN DEFAULT TRUE,
    first_login_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, device_id)
);

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
