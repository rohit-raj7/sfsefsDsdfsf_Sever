import { pool } from '../db.js';

class TrustedDevice {
  /**
   * Find a trusted device by user ID and device ID
   */
  static async findByUserAndDeviceId(user_id, device_id) {
    const query = 'SELECT * FROM trusted_devices WHERE user_id = $1 AND device_id = $2';
    const result = await pool.query(query, [user_id, device_id]);
    return result.rows[0];
  }

  /**
   * Add a new trusted device or update if it exists
   */
  static async addOrUpdate(data) {
    const { user_id, device_id, platform, device_name, app_version } = data;
    const query = `
      INSERT INTO trusted_devices (user_id, device_id, platform, device_name, app_version, is_trusted, first_login_at, last_login_at)
      VALUES ($1, $2, $3, $4, $5, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (user_id, device_id)
      DO UPDATE SET
        platform = EXCLUDED.platform,
        device_name = EXCLUDED.device_name,
        app_version = EXCLUDED.app_version,
        is_trusted = TRUE,
        last_login_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;
    const result = await pool.query(query, [user_id, device_id, platform, device_name, app_version]);
    return result.rows[0];
  }

  /**
   * Update the last login time for a specific trusted device
   */
  static async updateLastLogin(id) {
    const query = 'UPDATE trusted_devices SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *';
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }

  /**
   * Mark a device as untrusted
   */
  static async revokeTrust(user_id, device_id) {
    const query = 'UPDATE trusted_devices SET is_trusted = FALSE WHERE user_id = $1 AND device_id = $2 RETURNING *';
    const result = await pool.query(query, [user_id, device_id]);
    return result.rows[0];
  }

  /**
   * Delete all devices for a user
   */
  static async deleteAllForUser(user_id) {
    const query = 'DELETE FROM trusted_devices WHERE user_id = $1';
    await pool.query(query, [user_id]);
  }
}

export default TrustedDevice;
