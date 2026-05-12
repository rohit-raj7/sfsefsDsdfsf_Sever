/**
 * Migration Script: Add verification_status column to listeners table
 * 
 * This script adds the verification_status field to the listeners table
 * and sets existing listeners to 'approved' for backward compatibility.
 * 
 * Run this script once after deployment:
 * node scripts/addVerificationStatus.js
 */

import { pool } from '../db.js';

async function addVerificationStatus() {
  const client = await pool.connect();
  
  try {
    console.log('Starting verification_status migration...');

    // Start transaction
    await client.query('BEGIN');

    // Check if column already exists
    const checkQuery = `
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'listeners' 
        AND column_name = 'verification_status';
    `;
    const checkResult = await client.query(checkQuery);

    if (checkResult.rows.length > 0) {
      console.log('✓ verification_status column already exists');
    } else {
      // Add the verification_status column
      console.log('Adding verification_status column...');
      await client.query(`
        ALTER TABLE listeners 
        ADD COLUMN verification_status VARCHAR(20) DEFAULT 'pending' 
        CHECK (verification_status IN ('pending', 'approved', 'rejected'))
      `);
      console.log('✓ verification_status column added successfully');
    }

    // Set all existing listeners to 'approved' for backward compatibility
    // This ensures existing listeners remain visible to users
    console.log('Setting existing listeners to approved...');
    const updateResult = await client.query(`
      UPDATE listeners 
      SET verification_status = 'approved'
      WHERE verification_status IS NULL 
         OR verification_status = 'pending'
    `);
    console.log(`✓ Updated ${updateResult.rowCount} listener(s) to approved status`);

    // Also sync is_verified field
    await client.query(`
      UPDATE listeners 
      SET is_verified = TRUE
      WHERE verification_status = 'approved'
    `);
    console.log('✓ Synced is_verified field with verification_status');

    // Commit transaction
    await client.query('COMMIT');
    
    console.log('✅ Migration completed successfully!');
    console.log('\nSummary:');
    console.log('- verification_status column added/verified');
    console.log(`- ${updateResult.rowCount} existing listener(s) set to approved`);
    console.log('- All existing listeners remain visible to users');
    
  } catch (error) {
    // Rollback on error
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', error.message);
    console.error('Error details:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run migration
addVerificationStatus()
  .then(() => {
    console.log('\n✅ Migration script completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Migration script failed:', error);
    process.exit(1);
  });
