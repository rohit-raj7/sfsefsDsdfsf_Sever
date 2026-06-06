import { pool } from '../db.js';
import bcrypt from 'bcryptjs';

class Admin {
  static normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
  }

  // Create new admin
  static async create(adminData) {
    const {
      email,
      password_hash,
      full_name
    } = adminData;

    const query = `
      INSERT INTO admins (email, password_hash, full_name)
      VALUES ($1, $2, $3)
      RETURNING admin_id, email, full_name, created_at
    `;

    const values = [this.normalizeEmail(email), password_hash, full_name];

    const result = await pool.query(query, values);
    return result.rows[0];
  }

  // Find admin by email
  static async findByEmail(email) {
    const query = 'SELECT * FROM admins WHERE LOWER(email) = LOWER($1) LIMIT 1';
    const result = await pool.query(query, [this.normalizeEmail(email)]);
    return result.rows[0];
  }

  static async ensureSeedAdmin(email = '') {
    const seedEmail = this.normalizeEmail(process.env.ADMIN_SEED_EMAIL);
    const seedPassword = String(process.env.ADMIN_SEED_PASSWORD || '');
    const seedFullName = String(process.env.ADMIN_SEED_FULL_NAME || 'Admin User').trim();
    const normalizedEmail = this.normalizeEmail(email);

    if (!seedEmail || !seedPassword) {
      return null;
    }

    if (normalizedEmail && normalizedEmail !== seedEmail) {
      return null;
    }

    const passwordHash = await this.hashPassword(seedPassword);
    const query = `
      INSERT INTO admins (email, password_hash, full_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          full_name = EXCLUDED.full_name,
          is_active = TRUE
      RETURNING *
    `;
    const result = await pool.query(query, [seedEmail, passwordHash, seedFullName]);
    return result.rows[0] || null;
  }

  // Update last login
  static async updateLastLogin(admin_id) {
    const query = 'UPDATE admins SET last_login = CURRENT_TIMESTAMP WHERE admin_id = $1';
    await pool.query(query, [admin_id]);
  }

  // Hash password
  static async hashPassword(password) {
    const saltRounds = 10;
    return await bcrypt.hash(password, saltRounds);
  }

  // Compare password
  static async comparePassword(password, hash) {
    return await bcrypt.compare(password, hash);
  }
}

export default Admin;
