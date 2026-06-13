import { pool } from '../db.js';

class NotificationOutbox {
  static async create(data) {
    const {
      title,
      body,
      target_role,
      target_user_ids,
      schedule_at,
      repeat_interval,
      repeat_days,
      random_enabled,
      random_start_time,
      random_end_time,
      created_by,
      language_filter
    } = data;
    const q = `
      INSERT INTO notification_outbox
      (title, body, target_role, target_user_ids, schedule_at, repeat_interval, repeat_days, random_enabled, random_start_time, random_end_time, created_by, language_filter)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `;
    const res = await pool.query(q, [
      title,
      body,
      target_role,
      target_user_ids || null,
      schedule_at || null,
      repeat_interval || null,
      repeat_days || null,
      random_enabled || false,
      random_start_time || null,
      random_end_time || null,
      created_by,
      language_filter || null
    ]);
    return res.rows[0];
  }
}

export default NotificationOutbox;
