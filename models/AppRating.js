import { pool } from '../db.js';

class AppRating {
  static async findByUserId(user_id) {
    const query = `
      SELECT *
      FROM app_ratings
      WHERE user_id = $1
      LIMIT 1
    `;
    const result = await pool.query(query, [user_id]);
    return result.rows[0] || null;
  }

  static async create({ user_id, rating, feedback = null, source = 'mobile' }) {
    const query = `
      INSERT INTO app_ratings (user_id, rating, feedback, source, updated_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      RETURNING *
    `;
    const result = await pool.query(query, [user_id, rating, feedback, source]);
    return result.rows[0];
  }

  static async updateByUserId({
    user_id,
    rating,
    feedback = null,
    source = 'mobile',
  }) {
    const query = `
      UPDATE app_ratings
      SET rating = $2,
          feedback = $3,
          source = $4,
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $1
      RETURNING *
    `;
    const result = await pool.query(query, [user_id, rating, feedback, source]);
    return result.rows[0] || null;
  }

  static async submitOrUpdateForUser({
    user_id,
    rating,
    feedback = null,
    source = 'mobile',
  }) {
    const existing = await this.findByUserId(user_id);
    if (existing) {
      const updated = await this.updateByUserId({
        user_id,
        rating,
        feedback,
        source,
      });
      return { action: 'updated', rating: updated };
    }

    try {
      const created = await this.create({ user_id, rating, feedback, source });
      return { action: 'created', rating: created };
    } catch (error) {
      // If concurrent create happened, fall back to update.
      if (error?.code === '23505') {
        const updated = await this.updateByUserId({
          user_id,
          rating,
          feedback,
          source,
        });
        return { action: 'updated', rating: updated };
      }
      throw error;
    }
  }

  static async getAllForAdmin({
    limit = 20,
    offset = 0,
    search = '',
    minRating,
    maxRating,
  } = {}) {
    const conds = [];
    const params = [];
    let idx = 1;

    if (search && String(search).trim().length > 0) {
      conds.push(
        `(u.display_name ILIKE $${idx} OR u.email ILIKE $${idx} OR ar.feedback ILIKE $${idx})`,
      );
      params.push(`%${String(search).trim()}%`);
      idx += 1;
    }

    if (Number.isFinite(minRating)) {
      conds.push(`ar.rating >= $${idx}`);
      params.push(Number(minRating));
      idx += 1;
    }

    if (Number.isFinite(maxRating)) {
      conds.push(`ar.rating <= $${idx}`);
      params.push(Number(maxRating));
      idx += 1;
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const pageLimit = Math.min(Math.max(Number(limit) || 20, 1), 200);
    const pageOffset = Math.max(Number(offset) || 0, 0);

    const listQuery = `
      SELECT
        ar.app_rating_id,
        ar.user_id,
        ar.rating,
        ar.feedback,
        ar.source,
        ar.created_at,
        ar.updated_at,
        u.display_name,
        u.email,
        u.mobile_number
      FROM app_ratings ar
      LEFT JOIN users u ON ar.user_id = u.user_id
      ${where}
      ORDER BY ar.updated_at DESC, ar.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;
    const listParams = [...params, pageLimit, pageOffset];

    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM app_ratings ar
      LEFT JOIN users u ON ar.user_id = u.user_id
      ${where}
    `;

    const summaryQuery = `
      SELECT
        COUNT(*)::int AS count,
        COALESCE(AVG(ar.rating), 0)::numeric(3,2) AS average_rating
      FROM app_ratings ar
      LEFT JOIN users u ON ar.user_id = u.user_id
      ${where}
    `;

    const [listResult, countResult, summaryResult] = await Promise.all([
      pool.query(listQuery, listParams),
      pool.query(countQuery, params),
      pool.query(summaryQuery, params),
    ]);

    return {
      ratings: listResult.rows,
      count: countResult.rows[0]?.count || 0,
      average_rating: Number(summaryResult.rows[0]?.average_rating || 0),
    };
  }

  static async deleteByIds(ids = []) {
    const normalizedIds = Array.from(
      new Set(
        (Array.isArray(ids) ? ids : [])
          .map((value) => String(value || '').trim())
          .filter((value) => value.length > 0),
      ),
    );

    if (normalizedIds.length === 0) {
      return { deleted_count: 0, deleted_ids: [] };
    }

    const query = `
      DELETE FROM app_ratings
      WHERE app_rating_id::text = ANY($1::text[])
      RETURNING app_rating_id::text AS app_rating_id
    `;

    const result = await pool.query(query, [normalizedIds]);
    return {
      deleted_count: result.rowCount || 0,
      deleted_ids: result.rows.map((row) => row.app_rating_id),
    };
  }
}

export default AppRating;
