/**
 * Migration Script: Add rejection_reason and reapply_attempts columns to listeners table
 * 
 * Run: node scripts/addRejectionReapply.js
 */

import { pool } from '../db.js';

async function runMigration() {
  const client = await pool.connect();
  try {
    console.log('Starting rejection_reason & reapply_attempts migration...');

    // 1. Add rejection_reason column
    const checkReason = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'listeners' 
      AND column_name = 'rejection_reason';
    `);

    if (checkReason.rows.length > 0) {
      console.log('✓ rejection_reason column already exists');
    } else {
      console.log('Adding rejection_reason column...');
      await client.query(`
        ALTER TABLE listeners 
        ADD COLUMN rejection_reason VARCHAR(255) DEFAULT NULL
      `);
      console.log('✓ rejection_reason column added successfully');
    }

    // 2. Add reapply_attempts column
    const checkAttempts = await client.query(`
      SELECT column_name FROM information_schema.columns 
      WHERE table_name = 'listeners' 
      AND column_name = 'reapply_attempts';
    `);

    if (checkAttempts.rows.length > 0) {
      console.log('✓ reapply_attempts column already exists');
    } else {
      console.log('Adding reapply_attempts column...');
      await client.query(`
        ALTER TABLE listeners 
        ADD COLUMN reapply_attempts INTEGER DEFAULT 0
      `);
      console.log('✓ reapply_attempts column added successfully');
    }

    console.log('\n✅ Migration completed successfully!');
    console.log('- rejection_reason column added/verified');
    console.log('- reapply_attempts column added/verified');

    // 3. Update CHECK constraint to include 'reapplied'
    console.log('Updating verification_status CHECK constraint...');
    await client.query(`
      ALTER TABLE listeners DROP CONSTRAINT IF EXISTS listeners_verification_status_check
    `);
    await client.query(`
      ALTER TABLE listeners ADD CONSTRAINT listeners_verification_status_check 
      CHECK (verification_status IN ('pending', 'approved', 'rejected', 'reapplied'))
    `);
    console.log('✓ CHECK constraint updated to include reapplied status');

    console.log('\n✅ All migrations completed successfully!');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

runMigration().catch(console.error);
