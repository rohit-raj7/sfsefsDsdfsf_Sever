import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: {
    rejectUnauthorized: false
  }
});

async function addMobileNumberColumns() {
  const client = await pool.connect();
  
  try {
    console.log('🔗 Starting migration to add mobile_number columns...\n');

    // Add mobile_number to users table
    console.log('📝 Adding mobile_number column to users table...');
    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS mobile_number VARCHAR(15);
    `);
    console.log('✓ Added mobile_number to users table\n');

    // Add mobile_number to listeners table
    console.log('📝 Adding mobile_number column to listeners table...');
    await client.query(`
      ALTER TABLE listeners 
      ADD COLUMN IF NOT EXISTS mobile_number VARCHAR(15);
    `);
    console.log('✓ Added mobile_number to listeners table\n');

    // Add mobile_number to listener_payment_details table
    console.log('📝 Adding mobile_number column to listener_payment_details table...');
    await client.query(`
      ALTER TABLE listener_payment_details 
      ADD COLUMN IF NOT EXISTS mobile_number VARCHAR(15);
    `);
    console.log('✓ Added mobile_number to listener_payment_details table\n');

    console.log('✅ Migration completed successfully!');
    console.log('All tables now have mobile_number column support.\n');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run migration
addMobileNumberColumns()
  .then(() => {
    console.log('✓ Migration script finished');
    process.exit(0);
  })
  .catch((error) => {
    console.error('✗ Migration script failed:', error);
    process.exit(1);
  });
