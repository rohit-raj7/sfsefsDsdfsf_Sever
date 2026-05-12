import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigration() {
  try {
    console.log('🔄 Running recharge_packs migration...');
    console.log('Connection URL:', process.env.DATABASE_PUBLIC_URL ? 'Using DATABASE_PUBLIC_URL' : 'Using DB_HOST');

    const migrationPath = path.join(__dirname, '..', 'migrations', '20260210_recharge_packs.sql');
    const sqlContent = fs.readFileSync(migrationPath, 'utf8');

    await pool.query(sqlContent);

    console.log('🎉 Migration completed successfully!');
  } catch (error) {
    console.error('💥 Error running migration:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
