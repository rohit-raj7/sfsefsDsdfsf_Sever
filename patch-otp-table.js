import { pool } from './db.js';

async function createTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS otp_tracking (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(20) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('otp_tracking table created successfully.');
  } catch (error) {
    console.error('Error creating table:', error);
  } finally {
    process.exit();
  }
}

createTable();