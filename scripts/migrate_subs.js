import { pool } from '../db.js';

async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    console.log('Adding subscription columns to recharge_packs...');
    await client.query(`
      ALTER TABLE recharge_packs 
      ADD COLUMN IF NOT EXISTS is_unlimited BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS unlimited_days INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS is_first_time_only BOOLEAN DEFAULT FALSE;
    `);

    console.log('Adding unlimited_expires_at to users...');
    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS unlimited_expires_at TIMESTAMP DEFAULT NULL;
    `);

    // Insert the special 5rs for 5mins pack
    console.log('Upserting first-time ₹5 pack...');
    await client.query(`
      INSERT INTO recharge_packs (amount, extra_percent_or_amount, badge_text, sort_order, is_unlimited, unlimited_days, is_first_time_only)
      SELECT 5.00, 0.00, 'First Recharge Only! 5 Mins', -1, FALSE, 0, TRUE
      WHERE NOT EXISTS (
        SELECT 1 FROM recharge_packs WHERE is_first_time_only = TRUE AND amount = 5.00
      );
    `);

    await client.query('COMMIT');
    console.log('Migration successful!');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', error);
  } finally {
    client.release();
    process.exit();
  }
}

up();
