import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

// ============================================
// DEVICE-TIME FIX: Override pg TIMESTAMP parser for correct timezone handling
// All database sessions are forced to UTC via pool.on('connect') below.
// Raw TIMESTAMP WITHOUT TIMEZONE values from PostgreSQL are therefore in UTC.
// This parser appends 'Z' suffix to produce proper UTC ISO 8601 strings.
// No hardcoded timezone offsets — the mobile client converts UTC to device
// local time using DateTime.toLocal() for correct display.
// ============================================
const pgTypes = pkg.types;

// OID 1114 = TIMESTAMP WITHOUT TIMEZONE
pgTypes.setTypeParser(1114, function parseTimestampAsUTC(val) {
  if (!val) return null;
  // Raw value is in UTC (session timezone forced to UTC via pool.on('connect'))
  // Append 'Z' suffix so clients know this is a UTC ISO 8601 string
  return val.replace(' ', 'T') + 'Z';
});

// Configure the PostgreSQL connection pool
// Increased limits and timeouts to handle connection instability and high traffic
const poolConfig = {
  ...(process.env.DATABASE_PUBLIC_URL
    ? { connectionString: process.env.DATABASE_PUBLIC_URL }
    : {
        host: process.env.DB_HOST,
        port: process.env.DB_PORT || 5432,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
      }),
  max: 20, // Increased from 5 to 20
  idleTimeoutMillis: 30000, // Increased from 10s to 30s
  connectionTimeoutMillis: 30000, // Increased from 10s to 30s
};

// Only enforce SSL if explicitly told to via environment variables 
// (Self-hosted Postgres containers usually don't support SSL out of the box)
if (process.env.DB_REQUIRE_SSL === 'true') {
  poolConfig.ssl = {
    rejectUnauthorized: false
  };
}

const pool = new Pool(poolConfig);

// Handle unexpected errors on idle clients
pool.on('error', (err, client) => {
  console.error('Unexpected error on idle database client:', err.message);
});

// DEVICE-TIME FIX: Force all database sessions to UTC so CURRENT_TIMESTAMP
// always stores UTC values. This prevents timezone ambiguity with
// TIMESTAMP WITHOUT TIMEZONE columns regardless of server location.
// NOTE: async callback + await — pg-pool waits for the promise before returning
// the client to the caller, preventing the "client already executing a query" warning.
pool.on('connect', async (client) => {
  await client.query("SET timezone = 'UTC'");
});

