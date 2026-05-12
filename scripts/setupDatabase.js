import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db.js';
import bcrypt from 'bcryptjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function setupDatabase() {
  try {
    console.log('🔄 Setting up database...');

    // Read the SQL file
    const sqlFilePath = path.join(__dirname, '..', 'database.sql');
    const sqlContent = fs.readFileSync(sqlFilePath, 'utf8');

    console.log('📄 Executing SQL schema...');

    // Execute the entire SQL content at once
    await pool.query(sqlContent);

    // Add last_active_at column if it doesn't exist
    console.log('🔧 Adding last_active_at column...');
    try {
      await pool.query(`
        ALTER TABLE listeners 
        ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP
      `);
      console.log('✅ last_active_at column added or already exists');
    } catch (error) {
      console.log('⚠️  Could not add last_active_at column:', error.message);
    }

    console.log('📝 Inserting default admin...');

    // Hash the password
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash('admin123', saltRounds);

    // Insert default admin
    const insertAdminQuery = `
      INSERT INTO admins (email, password_hash, full_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) DO NOTHING
    `;
    await pool.query(insertAdminQuery, ['rohitraj70615@gmail.com', hashedPassword, 'Admin User']);

    console.log('🎉 Database setup completed successfully!');
  } catch (error) {
    console.error('💥 Error setting up database:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  } finally {
    // Close the pool
    await pool.end();
  }
}

// Run the setup
setupDatabase();