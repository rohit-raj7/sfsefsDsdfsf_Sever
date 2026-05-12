import { pool } from '../db.js';

class Rating {
  // Create a rating for a call
  static async create(ratingData) {
    const {
      call_id,
      listener_id,
      user_id,
      rating,
      review_text = null
    } = ratingData;

    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Insert rating
      const insertQuery = `
        INSERT INTO ratings (call_id, listener_id, user_id, rating, review_text)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `;
      const result = await client.query(insertQuery, [
        call_id, listener_id, user_id, rating, review_text
      ]);

      // Mark call as rated
      await client.query('UPDATE calls SET is_rated = TRUE WHERE call_id = $1', [call_id]);

      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // Get ratings for a listener
  static async getListenerRatings(listener_id, limit = 20, offset = 0) {
    const query = `
      SELECT r.*, u.display_name as user_name, u.avatar_url as user_avatar
      FROM ratings r
      LEFT JOIN users u ON r.user_id = u.user_id
      WHERE r.listener_id = $1
      ORDER BY r.created_at DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await pool.query(query, [listener_id, limit, offset]);
    return result.rows;
  }

  // Check if call is already rated
  static async isCallRated(call_id) {
    const query = 'SELECT rating_id FROM ratings WHERE call_id = $1';
    const result = await pool.query(query, [call_id]);
    return result.rows.length > 0;
  }

  // Get average rating for listener
  static async getListenerAverageRating(listener_id) {
    const query = `
      SELECT 
        COALESCE(AVG(rating), 0) as average_rating,
        COUNT(*) as total_ratings
      FROM ratings
      WHERE listener_id = $1
    `;
    const result = await pool.query(query, [listener_id]);
    return result.rows[0];
  }
}

export default Rating;