// Test the database connection
async function testConnection(retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const client = await pool.connect();
      console.log('✓ Successfully connected to PostgreSQL database');
      
      // Test query
      const result = await client.query('SELECT NOW()');
      console.log('Current database time:', result.rows[0].now);
      
      client.release();
      return true;
    } catch (error) {
      console.error(`✗ Error connecting to the database (attempt ${attempt}/${retries}):`, error.message);
      if (attempt === retries) {
        return false;
      }
      // Wait 2 seconds before retrying
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// Ensure required columns exist on startup (non-destructive)
async function ensureSchema() {
  try {
    // Ensure UUID function is available
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

    // Terminate any idle-in-transaction sessions left by previously killed processes
    await pool.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE state = 'idle in transaction' AND pid <> pg_backend_pid()
    `);

    // Create admins table FIRST (notification_outbox references it)
    const createAdminsSql = `
      CREATE TABLE IF NOT EXISTS admins (
        admin_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        full_name VARCHAR(100),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      );
    `;
    await pool.query(createAdminsSql);
    console.log('✓ Ensured admins table exists');

    // Create core tables BEFORE any table that references them
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone_number VARCHAR(15) UNIQUE,
        email VARCHAR(255) UNIQUE,
        password_hash VARCHAR(255),
        auth_provider VARCHAR(20) DEFAULT 'phone',
        google_id VARCHAR(255) UNIQUE,
        facebook_id VARCHAR(255) UNIQUE,
        full_name VARCHAR(100),
        display_name VARCHAR(50),
        gender VARCHAR(10),
        mobile_number VARCHAR(15),
        languages TEXT[],
        date_of_birth DATE,
        city VARCHAR(100),
        country VARCHAR(100),
        avatar_url TEXT,
        bio TEXT,
        is_verified BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        wallet_balance DECIMAL(10, 2) DEFAULT 0.0,
        account_type VARCHAR(20) DEFAULT 'user',
        is_first_time_user BOOLEAN DEFAULT FALSE,
        offer_used BOOLEAN DEFAULT FALSE,
        offer_minutes_limit INTEGER,
        offer_flat_price DECIMAL(10, 2),
        fcm_token TEXT,
        last_seen TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP,
        active_session_id VARCHAR(255)
      );
    `);
    console.log('✓ Ensured users table exists');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS listeners (
        listener_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
        original_name VARCHAR(100),
        professional_name VARCHAR(100) NOT NULL,
        age INTEGER,
        mobile_number VARCHAR(15),
        specialties TEXT[],
        experiences TEXT[],
        languages TEXT[],
        rate_per_minute DECIMAL(10, 2) NOT NULL,
        user_rate_per_min DECIMAL(10, 2),
        listener_payout_per_min DECIMAL(10, 2),
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
        verification_status VARCHAR(20) DEFAULT 'pending',
        voice_verified BOOLEAN DEFAULT FALSE,
        voice_verification_url TEXT,
        listener_type VARCHAR(20) DEFAULT 'full',
        profile_image TEXT,
        background_image TEXT,
        experience_years INTEGER,
        education TEXT,
        certifications TEXT[] DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✓ Ensured listeners table exists');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS calls (
        call_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        caller_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
        listener_id UUID REFERENCES listeners(listener_id) ON DELETE SET NULL,
        call_type VARCHAR(20),
        status VARCHAR(20) DEFAULT 'pending',
        started_at TIMESTAMP,
        ended_at TIMESTAMP,
        duration_seconds INTEGER DEFAULT 0,
        rate_per_minute DECIMAL(10, 2),
        billed_user_rate_per_min DECIMAL(10, 2),
        billed_payout_rate_per_min DECIMAL(10, 2),
        total_cost DECIMAL(10, 2) DEFAULT 0.0,
        billed_minutes INTEGER,
        offer_applied BOOLEAN DEFAULT FALSE,
        offer_flat_price DECIMAL(10, 2),
        offer_minutes_limit INTEGER,
        is_rated BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✓ Ensured calls table exists');

    await pool.query(`
      ALTER TABLE calls ADD COLUMN IF NOT EXISTS billed_user_rate_per_min DECIMAL(10, 2);
      ALTER TABLE calls ADD COLUMN IF NOT EXISTS billed_payout_rate_per_min DECIMAL(10, 2);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        notification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        notification_type VARCHAR(50),
        is_read BOOLEAN DEFAULT FALSE,
        data JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at DESC);
    `);
    console.log('✓ Ensured notifications table exists');

    // Create remaining core tables that other parts of the app depend on
    await pool.query(`
      CREATE TABLE IF NOT EXISTS otp_verification (
        otp_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone_number VARCHAR(15) NOT NULL,
        otp_code VARCHAR(6) NOT NULL,
        is_verified BOOLEAN DEFAULT FALSE,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_verification(phone_number, is_verified);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS otp_tracking (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(20) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ratings (
        rating_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        call_id UUID REFERENCES calls(call_id) ON DELETE CASCADE,
        listener_id UUID REFERENCES listeners(listener_id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
        rating DECIMAL(2, 1) CHECK (rating >= 1.0 AND rating <= 5.0),
        review_text TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_ratings_listener ON ratings(listener_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_call_id ON ratings(call_id);
      -- Keep only the latest row per user+listener before enforcing uniqueness.
      DELETE FROM ratings older
      USING ratings newer
      WHERE older.user_id IS NOT NULL
        AND older.listener_id IS NOT NULL
        AND older.user_id = newer.user_id
        AND older.listener_id = newer.listener_id
        AND (
          older.created_at < newer.created_at
          OR (
            older.created_at = newer.created_at
            AND older.rating_id::text < newer.rating_id::text
          )
        );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_user_listener_unique
      ON ratings(user_id, listener_id)
      WHERE user_id IS NOT NULL AND listener_id IS NOT NULL;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_ratings (
        app_rating_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
        rating DECIMAL(2, 1) NOT NULL CHECK (rating >= 1.0 AND rating <= 5.0),
        feedback TEXT,
        source VARCHAR(30) DEFAULT 'mobile',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE app_ratings
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

      -- Keep only the latest row per user before enforcing uniqueness
      DELETE FROM app_ratings older
      USING app_ratings newer
      WHERE older.user_id IS NOT NULL
        AND older.user_id = newer.user_id
        AND (
          older.created_at < newer.created_at
          OR (
            older.created_at = newer.created_at
            AND older.app_rating_id::text < newer.app_rating_id::text
          )
        );

      CREATE INDEX IF NOT EXISTS idx_app_ratings_created ON app_ratings(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_app_ratings_user ON app_ratings(user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_app_ratings_user_unique
      ON app_ratings(user_id)
      WHERE user_id IS NOT NULL;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
      CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id, created_at DESC);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS wallets (
        wallet_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
        balance DECIMAL(10, 2) DEFAULT 0.0,
        currency VARCHAR(3) DEFAULT 'INR',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
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
      CREATE INDEX IF NOT EXISTS idx_subscriptions_user_active
      ON subscriptions(user_id, is_active)
      WHERE is_active = TRUE;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS listener_reports (
        report_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        listener_id UUID NOT NULL REFERENCES listeners(listener_id),
        reporter_user_id UUID NOT NULL REFERENCES users(user_id),
        call_id UUID REFERENCES calls(call_id),
        report_type VARCHAR(20) NOT NULL,
        description TEXT,
        strike_applied BOOLEAN DEFAULT FALSE,
        reviewed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_listener_reports_listener
      ON listener_reports(listener_id, created_at DESC);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS listener_payment_details (
        payment_detail_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        listener_id UUID UNIQUE REFERENCES listeners(listener_id) ON DELETE CASCADE,
        payment_method VARCHAR(20) CHECK (payment_method IN ('upi', 'bank')),
        mobile_number VARCHAR(15),
        upi_id VARCHAR(255),
        aadhaar_number VARCHAR(12),
        pan_number VARCHAR(10),
        name_as_per_pan VARCHAR(100),
        account_number VARCHAR(20),
        ifsc_code VARCHAR(11),
        bank_name VARCHAR(100),
        account_holder_name VARCHAR(100),
        pan_aadhaar_bank VARCHAR(20),
        is_verified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS chats (
        chat_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user1_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        user2_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        last_message TEXT,
        last_message_at TIMESTAMP,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user1_id, user2_id)
      );
      CREATE INDEX IF NOT EXISTS idx_chats_users ON chats(user1_id, user2_id);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chat_id UUID REFERENCES chats(chat_id) ON DELETE CASCADE,
        sender_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
        message_type VARCHAR(20) DEFAULT 'text',
        message_content TEXT NOT NULL,
        media_url TEXT,
        is_read BOOLEAN DEFAULT FALSE,
        read_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at DESC);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS favorites (
        favorite_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        listener_id UUID REFERENCES listeners(listener_id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, listener_id)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS blocked_users (
        block_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        blocker_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        blocked_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(blocker_id, blocked_id)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS reports (
        report_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        reporter_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
        reported_user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        report_type VARCHAR(50),
        description TEXT,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'resolved', 'dismissed')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_languages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
        language VARCHAR(50) NOT NULL,
        proficiency_level VARCHAR(20) CHECK (proficiency_level IN ('Native', 'Fluent', 'Basic')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_listener_follows (
        follow_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        follower_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        listener_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_user_listener_follow UNIQUE (follower_user_id, listener_user_id),
        CONSTRAINT chk_no_self_follow CHECK (follower_user_id <> listener_user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_user_listener_follows_listener ON user_listener_follows(listener_user_id);
      CREATE INDEX IF NOT EXISTS idx_user_listener_follows_follower ON user_listener_follows(follower_user_id);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS listener_availability (
        availability_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        listener_id UUID REFERENCES listeners(listener_id) ON DELETE CASCADE,
        day_of_week INTEGER CHECK (day_of_week >= 0 AND day_of_week <= 6),
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        is_available BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS recharge_packs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        amount DECIMAL(10, 2) NOT NULL,
        extra_percent_or_amount DECIMAL(10, 2) DEFAULT 0.0,
        badge_text VARCHAR(50),
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_recharge_packs_sort_order ON recharge_packs(sort_order);
    `);

    console.log('✓ Ensured all remaining core tables exist');

    const createOutboxSql = `
      CREATE TABLE IF NOT EXISTS notification_outbox (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(255) NOT NULL,
        body TEXT NOT NULL,
        target_role VARCHAR(20) NOT NULL CHECK (target_role IN ('USER','LISTENER')),
        target_user_ids UUID[] NULL,
        schedule_at TIMESTAMP NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','SENT','FAILED')),
        created_by UUID NOT NULL REFERENCES admins(admin_id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        delivered_at TIMESTAMP NULL,
        retry_count INTEGER DEFAULT 0,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_notification_outbox_schedule ON notification_outbox(schedule_at);
      CREATE INDEX IF NOT EXISTS idx_notification_outbox_status ON notification_outbox(status);
      CREATE INDEX IF NOT EXISTS idx_notification_outbox_target_role ON notification_outbox(target_role);
    `;
    await pool.query(createOutboxSql);

    const createDeliveriesSql = `
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        outbox_id UUID NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED')),
        delivered_at TIMESTAMP NULL,
        retry_count INTEGER DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(outbox_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_notification_deliveries_status ON notification_deliveries(status);
      CREATE INDEX IF NOT EXISTS idx_notification_deliveries_user ON notification_deliveries(user_id);
    `;
    await pool.query(createDeliveriesSql);

    // Add repeat_interval column if missing
    const alterOutboxSql = `
      ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS repeat_interval VARCHAR(20) DEFAULT NULL;
    `;
    await pool.query(alterOutboxSql);

    // Add delivered_count column (tracks how many users each notification reached)
    await pool.query(`ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS delivered_count INTEGER NOT NULL DEFAULT 0`);

    const alterNotificationsSql = `
      ALTER TABLE notifications ADD COLUMN IF NOT EXISTS source_outbox_id UUID;
      CREATE INDEX IF NOT EXISTS idx_notifications_source_outbox ON notifications(source_outbox_id);
    `;
    await pool.query(alterNotificationsSql);

    const createContactMessagesSql = `
      CREATE TABLE IF NOT EXISTS contact_messages (
        contact_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source VARCHAR(20) NOT NULL CHECK (source IN ('contact', 'support')),
        name VARCHAR(100) NOT NULL,
        email VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_contact_messages_created_at ON contact_messages(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_contact_messages_source ON contact_messages(source);
    `;
    await pool.query(createContactMessagesSql);

    const createDeleteRequestsSql = `
      CREATE TABLE IF NOT EXISTS delete_account_requests (
        request_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(255),
        phone VARCHAR(20),
        reason TEXT NOT NULL,
        role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'listener')),
        status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_delete_requests_created_at ON delete_account_requests(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_delete_requests_role ON delete_account_requests(role);
      CREATE INDEX IF NOT EXISTS idx_delete_requests_status ON delete_account_requests(status);
      ALTER TABLE delete_account_requests ALTER COLUMN email DROP NOT NULL;
      ALTER TABLE delete_account_requests ALTER COLUMN phone DROP NOT NULL;
    `;
    await pool.query(createDeleteRequestsSql);

    const createTrustedDevicesSql = `
      CREATE TABLE IF NOT EXISTS trusted_devices (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        mobile_number VARCHAR(15) NOT NULL,
        device_id VARCHAR(255),
        device_hash VARCHAR(255),
        platform VARCHAR(50),
        device_name VARCHAR(255),
        manufacturer VARCHAR(100),
        model VARCHAR(100),
        os_version VARCHAR(50),
        app_version VARCHAR(50),
        firebase_installation_id VARCHAR(255),
        first_login_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_trusted BOOLEAN DEFAULT TRUE,
        trust_status VARCHAR(20) DEFAULT 'trusted',
        revoked_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_trusted_devices_mobile ON trusted_devices(mobile_number, is_trusted);
      CREATE INDEX IF NOT EXISTS idx_trusted_devices_device_id ON trusted_devices(device_id);
    `;
    await pool.query(createTrustedDevicesSql);

    // Add commonly used social auth columns if they don't exist yet
    const alterSql = `
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(20) DEFAULT 'phone';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS facebook_id VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type VARCHAR(20) DEFAULT 'user';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS languages TEXT[];
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_first_time_user BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS offer_used BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS random_calls_today INTEGER DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_random_call_date DATE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS offer_minutes_limit INTEGER;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS offer_flat_price DECIMAL(10, 2);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_balance DECIMAL(10, 2) DEFAULT 0.0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS unlimited_expires_at TIMESTAMP;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS active_session_id VARCHAR(255);
      
      -- Add listener table columns if they don't exist
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS original_name VARCHAR(100);
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS experiences TEXT[];
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS voice_verified BOOLEAN DEFAULT FALSE;
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS voice_verification_url TEXT;
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP;
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS user_rate_per_min DECIMAL(10, 2);
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS listener_payout_per_min DECIMAL(10, 2);
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS total_earning DECIMAL(10, 2) DEFAULT 0.0;
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS wallet_balance DECIMAL(10, 2) DEFAULT 0.0;
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS reapply_attempts INTEGER DEFAULT 0;
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS listener_type VARCHAR(20) DEFAULT 'full';
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS quality_status VARCHAR(20) DEFAULT 'probation';
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS probation_calls_remaining INTEGER DEFAULT 10;
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS warning_reason TEXT;
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS suspended_until TIMESTAMP;
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS strike_count INTEGER DEFAULT 0;
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS avg_call_duration_seconds INTEGER DEFAULT 0;
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS hangup_rate DECIMAL(5, 2) DEFAULT 0.0;
      ALTER TABLE listeners ADD COLUMN IF NOT EXISTS short_calls_streak INTEGER DEFAULT 0;
      
      CREATE INDEX IF NOT EXISTS idx_listeners_quality_status ON listeners(quality_status);
      
      ALTER TABLE calls ADD COLUMN IF NOT EXISTS billed_minutes INTEGER;
      ALTER TABLE calls ADD COLUMN IF NOT EXISTS offer_applied BOOLEAN DEFAULT FALSE;
      ALTER TABLE calls ADD COLUMN IF NOT EXISTS offer_flat_price DECIMAL(10, 2);
      ALTER TABLE calls ADD COLUMN IF NOT EXISTS offer_minutes_limit INTEGER;
`;
    await pool.query(alterSql);
    console.log('✓ Ensured users and listeners table schema');

    const createRateConfigSql = `
      CREATE TABLE IF NOT EXISTS rate_config (
        config_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        normal_per_minute_rate DECIMAL(10, 2) NOT NULL,
        first_time_offer_enabled BOOLEAN DEFAULT FALSE,
        offer_minutes_limit INTEGER,
        offer_flat_price DECIMAL(10, 2),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await pool.query(createRateConfigSql);

    const createRateConfigAuditSql = `
      CREATE TABLE IF NOT EXISTS rate_config_audit (
        audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_id UUID REFERENCES admins(admin_id) ON DELETE SET NULL,
        previous_config JSONB,
        new_config JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_rate_config_audit_created_at ON rate_config_audit(created_at DESC);
    `;
    await pool.query(createRateConfigAuditSql);

    await pool.query(`
      INSERT INTO rate_config (normal_per_minute_rate, first_time_offer_enabled, offer_minutes_limit, offer_flat_price)
      SELECT 4.00, FALSE, 5, 5.00
      WHERE NOT EXISTS (SELECT 1 FROM rate_config)
    `);
    console.log('✓ Ensured rate_config table and default row');

    // Offer Banner Config table
    await pool.query(`
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
    `);
    await pool.query(`
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
        'on recharge of \u20B9100',
        'Recharge for \u20B975',
        'Offer ends in',
        100.00,
        75.00,
        5.00,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + INTERVAL '7 days',
        FALSE
      WHERE NOT EXISTS (SELECT 1 FROM offer_banner_config)
    `);
    console.log('✓ Ensured offer_banner_config table and default row');

    // Chat Charge Config table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_charge_config (
        config_id SERIAL PRIMARY KEY,
        charging_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        free_message_limit INTEGER NOT NULL DEFAULT 5,
        message_block_size INTEGER NOT NULL DEFAULT 2,
        charge_per_message_block NUMERIC(10, 2) NOT NULL DEFAULT 1.00,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`
      INSERT INTO chat_charge_config (charging_enabled, free_message_limit, message_block_size, charge_per_message_block)
      SELECT FALSE, 5, 2, 1.00
      WHERE NOT EXISTS (SELECT 1 FROM chat_charge_config)
    `);
    console.log('✓ Ensured chat_charge_config table and default row');

    // Add global chat message counters to users table (for chat charging)
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS total_messages_sent INTEGER NOT NULL DEFAULT 0;
    `);
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS free_messages_used INTEGER NOT NULL DEFAULT 0;
    `);
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_charge_applied_at TIMESTAMP;
    `);
    console.log('✓ Ensured users table has chat charging columns');

    // Add WhatsApp-style message status column (sent/delivered/seen) for tick UI
    await pool.query(`
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'sent';
    `);
    // Backfill existing is_read=TRUE messages to status='seen'
    await pool.query(`
      UPDATE messages SET status = 'seen' WHERE is_read = TRUE AND (status IS NULL OR status = 'sent');
    `);
    console.log('✓ Ensured messages table has status column (sent/delivered/seen)');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS call_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_call_records_call_id
        ON call_records(call_id) WHERE call_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_call_records_user ON call_records(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_call_records_listener ON call_records(listener_id, created_at DESC);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS call_billing_audit (
        audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
      CREATE INDEX IF NOT EXISTS idx_call_billing_audit_created_at ON call_billing_audit(created_at DESC);
    `);

    await pool.query(`
      UPDATE listeners
      SET user_rate_per_min = COALESCE(user_rate_per_min, rate_per_minute),
          listener_payout_per_min = COALESCE(listener_payout_per_min, rate_per_minute)
      WHERE user_rate_per_min IS NULL OR listener_payout_per_min IS NULL
    `);

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'listeners_payout_rate_check'
        ) THEN
          ALTER TABLE listeners
          ADD CONSTRAINT listeners_payout_rate_check
          CHECK (listener_payout_per_min <= user_rate_per_min);
        END IF;
      END$$;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS listener_global_rate_config (
        config_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        singleton_key BOOLEAN NOT NULL DEFAULT TRUE UNIQUE,
        user_rate NUMERIC(10, 2) NOT NULL,
        payout_rate NUMERIC(10, 2) NOT NULL,
        updated_by UUID REFERENCES admins(admin_id) ON DELETE SET NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CHECK (singleton_key = TRUE),
        CHECK (user_rate > 0),
        CHECK (payout_rate > 0)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS listener_rate_rules (
        rule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        min_rating NUMERIC(2, 1) NOT NULL,
        max_rating NUMERIC(2, 1) NOT NULL,
        min_duration NUMERIC(10, 1) NOT NULL,
        max_duration NUMERIC(10, 1) NOT NULL,
        user_rate NUMERIC(10, 2) NOT NULL,
        payout_rate NUMERIC(10, 2) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        updated_by UUID REFERENCES admins(admin_id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CHECK (min_rating >= 0 AND max_rating <= 5 AND min_rating <= max_rating),
        CHECK (min_duration >= 0 AND max_duration >= 0 AND min_duration <= max_duration),
        CHECK (user_rate > 0),
        CHECK (payout_rate > 0)
      );
      CREATE INDEX IF NOT EXISTS idx_listener_rate_rules_match
        ON listener_rate_rules(is_active, min_rating DESC, min_duration DESC);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS listener_rate_dropdown_settings (
        config_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        singleton_key BOOLEAN NOT NULL DEFAULT TRUE UNIQUE,
        settings JSONB NOT NULL,
        updated_by UUID REFERENCES admins(admin_id) ON DELETE SET NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CHECK (singleton_key = TRUE)
      );
    `);

    await pool.query(`
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
      CREATE INDEX IF NOT EXISTS idx_listener_payout_slabs_start ON listener_payout_slabs(start_duration);
    `);
    
    // If phone_number is marked NOT NULL in the existing DB, allow nulls for social accounts
    const dropNotNullSql = `
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'users' AND column_name = 'phone_number' AND is_nullable = 'NO'
        ) THEN
          EXECUTE 'ALTER TABLE users ALTER COLUMN phone_number DROP NOT NULL';
        END IF;
      END$$;
    `;
    await pool.query(dropNotNullSql);
    console.log('✓ Ensured phone_number is nullable if previously NOT NULL');
  } catch (error) {
    console.error('Error ensuring schema:', error.message);
    throw error;
  }
}

// Generic query execution function
async function executeQuery(query, params = []) {
  try {
    const result = await pool.query(query, params);
    return result.rows;
  } catch (error) {
    console.error('Query error:', error.message);
    throw error;
  }
}

// Close the connection pool
async function closePool() {
  await pool.end();
  console.log('Database connection pool closed');
}

export { pool, testConnection, executeQuery, closePool };
export { ensureSchema };



















// // aws //



// import pkg from 'pg';
// const { Pool } = pkg;
// import dotenv from 'dotenv';
// dotenv.config();

// // Configure the PostgreSQL connection pool
// // Optimized for serverless environments
// const pool = new Pool({
//   host: process.env.DB_HOST,
//   port: process.env.DB_PORT || 5432,
//   user: process.env.DB_USER,
//   password: process.env.DB_PASSWORD,
//   database: process.env.DB_NAME,
//   ssl: {
//     rejectUnauthorized: false // Required for AWS RDS
//   },
//   max: 5, // Reduced for serverless - each function instance gets its own pool
//   idleTimeoutMillis: 10000, // Close idle connections faster in serverless
//   connectionTimeoutMillis: 10000,
//   timezone: 'Asia/Kolkata' // Set timezone to IST for proper timestamp handling
// });

// // Test the database connection
// async function testConnection(retries = 3) {
//   for (let attempt = 1; attempt <= retries; attempt++) {
//     try {
//       const client = await pool.connect();
//       console.log('✓ Successfully connected to AWS RDS PostgreSQL database');
      
//       // Test query
//       const result = await client.query('SELECT NOW()');
//       console.log('Current database time:', result.rows[0].now);
      
//       client.release();
//       return true;
//     } catch (error) {
//       console.error(`✗ Error connecting to the database (attempt ${attempt}/${retries}):`, error.message);
//       if (attempt === retries) {
//         return false;
//       }
//       // Wait 2 seconds before retrying
//       await new Promise(resolve => setTimeout(resolve, 2000));
//     }
//   }
// }

// // Ensure required columns exist on startup (non-destructive)
// async function ensureSchema() {
//   try {
//     // Create admins table if it doesn't exist
//     const createAdminsSql = `
//       CREATE TABLE IF NOT EXISTS admins (
//         admin_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
//         email VARCHAR(255) UNIQUE NOT NULL,
//         password_hash VARCHAR(255) NOT NULL,
//         full_name VARCHAR(100),
//         is_active BOOLEAN DEFAULT TRUE,
//         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
//         updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
//         last_login TIMESTAMP
//       );
//     `;
//     await pool.query(createAdminsSql);
//     console.log('✓ Ensured admins table exists');

//     // Add commonly used social auth columns if they don't exist yet
//     const alterSql = `
//       ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider VARCHAR(20) DEFAULT 'phone';
//       ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255);
//       ALTER TABLE users ADD COLUMN IF NOT EXISTS facebook_id VARCHAR(255);
//       ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type VARCHAR(20) DEFAULT 'user';
//       ALTER TABLE users ADD COLUMN IF NOT EXISTS languages TEXT[];
//       ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMP;
      
//       -- Add listener table columns if they don't exist
//       ALTER TABLE listeners ADD COLUMN IF NOT EXISTS original_name VARCHAR(100);
//       ALTER TABLE listeners ADD COLUMN IF NOT EXISTS experiences TEXT[];
//       ALTER TABLE listeners ADD COLUMN IF NOT EXISTS voice_verified BOOLEAN DEFAULT FALSE;
//       ALTER TABLE listeners ADD COLUMN IF NOT EXISTS voice_verification_url TEXT;
//       ALTER TABLE listeners ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP;
//     `;
//     await pool.query(alterSql);
//     console.log('✓ Ensured users and listeners table schema');
    
//     // If phone_number is marked NOT NULL in the existing DB, allow nulls for social accounts
//     const dropNotNullSql = `
//       DO $$
//       BEGIN
//         IF EXISTS (
//           SELECT 1 FROM information_schema.columns
//           WHERE table_name = 'users' AND column_name = 'phone_number' AND is_nullable = 'NO'
//         ) THEN
//           EXECUTE 'ALTER TABLE users ALTER COLUMN phone_number DROP NOT NULL';
//         END IF;
//       END$$;
//     `;
//     await pool.query(dropNotNullSql);
//     console.log('✓ Ensured phone_number is nullable if previously NOT NULL');
//   } catch (error) {
//     console.error('Error ensuring schema:', error.message);
//     throw error;
//   }
// }

// // Generic query execution function
// async function executeQuery(query, params = []) {
//   try {
//     const result = await pool.query(query, params);
//     return result.rows;
//   } catch (error) {
//     console.error('Query error:', error.message);
//     throw error;
//   }
// }

// // Close the connection pool
// async function closePool() {
//   await pool.end();
//   console.log('Database connection pool closed');
// }

// export { pool, testConnection, executeQuery, closePool };
// export { ensureSchema };
