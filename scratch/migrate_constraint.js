import { pool } from '../db.js';

async function migrate() {
  try {
    console.log('Updating notification_outbox status constraint...');
    await pool.query(`ALTER TABLE notification_outbox DROP CONSTRAINT IF EXISTS notification_outbox_status_check`);
    await pool.query(`ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_status_check CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED'))`);
    console.log('✅ Constraint updated successfully.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
}

migrate();
