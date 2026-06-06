import bcrypt from 'bcryptjs';
import { pool } from './db.js';

const adminSeedEmail = String(process.env.ADMIN_SEED_EMAIL || 'admin@example.com').trim().toLowerCase();
const adminSeedPassword = String(process.env.ADMIN_SEED_PASSWORD || 'ChangeMe123!');
const adminSeedFullName = String(process.env.ADMIN_SEED_FULL_NAME || 'Admin User').trim();

async function run() {
  try {
    console.log('Inserting default admin...');
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(adminSeedPassword, saltRounds);

    const insertAdminQuery = `
      INSERT INTO admins (email, password_hash, full_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          full_name = EXCLUDED.full_name,
          is_active = TRUE
    `;

    await pool.query(insertAdminQuery, [adminSeedEmail, hashedPassword, adminSeedFullName]);
    console.log('Admin inserted.');
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

run();
