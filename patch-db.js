import { pool } from './db.js';

async function patch() {
  try {
    console.log('Running patch...');
    
    // Create type outbox_status and target_role_type? Wait, I didn't use ENUM in the final database.sql replace. I used VARCHAR(20) to avoid enum issues.
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notification_outbox (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          title VARCHAR(255) NOT NULL,
          body TEXT NOT NULL,
          target_role VARCHAR(20) NOT NULL,
          target_user_ids UUID[],
          schedule_at TIMESTAMP,
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
    `);
    
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_outbox_status_schedule ON notification_outbox(status, schedule_at);
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS notification_deliveries (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          outbox_id UUID REFERENCES notification_outbox(id) ON DELETE CASCADE,
          user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
          status VARCHAR(20) DEFAULT 'PENDING',
          delivered_at TIMESTAMP,
          error_message TEXT,
          last_error TEXT,
          retry_count INT DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
          notification_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
          title VARCHAR(255) NOT NULL,
          message TEXT NOT NULL,
          notification_type VARCHAR(50),
          is_read BOOLEAN DEFAULT FALSE,
          data JSONB,
          source_outbox_id UUID REFERENCES notification_outbox(id) ON DELETE SET NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      ALTER TABLE notification_outbox
        ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP,
        ADD COLUMN IF NOT EXISTS delivered_count INT DEFAULT 0;
    `);

    await pool.query(`
      ALTER TABLE notification_deliveries
        ADD COLUMN IF NOT EXISTS last_error TEXT,
        ADD COLUMN IF NOT EXISTS retry_count INT DEFAULT 0;
    `);

    await pool.query(`
      ALTER TABLE notifications
        ADD COLUMN IF NOT EXISTS source_outbox_id UUID REFERENCES notification_outbox(id) ON DELETE SET NULL;
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_deliveries_outbox ON notification_deliveries(outbox_id);
    `);
    
    console.log('Patch complete!');
  } catch (e) {
    console.error('Patch failed:', e);
  } finally {
    await pool.end();
  }
}

patch();
