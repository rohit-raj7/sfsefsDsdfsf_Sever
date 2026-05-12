import { pool } from '../db.js';

async function run() {
  try {
    await pool.query(`ALTER TABLE listeners ADD COLUMN IF NOT EXISTS is_busy BOOLEAN DEFAULT FALSE`);
    console.log('✓ Added is_busy column');
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_listeners_is_busy ON listeners(is_busy) WHERE is_busy = TRUE`);
    console.log('✓ Created index on is_busy');
    console.log('Migration complete!');
  } catch (err) {
    console.error('Migration failed:', err.message);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

run();
