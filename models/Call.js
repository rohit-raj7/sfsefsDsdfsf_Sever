import { pool } from '../db.js';

class Call {
  // Create new call
  static async create(callData) {
    const {
      caller_id,
      listener_id,
      call_type = 'audio',
      rate_per_minute,
      billed_user_rate_per_min = null,
      billed_payout_rate_per_min = null,
      offer_applied = false,
      offer_flat_price = null,
      offer_minutes_limit = null,
    } = callData;

    const query = `
      INSERT INTO calls (
        caller_id, listener_id, call_type, rate_per_minute,
        billed_user_rate_per_min, billed_payout_rate_per_min,
        offer_applied, offer_flat_price, offer_minutes_limit, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
      RETURNING *
    `;

    const values = [
      caller_id,
      listener_id,
      call_type,
      rate_per_minute,
      billed_user_rate_per_min,
      billed_payout_rate_per_min,
      offer_applied,
      offer_flat_price,
      offer_minutes_limit,
    ];
    const result = await pool.query(query, values);
    return result.rows[0];
  }

  // Get call by ID
  static async findById(call_id) {
    const query = `
      SELECT c.*,
             u1.display_name as caller_name, u1.avatar_url as caller_avatar,
             u2.display_name as listener_name, u2.avatar_url as listener_avatar,
             l.professional_name
      FROM calls c
      LEFT JOIN users u1 ON c.caller_id = u1.user_id
      LEFT JOIN listeners l ON c.listener_id = l.listener_id
      LEFT JOIN users u2 ON l.user_id = u2.user_id
      WHERE c.call_id = $1
    `;
    const result = await pool.query(query, [call_id]);
    return result.rows[0];
  }

