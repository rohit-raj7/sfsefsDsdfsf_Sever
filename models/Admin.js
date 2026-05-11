import { pool } from '../db.js';
import bcrypt from 'bcryptjs';

class Admin {
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

    const values = [email, password_hash, full_name];

    const result = await pool.query(query, values);
    return result.rows[0];
  }

  // Find admin by email
  static async findByEmail(email) {
    const query = 'SELECT * FROM admins WHERE email = $1';
    const result = await pool.query(query, [email]);
    return result.rows[0];
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