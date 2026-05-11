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
      created_by
    } = data;
    const q = `
      INSERT INTO notification_outbox
      (title, body, target_role, target_user_ids, schedule_at, repeat_interval, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;
    const res = await pool.query(q, [
      title,
      body,
      target_role,
      target_user_ids || null,
      schedule_at || null,
      repeat_interval || null,
      created_by
    ]);
    return res.rows[0];
  }
}

export default NotificationOutbox;