  // Update call status
  static async updateStatus(call_id, status, additionalData = {}) {
    const updates = ['status = $1'];
    const values = [status];
    let paramIndex = 2;

    if (status === 'ongoing') {
      updates.push('started_at = CURRENT_TIMESTAMP');
    }

    if (status === 'completed' || status === 'missed' || status === 'cancelled') {
      updates.push('ended_at = CURRENT_TIMESTAMP');
    }

    const addField = (field, value) => {
      if (value !== undefined) {
        updates.push(`${field} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    };

    addField('duration_seconds', additionalData.duration_seconds);
    addField('total_cost', additionalData.total_cost);
    addField('billed_minutes', additionalData.billed_minutes);
    addField('rate_per_minute', additionalData.rate_per_minute);
    addField('offer_applied', additionalData.offer_applied);
    addField('offer_flat_price', additionalData.offer_flat_price);
    addField('offer_minutes_limit', additionalData.offer_minutes_limit);

    const query = `UPDATE calls SET ${updates.join(', ')} WHERE call_id = $${paramIndex} RETURNING *`;
    values.push(call_id);

    const result = await pool.query(query, values);
    return result.rows[0];
  }

  // Get user's call history
  static async getUserCallHistory(user_id, limit = 20, offset = 0) {
    const query = `
      SELECT c.*,
             l.professional_name as listener_name,
             l.profile_image as listener_avatar,
             l.user_id as listener_user_id,
             l.last_active_at as listener_last_seen,
             CASE
                WHEN COALESCE(l.is_online, FALSE) = TRUE
                  AND l.last_active_at IS NOT NULL
                  AND (NOW() - l.last_active_at) <= INTERVAL '2 minutes'
                THEN true
                ELSE false
             END as listener_online,
             u.display_name as listener_display_name,
             u.city
      FROM calls c
      JOIN listeners l ON c.listener_id = l.listener_id
      JOIN users u ON l.user_id = u.user_id
      WHERE c.caller_id = $1
      ORDER BY c.created_at DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await pool.query(query, [user_id, limit, offset]);
    return result.rows;
  }

  // Get listener's call history
  // FIX: JOIN call_records to get backend-calculated listener_earn instead of
  // total_cost (user charge). The listener must see their actual payout, not
  // the amount the user was charged. listener_earn is computed by
  // callBillingService using the admin-set listener_payout_per_min rate.
  static async getListenerCallHistory(listener_id, limit = 20, offset = 0) {
    const query = `
      SELECT c.*,
             COUNT(*) OVER()::int as total_count,
             COALESCE(
               NULLIF(c.duration_seconds, 0),
               NULLIF(c.billed_minutes, 0) * 60,
               NULLIF(cr.minutes, 0) * 60,
               0
             )::int as duration_seconds,
             COALESCE(c.total_cost, cr.user_charge, 0) as total_cost,
             u.display_name as caller_name,
             u.avatar_url as caller_avatar,
             u.city,
             u.last_seen as caller_last_seen,
             CASE
               WHEN u.last_seen IS NOT NULL AND (NOW() - u.last_seen) <= INTERVAL '2 minutes'
               THEN true
               ELSE false
             END as caller_online,
             cr.listener_earn,
             cr.user_charge as cr_user_charge,
             c.billed_minutes,
             cr.minutes as billed_minutes_cr
      FROM calls c
      JOIN users u ON c.caller_id = u.user_id
      LEFT JOIN call_records cr ON c.call_id = cr.call_id
      WHERE c.listener_id = $1
      ORDER BY c.created_at DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await pool.query(query, [listener_id, limit, offset]);
    let totalCount = result.rows.length > 0
      ? Number(result.rows[0].total_count || result.rows.length)
      : 0;
    if (result.rows.length === 0 && offset > 0) {
      const countResult = await pool.query(
        'SELECT COUNT(*)::int as total_count FROM calls WHERE listener_id = $1',
        [listener_id]
      );
      totalCount = Number(countResult.rows[0]?.total_count || 0);
    }
    const calls = result.rows.map(({ total_count, ...row }) => row);
    return { calls, totalCount };
  }

  // Get active calls for a user
  static async getActiveCalls(user_id) {
    const query = `
      SELECT c.*,
             l.professional_name, l.profile_image,
             l.user_id as listener_user_id,
              CASE
                WHEN COALESCE(l.is_online, FALSE) = TRUE
                  AND l.last_active_at IS NOT NULL
                  AND (NOW() - l.last_active_at) <= INTERVAL '2 minutes'
               THEN true
               ELSE false
             END as listener_online,
             u.display_name as listener_display_name
      FROM calls c
      JOIN listeners l ON c.listener_id = l.listener_id
      JOIN users u ON l.user_id = u.user_id
      WHERE c.caller_id = $1
        AND (
          c.status = 'ongoing'
          OR (
            c.status IN ('pending', 'ringing')
            AND c.created_at >= NOW() - INTERVAL '2 minutes'
          )
        )
        ORDER BY c.created_at DESC
    `;
    const result = await pool.query(query, [user_id]);
    return result.rows;
  }

  static calculateBillingMinutes(duration_seconds) {
    const seconds = Math.max(0, Math.floor(Number(duration_seconds) || 0));
    // Billing rounds up to the next full minute so any partial minute counts as a full minute.
    return Math.max(1, Math.ceil(seconds / 60));
  }

  static calculateBillingAmount(duration_seconds, rate_per_minute) {
    const minutes = this.calculateBillingMinutes(duration_seconds);
    return Number((minutes * Number(rate_per_minute || 0)).toFixed(2));
  }

  static calculateCallCharge({
    duration_seconds,
    normal_rate_per_minute,
    listener_rate_per_minute,
    offer
  }) {
    const minutes = this.calculateBillingMinutes(duration_seconds);
    const normalRate = Number(normal_rate_per_minute || 0);
    const listenerRate = Number(listener_rate_per_minute || 0);

    // Offer math: apply flat price for the first N minutes, then normal rate for the rest.
    let userCharge = minutes * normalRate;
    let offerApplied = false;
    let offerMinutesLimit = null;
    let offerFlatPrice = null;

    if (offer && offer.enabled === true) {
      offerApplied = true;
      offerMinutesLimit = Number(offer.minutesLimit || 0);
      offerFlatPrice = Number(offer.flatPrice || 0);
      if (minutes <= offerMinutesLimit) {
        userCharge = offerFlatPrice;
      } else {
        userCharge = offerFlatPrice + (minutes - offerMinutesLimit) * normalRate;
      }
    }

    const listenerEarn = minutes * listenerRate;

    return {
      minutes,
      userCharge: Number(userCharge.toFixed(2)),
      listenerEarn: Number(listenerEarn.toFixed(2)),
      offerApplied,
      offerMinutesLimit,
      offerFlatPrice,
      normalRate
    };
  }
}

export default Call;
