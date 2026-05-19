import { pool } from '../db.js';
import { deleteFromMinioByUrl } from '../utils/minioUpload.js';

const toFiniteNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const resolveEffectiveRatesForListenerIds = async (listenerIds = []) => {
  const uniqueIds = [...new Set((listenerIds || []).filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  const result = await pool.query(
    `
      WITH target_listeners AS (
        SELECT UNNEST($1::uuid[]) AS listener_id
      ),
      rating_agg AS (
        SELECT r.listener_id, ROUND(AVG(r.rating)::numeric, 2) AS average_rating
        FROM ratings r
        INNER JOIN target_listeners tl ON tl.listener_id = r.listener_id
        GROUP BY r.listener_id
      ),
      call_agg AS (
        SELECT
          c.listener_id,
          COALESCE(
            SUM(
              COALESCE(
                NULLIF(c.billed_minutes, 0),
                NULLIF(cr.minutes, 0),
                CASE
                  WHEN COALESCE(c.duration_seconds, 0) > 0
                  THEN CEIL(c.duration_seconds / 60.0)
                  ELSE 0
                END
              )
            ),
            0
          )::numeric(10, 1) AS total_call_minutes
        FROM calls c
        INNER JOIN target_listeners tl ON tl.listener_id = c.listener_id
        LEFT JOIN call_records cr ON cr.call_id = c.call_id
        WHERE c.status = 'completed'
        GROUP BY c.listener_id
      ),
      listener_inputs AS (
        SELECT
          tl.listener_id,
          COALESCE(r.average_rating, 0)::numeric(3, 2) AS average_rating,
          COALESCE(c.total_call_minutes, 0)::numeric(10, 1) AS total_call_minutes
        FROM target_listeners tl
        LEFT JOIN rating_agg r ON r.listener_id = tl.listener_id
        LEFT JOIN call_agg c ON c.listener_id = tl.listener_id
      ),
      global_rate AS (
        SELECT user_rate, payout_rate
        FROM listener_global_rate_config
        ORDER BY updated_at DESC
        LIMIT 1
      )
      SELECT
        li.listener_id,
        COALESCE(rr.user_rate, gr.user_rate) AS user_rate,
        COALESCE(rr.payout_rate, gr.payout_rate) AS payout_rate
      FROM listener_inputs li
      LEFT JOIN LATERAL (
        SELECT user_rate, payout_rate
        FROM listener_rate_rules
        WHERE is_active = TRUE
          AND li.average_rating BETWEEN min_rating AND max_rating
          AND li.total_call_minutes BETWEEN min_duration AND max_duration
        ORDER BY min_rating DESC, min_duration DESC, updated_at DESC
        LIMIT 1
      ) rr ON TRUE
      LEFT JOIN global_rate gr ON TRUE
    `,
    [uniqueIds]
  );

  const rateMap = new Map();
  for (const row of result.rows) {
    const userRate = toFiniteNumber(row.user_rate);
    const payoutRate = toFiniteNumber(row.payout_rate);
    if (userRate && payoutRate) {
      rateMap.set(row.listener_id, { userRate, payoutRate });
    }
  }
  return rateMap;
};

const attachResolvedRates = async (listeners) => {
  if (!Array.isArray(listeners) || listeners.length === 0) return listeners;

  const listenerIds = listeners
    .map((listener) => listener?.listener_id)
    .filter(Boolean);
  const rateMap = await resolveEffectiveRatesForListenerIds(listenerIds);

  return listeners.map((listener) => {
    const resolved = rateMap.get(listener.listener_id);
    if (!resolved) return listener;
    return {
      ...listener,
      rate_per_minute: resolved.userRate,
      user_rate_per_min: resolved.userRate,
      listener_payout_per_min: resolved.payoutRate,
    };
  });
};

class Listener {
  static async applyResolvedRates(listeners = []) {
    return attachResolvedRates(listeners);
  }

  // Create new listener profile
  static async create(listenerData) {
    const {
      user_id,
      original_name,
      professional_name,
      age,
      specialties = [],
      experiences = [],
      languages = [],
      currency = 'INR',
      profile_image,
      experience_years,
      education,
      certifications = [],
      mobile_number
    } = listenerData;

    try {
      // Ensure arrays are properly formatted for PostgreSQL
      const sanitizedSpecialties = Array.isArray(specialties) ? specialties : [];
      const sanitizedLanguages = Array.isArray(languages) ? languages : [];
      const sanitizedCertifications = Array.isArray(certifications) ? certifications : [];

      // Note: original_name column may not exist in all databases
      // experiences should be updated separately via updateExperiences() method
      // to avoid database compatibility issues
      const initialRuleResult = await pool.query(
        `
          SELECT user_rate, payout_rate
          FROM listener_rate_rules
          WHERE is_active = TRUE
            AND 0 BETWEEN min_rating AND max_rating
            AND 0 BETWEEN min_duration AND max_duration
          ORDER BY min_rating DESC, min_duration DESC, updated_at DESC
          LIMIT 1
        `
      );

      let userRatePerMin = toFiniteNumber(initialRuleResult.rows[0]?.user_rate);
      let payoutRatePerMin = toFiniteNumber(initialRuleResult.rows[0]?.payout_rate);

      if (!userRatePerMin || !payoutRatePerMin) {
        const globalRateResult = await pool.query(
          `
            SELECT user_rate, payout_rate
            FROM listener_global_rate_config
            ORDER BY updated_at DESC
            LIMIT 1
          `
        );
        userRatePerMin = toFiniteNumber(globalRateResult.rows[0]?.user_rate);
        payoutRatePerMin = toFiniteNumber(globalRateResult.rows[0]?.payout_rate);
      }

      if (!userRatePerMin || !payoutRatePerMin) {
        throw new Error('Listener rates are not configured in admin panel');
      }

      const query = `
        INSERT INTO listeners (
          user_id, original_name, professional_name, age, specialties, languages,
          rate_per_minute, user_rate_per_min, listener_payout_per_min,
          currency, profile_image, experience_years,
          education, certifications, mobile_number, verification_status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pending')
        RETURNING *
      `;

      const values = [
        user_id,
        original_name || null,
        professional_name,
        age || null,
        sanitizedSpecialties,
        sanitizedLanguages,
        userRatePerMin,
        userRatePerMin,
        payoutRatePerMin,
        currency,
        profile_image || null,
        experience_years || null,
        education || null,
        sanitizedCertifications,
        mobile_number || null
      ];

      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (error) {
      console.error('Error creating listener in database:', error.message, error.detail);
      throw error;
    }
  }

  // Update listener experiences (separate from creation)
  static async updateExperiences(listener_id, experiences) {
    const query = `
      UPDATE listeners 
      SET experiences = $1, updated_at = CURRENT_TIMESTAMP
      WHERE listener_id = $2
      RETURNING experiences
    `;
    const result = await pool.query(query, [experiences, listener_id]);
    return result.rows[0];
  }

  // Get listener by user_id
  static async findByUserId(user_id) {
    const query = `
      SELECT l.*, u.phone_number, u.email, u.city, u.country,
        pd.payment_method, pd.mobile_number as payment_mobile_number, pd.upi_id, pd.aadhaar_number, pd.pan_number, pd.name_as_per_pan,
        pd.account_number, pd.ifsc_code, pd.bank_name, pd.account_holder_name, pd.pan_aadhaar_bank,
        pd.is_verified as payment_verified
      FROM listeners l
      JOIN users u ON l.user_id = u.user_id
      LEFT JOIN listener_payment_details pd ON l.listener_id = pd.listener_id
      WHERE l.user_id = $1
    `;
    const result = await pool.query(query, [user_id]);
    const listener = (await attachResolvedRates(result.rows))[0];
    
    if (listener) {
      // Structure payment info
      if (listener.payment_method) {
        listener.payment_info = {
          payment_method: listener.payment_method,
          mobile_number: listener.payment_mobile_number,
          upi_id: listener.upi_id,
          aadhaar_number: listener.aadhaar_number,
          pan_number: listener.pan_number,
          name_as_per_pan: listener.name_as_per_pan,
          account_number: listener.account_number,
          ifsc_code: listener.ifsc_code,
          bank_name: listener.bank_name,
          account_holder_name: listener.account_holder_name,
          pan_aadhaar_bank: listener.pan_aadhaar_bank,
          payout_status: listener.payment_verified ? 'verified' : 'pending',
          payout_currency: listener.currency || 'INR'
        };
      }
      
      // Clean up individual payment fields
      delete listener.payment_method;
      delete listener.payment_mobile_number;
      delete listener.upi_id;
      delete listener.aadhaar_number;
      delete listener.pan_number;
      delete listener.name_as_per_pan;
      delete listener.account_number;
      delete listener.ifsc_code;
      delete listener.bank_name;
      delete listener.account_holder_name;
      delete listener.pan_aadhaar_bank;
      delete listener.payment_verified;
    }
    
    return listener;
  }

  // Get listener by listener_id
  static async findById(listener_id) {
    const query = `
      SELECT l.*, u.phone_number, u.email, u.city, u.country, u.display_name,
        CASE 
          WHEN l.last_active_at IS NOT NULL AND (NOW() - l.last_active_at) <= INTERVAL '2 minutes' 
          THEN true 
          ELSE false 
        END as is_online,
        pd.payment_method, pd.mobile_number as payment_mobile_number, pd.upi_id, pd.aadhaar_number, pd.pan_number, pd.name_as_per_pan,
        pd.account_number, pd.ifsc_code, pd.bank_name, pd.account_holder_name, pd.pan_aadhaar_bank,
        pd.is_verified as payment_verified
      FROM listeners l
      JOIN users u ON l.user_id = u.user_id
      LEFT JOIN listener_payment_details pd ON l.listener_id = pd.listener_id
      WHERE l.listener_id = $1
    `;
    const result = await pool.query(query, [listener_id]);
    const listener = (await attachResolvedRates(result.rows))[0];
    
    if (listener) {
      // Structure payment info
      if (listener.payment_method) {
        listener.payment_info = {
          payment_method: listener.payment_method,
          mobile_number: listener.payment_mobile_number,
          upi_id: listener.upi_id,
          aadhaar_number: listener.aadhaar_number,
          pan_number: listener.pan_number,
          name_as_per_pan: listener.name_as_per_pan,
          account_number: listener.account_number,
          ifsc_code: listener.ifsc_code,
          bank_name: listener.bank_name,
          account_holder_name: listener.account_holder_name,
          pan_aadhaar_bank: listener.pan_aadhaar_bank,
          payout_status: listener.payment_verified ? 'verified' : 'pending',
          payout_currency: listener.currency || 'INR'
        };
      }
      
      // Clean up individual fields
      delete listener.payment_method;
      delete listener.payment_mobile_number;
      delete listener.upi_id;
      delete listener.aadhaar_number;
      delete listener.pan_number;
      delete listener.name_as_per_pan;
      delete listener.account_number;
      delete listener.ifsc_code;
      delete listener.bank_name;
      delete listener.account_holder_name;
      delete listener.pan_aadhaar_bank;
      delete listener.payment_verified;
    }
    
    return listener;
  }

  // Get all listeners with filters
  static async getAll(filters = {}) {
    let query = `
      SELECT
        l.listener_id,
        l.user_id,
        l.professional_name,
        l.age,
        l.specialties,
        l.languages,
        l.profile_image,
        l.average_rating,
        l.total_ratings,
        l.total_calls,
        l.total_minutes,
        l.is_available,
        l.is_verified,
        l.verification_status,
        l.voice_verified,
        l.voice_verification_url,
        l.listener_type,
        l.user_rate_per_min,
        COALESCE(l.is_busy, false) as is_busy,
        u.city,
        u.country,
        u.gender,
        u.display_name,
        CASE 
          WHEN l.last_active_at IS NOT NULL AND (NOW() - l.last_active_at) <= INTERVAL '2 minutes' 
          THEN true 
          ELSE false 
        END as is_online,
        CASE 
          WHEN l.last_active_at IS NOT NULL AND (NOW() - l.last_active_at) <= INTERVAL '2 minutes' 
          THEN 1 
          ELSE 0 
        END as online_sort
      FROM listeners l
      JOIN users u ON l.user_id = u.user_id
      WHERE u.is_active = TRUE
        AND l.is_active = TRUE
        AND COALESCE(l.verification_status, 'approved') = 'approved' -- VERIFICATION CHECK: Only show approved listeners
    `;
    const values = [];
    let paramIndex = 1;

    // Only filter by is_available if explicitly requested
    if (filters.is_available !== undefined) {
      query += ` AND l.is_available = $${paramIndex}`;
      values.push(filters.is_available);
      paramIndex++;
    }

    // Only filter by busy status if explicitly requested
    if (filters.is_busy !== undefined) {
      query += ` AND COALESCE(l.is_busy, false) = $${paramIndex}`;
      values.push(filters.is_busy);
      paramIndex++;
    }

    // Filter by specialty
    if (filters.specialty) {
      query += ` AND $${paramIndex} = ANY(l.specialties)`;
      values.push(filters.specialty);
      paramIndex++;
    }

    // Filter by language
    if (filters.language) {
      query += ` AND $${paramIndex} = ANY(l.languages)`;
      values.push(filters.language);
      paramIndex++;
    }

    // Filter by online status - filter based on calculated is_online
    if (filters.is_online !== undefined) {
      if (filters.is_online) {
        query += ` AND l.last_active_at IS NOT NULL AND (NOW() - l.last_active_at) <= INTERVAL '2 minutes'`;
      } else {
        query += ` AND (l.last_active_at IS NULL OR (NOW() - l.last_active_at) > INTERVAL '2 minutes')`;
      }
    }

    // Filter by minimum rating
    if (filters.min_rating) {
      query += ` AND l.average_rating >= $${paramIndex}`;
      values.push(filters.min_rating);
      paramIndex++;
    }

    // Filter by city
    if (filters.city) {
      query += ` AND u.city ILIKE $${paramIndex}`;
      values.push(`%${filters.city}%`);
      paramIndex++;
    }

    // Sort by online status first (online listeners first), then by requested sort key.
    const sortBy = filters.sort_by || 'rating';
    const needsResolvedPriceSort = sortBy === 'price_low' || sortBy === 'price_high';
    let orderClause = ' ORDER BY online_sort DESC';
    
    if (sortBy === 'rating') {
      orderClause += ', l.average_rating DESC, l.total_ratings DESC';
    } else if (sortBy === 'recent') {
      orderClause += ', l.created_at DESC';
    }
    
    query += orderClause;

    const limit = filters.limit || 20;
    const offset = filters.offset || 0;

    // For price sorting we need resolved admin-rule rates first, then sort in memory.
    // SQL-level sorting by stored l.user_rate_per_min can drift from effective rule rates.
    if (!needsResolvedPriceSort) {
      query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      values.push(limit, offset);
    }

    const result = await pool.query(query, values);
    const resolvedRows = await attachResolvedRates(result.rows);

    if (!needsResolvedPriceSort) {
      return resolvedRows;
    }

    const direction = sortBy === 'price_high' ? -1 : 1;
    const sortedRows = [...resolvedRows].sort((a, b) => {
      const onlineA = Number(a.online_sort || 0);
      const onlineB = Number(b.online_sort || 0);
      if (onlineA !== onlineB) return onlineB - onlineA;

      const rateA = Number(a.user_rate_per_min ?? a.rate_per_minute ?? 0);
      const rateB = Number(b.user_rate_per_min ?? b.rate_per_minute ?? 0);
      if (rateA !== rateB) return direction * (rateA - rateB);

      const ratingA = Number(a.average_rating || 0);
      const ratingB = Number(b.average_rating || 0);
      if (ratingA !== ratingB) return ratingB - ratingA;

      return Number(b.total_ratings || 0) - Number(a.total_ratings || 0);
    });

    return sortedRows.slice(offset, offset + limit);
  }

  // Search listeners by name, specialty, or city
  static async search(searchTerm) {
    const query = `
      SELECT
        l.listener_id,
        l.user_id,
        l.professional_name,
        l.age,
        l.specialties,
        l.languages,
        l.profile_image,
        l.average_rating,
        l.total_ratings,
        l.total_calls,
        l.total_minutes,
        l.is_available,
        l.is_verified,
        l.verification_status,
        l.listener_type,
        l.user_rate_per_min,
        COALESCE(l.is_busy, false) as is_busy,
        u.city,
        u.country,
        u.display_name,
        CASE 
          WHEN l.last_active_at IS NOT NULL AND (NOW() - l.last_active_at) <= INTERVAL '2 minutes' 
          THEN true 
          ELSE false 
        END as is_online,
        CASE 
          WHEN l.last_active_at IS NOT NULL AND (NOW() - l.last_active_at) <= INTERVAL '2 minutes' 
          THEN 1 
          ELSE 0 
        END as online_sort
      FROM listeners l
      JOIN users u ON l.user_id = u.user_id
      WHERE u.is_active = TRUE
        AND l.is_active = TRUE
        AND COALESCE(l.verification_status, 'approved') = 'approved' -- VERIFICATION CHECK: Only show approved listeners
        AND (
          l.professional_name ILIKE $1 
          OR u.city ILIKE $1
          OR EXISTS (
            SELECT 1 FROM unnest(l.specialties) AS specialty 
            WHERE specialty ILIKE $1
          )
        )
      ORDER BY online_sort DESC, l.average_rating DESC
      LIMIT 20
    `;
    
    const result = await pool.query(query, [`%${searchTerm}%`]);
    
    return attachResolvedRates(result.rows);
  }

  // Get all listeners for admin with online status
  static async getAllForAdmin() {
    const query = `
      SELECT
        l.listener_id,
        l.user_id,
        COALESCE(l.professional_name, u.display_name) as name,
        l.age,
        l.profile_image,
        l.rate_per_minute,
        l.user_rate_per_min,
        l.listener_payout_per_min,
        l.currency,
        l.average_rating,
        l.total_ratings,
        l.is_available,
        l.is_verified,
        l.verification_status,
        l.rejection_reason,
        l.reapply_attempts,
        l.total_earning,
        l.wallet_balance,
        l.is_active,
        l.created_at,
        l.updated_at,
        l.last_active_at,
        l.mobile_number,
        CASE 
          WHEN l.last_active_at IS NOT NULL AND (NOW() - l.last_active_at) <= INTERVAL '2 minutes' 
          THEN true 
          ELSE false 
        END as is_online,
        u.display_name as user_display_name,
        u.email,
        u.phone_number,
        u.city,
        u.country,
        u.is_active as user_active,
        u.created_at as user_created_at,
        COALESCE(r_agg.computed_avg_rating, 0) as computed_avg_rating,
        COALESCE(r_agg.computed_total_ratings, 0) as computed_total_ratings,
        COALESCE(c_agg.total_call_minutes, 0) as total_call_minutes,
        COALESCE(c_agg.total_calls, 0) as total_calls
      FROM listeners l
      JOIN users u ON l.user_id = u.user_id
      LEFT JOIN (
        SELECT listener_id,
               ROUND(AVG(rating)::numeric, 2) as computed_avg_rating,
               COUNT(*) as computed_total_ratings
        FROM ratings
        GROUP BY listener_id
      ) r_agg ON r_agg.listener_id = l.listener_id
      LEFT JOIN (
        SELECT
          c.listener_id,
          COALESCE(
            SUM(
              COALESCE(
                NULLIF(c.billed_minutes, 0),
                NULLIF(cr.minutes, 0),
                CASE
                  WHEN COALESCE(c.duration_seconds, 0) > 0
                  THEN CEIL(c.duration_seconds / 60.0)
                  ELSE 0
                END
              )
            ),
            0
          )::numeric(10, 1) as total_call_minutes,
          COUNT(*) as total_calls
        FROM calls c
        LEFT JOIN call_records cr ON cr.call_id = c.call_id
        WHERE c.status = 'completed'
        GROUP BY c.listener_id
      ) c_agg ON c_agg.listener_id = l.listener_id
    `;
    const result = await pool.query(query);

    const listeners = result.rows.map(row => {
      return {
        listener_id: row.listener_id,
        user_id: row.user_id,
        name: row.name,
        age: row.age,
        profile_image: row.profile_image,
        rate_per_minute: row.rate_per_minute,
        user_rate_per_min: row.user_rate_per_min,
        listener_payout_per_min: row.listener_payout_per_min,
        currency: row.currency,
        average_rating: row.average_rating,
        total_ratings: row.total_ratings,
        is_available: row.is_available,
        is_verified: row.is_verified,
        verification_status: row.verification_status,
        rejection_reason: row.rejection_reason,
        reapply_attempts: row.reapply_attempts || 0,
        total_earning: row.total_earning,
        wallet_balance: row.wallet_balance,
        is_active: row.is_active,
        created_at: row.created_at,
        updated_at: row.updated_at,
        last_active_at: row.last_active_at,
        is_online: row.is_online,
        user_display_name: row.user_display_name,
        email: row.email,
        phone_number: row.phone_number,
        mobile_number: row.mobile_number,
        city: row.city,
        country: row.country,
        user_active: row.user_active,
        user_created_at: row.user_created_at,
        computed_avg_rating: parseFloat(row.computed_avg_rating) || 0,
        computed_total_ratings: parseInt(row.computed_total_ratings) || 0,
        total_call_minutes: parseFloat(row.total_call_minutes) || 0,
        total_calls: parseInt(row.total_calls) || 0
      };
    });

    return attachResolvedRates(listeners);
  }

  // Update listener profile
  static async update(listener_id, updateData) {
    // Accept frontend keys and map to DB columns when needed
    const allowedFields = [
      'original_name', 'professional_name', 'age', 'specialties', 'languages',
      'profile_image', 'background_image',
      'experience_years', 'education', 'certifications', 'is_available', 'is_online',
      'mobile_number',
      // allow alias from frontend
      'avatar_url'
    ];

    // field -> column mapping (frontend -> DB)
    const fieldToColumn = {
      'avatar_url': 'profile_image',
      'profile_image': 'profile_image'
    };

    const updates = [];
    const values = [];
    let paramIndex = 1;

    // Normalize array fields if passed as comma-separated strings
    ['specialties', 'languages', 'certifications'].forEach(field => {
      if (updateData[field] && typeof updateData[field] === 'string') {
        updateData[field] = updateData[field]
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
      }
    });

    Object.keys(updateData).forEach(key => {
      if (!allowedFields.includes(key) || updateData[key] === undefined) return;

      const column = fieldToColumn[key] || key;
      updates.push(`${column} = $${paramIndex}`);
      values.push(updateData[key]);
      paramIndex++;
    });

    if (updates.length === 0) {
      throw new Error('No valid fields to update');
    }

    values.push(listener_id);
    const query = `
      UPDATE listeners
      SET ${updates.join(', ')}, last_active_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE listener_id = $${paramIndex}
      RETURNING *
    `;

    try {
      const result = await pool.query(query, values);
      return (await attachResolvedRates(result.rows))[0];
    } catch (error) {
      // If a column doesn't exist (e.g., using frontend name), try a fallback
      if (error.code === '42703' && (error.message || '').includes('profile_image')) {
        // Attempt to alter table to add column if sensible, or retry mapping
        try {
          await pool.query('ALTER TABLE listeners ADD COLUMN IF NOT EXISTS profile_image TEXT');
          const retryResult = await pool.query(query, values);
          return retryResult.rows[0];
        } catch (retryError) {
          throw retryError;
        }
      }
      throw error;
    }
  }

  // Update last active timestamp
  static async updateLastActive(listener_id) {
    const query = `
      UPDATE listeners 
      SET last_active_at = CURRENT_TIMESTAMP
      WHERE listener_id = $1
    `;
    await pool.query(query, [listener_id]);
  }

  // Update last active timestamp by user_id (used from socket handler)
  static async updateLastActiveByUserId(user_id) {
    const query = `
      UPDATE listeners 
      SET last_active_at = CURRENT_TIMESTAMP
      WHERE user_id = $1
    `;
    await pool.query(query, [user_id]);
  }

  // Clear last active timestamp by user_id to mark offline immediately
  static async setOfflineByUserId(user_id) {
    const query = `
      UPDATE listeners 
      SET last_active_at = NULL
      WHERE user_id = $1
    `;
    await pool.query(query, [user_id]);
  }

  // Increment call statistics
  static async incrementCallStats(listener_id, duration_minutes) {
    const query = `
      UPDATE listeners 
      SET total_calls = total_calls + 1,
          total_minutes = total_minutes + $1
      WHERE listener_id = $2
      RETURNING total_calls, total_minutes
    `;
    const result = await pool.query(query, [duration_minutes, listener_id]);
    return result.rows[0];
  }

  // Get listener statistics
  static async getStats(listener_id) {
    const query = `
      WITH call_stats AS (
        SELECT
          c.listener_id,
          COUNT(*)::int AS total_calls,
          COALESCE(
            SUM(
              COALESCE(
                NULLIF(c.billed_minutes, 0),
                NULLIF(cr.minutes, 0),
                CASE
                  WHEN COALESCE(c.duration_seconds, 0) > 0
                  THEN CEIL(c.duration_seconds / 60.0)
                  ELSE 0
                END
              )
            ),
            0
          )::int AS total_minutes,
          SUM(COALESCE(c.total_cost, cr.user_charge, 0)) AS total_earnings,
          COUNT(DISTINCT c.caller_id) AS unique_callers
        FROM calls c
        LEFT JOIN call_records cr ON cr.call_id = c.call_id
        WHERE c.listener_id = $1
          AND c.status = 'completed'
        GROUP BY c.listener_id
      )
      SELECT 
        COALESCE(cs.total_calls, 0) AS total_calls,
        COALESCE(cs.total_minutes, 0) AS total_minutes,
        l.average_rating,
        l.total_ratings,
        COALESCE(cs.unique_callers, 0)::int as unique_callers,
        COALESCE(cs.total_earnings, 0) as total_earnings,
        (
          SELECT COUNT(*)
          FROM user_listener_follows ulf
          WHERE ulf.listener_user_id = l.user_id
        )::int AS followers_count
      FROM listeners l
      LEFT JOIN call_stats cs ON cs.listener_id = l.listener_id
      WHERE l.listener_id = $1
      GROUP BY
        l.listener_id,
        l.user_id,
        l.average_rating,
        l.total_ratings,
        cs.total_calls,
        cs.total_minutes,
        cs.unique_callers,
        cs.total_earnings
    `;
    const result = await pool.query(query, [listener_id]);
    return result.rows[0];
  }

  // Update voice verification status
  static async updateVoiceVerification(listener_id, voice_url, { verified = true } = {}) {
    const query = `
      UPDATE listeners 
      SET voice_verified = $1, voice_verification_url = $2, updated_at = CURRENT_TIMESTAMP
      WHERE listener_id = $3
      RETURNING listener_id, voice_verified, voice_verification_url
    `;
    const result = await pool.query(query, [verified, voice_url, listener_id]);
    return result.rows[0];
  }

  // Update experiences
  static async updateExperiences(listener_id, experiences) {
    try {
      const query = `
        UPDATE listeners 
        SET experiences = $1, updated_at = CURRENT_TIMESTAMP
        WHERE listener_id = $2
        RETURNING experiences
      `;
      const result = await pool.query(query, [experiences, listener_id]);
      return result.rows[0];
    } catch (error) {
      // If experiences column doesn't exist, try to add it
      if (error.message.includes('column "experiences" does not exist')) {
        console.log('Experiences column missing, attempting to add it...');
        try {
          await pool.query('ALTER TABLE listeners ADD COLUMN IF NOT EXISTS experiences TEXT[]');
          // Retry the update
          const result = await pool.query(`
            UPDATE listeners 
            SET experiences = $1, updated_at = CURRENT_TIMESTAMP
            WHERE listener_id = $2
            RETURNING experiences
          `, [experiences, listener_id]);
          console.log('Experiences column added and data updated successfully');
          return result.rows[0];
        } catch (retryError) {
          console.error('Failed to add experiences column:', retryError.message);
          throw retryError;
        }
      }
      throw error;
    }
  }

  // Get random available listeners (for random call matching)
  static async getRandomAvailable(limit = 1, excludeListenerId = null) {
    let query = `
      SELECT
        l.listener_id,
        l.user_id,
        l.professional_name,
        l.age,
        l.specialties,
        l.languages,
        l.profile_image,
        l.average_rating,
        l.total_ratings,
        l.total_calls,
        l.total_minutes,
        l.is_available,
        l.is_verified,
        l.verification_status,
        l.listener_type,
        l.user_rate_per_min,
        u.city,
        u.country,
        u.display_name,
        CASE 
          WHEN l.last_active_at IS NOT NULL AND (NOW() - l.last_active_at) <= INTERVAL '2 minutes' 
          THEN true 
          ELSE false 
        END as is_online
      FROM listeners l
      JOIN users u ON l.user_id = u.user_id
      WHERE l.is_available = TRUE AND u.is_active = TRUE
        AND l.is_active = TRUE
        AND COALESCE(l.is_busy, false) = FALSE
        AND l.last_active_at IS NOT NULL AND (NOW() - l.last_active_at) <= INTERVAL '2 minutes'
        AND COALESCE(l.verification_status, 'approved') = 'approved' -- VERIFICATION CHECK: Only show approved listeners
    `;
    const values = [];

    if (excludeListenerId) {
      query += ` AND l.listener_id != $1`;
      values.push(excludeListenerId);
    }

    query += ` ORDER BY RANDOM() LIMIT $${values.length + 1}`;
    values.push(limit);

    const result = await pool.query(query, values);
    
    return attachResolvedRates(result.rows);
  }

  // Update listener rating statistics
  static async updateRatingStats(listener_id, average_rating, total_ratings) {
    const query = `
      UPDATE listeners 
      SET average_rating = $1, total_ratings = $2
      WHERE listener_id = $3
    `;
    await pool.query(query, [average_rating, total_ratings, listener_id]);
  }

  // Update listener verification status (admin only)
  // VERIFICATION CONTROL: This method allows admin to approve/reject listeners
  static async updateVerificationStatus(listener_id, status, rejection_reason = null) {
    const validStatuses = ['pending', 'approved', 'rejected'];
    if (!validStatuses.includes(status)) {
      throw new Error(`Invalid verification status. Must be one of: ${validStatuses.join(', ')}`);
    }

    // Keep is_verified in sync: true if approved, false otherwise
    const isVerified = status === 'approved';

    // If rejecting, store the reason. If approving/pending, clear the reason.
    const reason = status === 'rejected' ? (rejection_reason || null) : null;

    const query = `
      UPDATE listeners 
      SET verification_status = $1, 
          is_verified = $2,
          rejection_reason = $3,
          updated_at = CURRENT_TIMESTAMP
      WHERE listener_id = $4
      RETURNING listener_id, verification_status, is_verified, rejection_reason, reapply_attempts
    `;
    
    const result = await pool.query(query, [status, isVerified, reason, listener_id]);
    return result.rows[0];
  }

  // Reapply for verification (listener requests re-review after rejection)
  static async reapplyForVerification(listener_id) {
    // Check current status and attempts
    const checkQuery = `
      SELECT verification_status, reapply_attempts 
      FROM listeners WHERE listener_id = $1
    `;
    const checkResult = await pool.query(checkQuery, [listener_id]);
    
    if (checkResult.rows.length === 0) {
      throw new Error('Listener not found');
    }
    
    const { verification_status, reapply_attempts } = checkResult.rows[0];
    
    if (verification_status !== 'rejected') {
      throw new Error('Can only reapply when status is rejected');
    }
    
    const MAX_REAPPLY_ATTEMPTS = 3;
    if (reapply_attempts >= MAX_REAPPLY_ATTEMPTS) {
      throw new Error(`Maximum reapply attempts (${MAX_REAPPLY_ATTEMPTS}) reached. Please contact support.`);
    }

    const query = `
      UPDATE listeners 
      SET verification_status = 'reapplied',
          reapply_attempts = reapply_attempts + 1,
          rejection_reason = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE listener_id = $1
      RETURNING listener_id, verification_status, is_verified, rejection_reason, reapply_attempts
    `;
    
    const result = await pool.query(query, [listener_id]);
    return result.rows[0];
  }

  // ── Busy status methods ──

  // Set listener busy (call started)
  static async setBusy(listener_id) {
    const query = `
      UPDATE listeners
      SET is_busy = TRUE, updated_at = CURRENT_TIMESTAMP
      WHERE listener_id = $1
      RETURNING listener_id, is_busy
    `;
    const result = await pool.query(query, [listener_id]);
    console.log(`[LISTENER] setBusy: listener ${listener_id} → busy=true`);
    return result.rows[0];
  }

  // Clear listener busy (call ended / disconnected)
  static async clearBusy(listener_id) {
    const query = `
      UPDATE listeners
      SET is_busy = FALSE, updated_at = CURRENT_TIMESTAMP
      WHERE listener_id = $1
      RETURNING listener_id, is_busy
    `;
    const result = await pool.query(query, [listener_id]);
    console.log(`[LISTENER] clearBusy: listener ${listener_id} → busy=false`);
    return result.rows[0];
  }

  // Clear busy by user_id (for socket disconnect cleanup)
  static async clearBusyByUserId(user_id) {
    const query = `
      UPDATE listeners
      SET is_busy = FALSE, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $1 AND is_busy = TRUE
      RETURNING listener_id, is_busy
    `;
    const result = await pool.query(query, [user_id]);
    if (result.rows.length > 0) {
      console.log(`[LISTENER] clearBusyByUserId: user ${user_id} → busy=false`);
    }
    return result.rows[0];
  }

  // Set busy by user_id
  static async setBusyByUserId(user_id) {
    const query = `
      UPDATE listeners
      SET is_busy = TRUE, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $1 AND is_busy = FALSE
      RETURNING listener_id, is_busy
    `;
    const result = await pool.query(query, [user_id]);
    if (result.rows.length > 0) {
      console.log(`[LISTENER] setBusyByUserId: user ${user_id} → busy=true`);
    }
    return result.rows[0];
  }

  // Check if listener is busy
  static async isBusy(listener_id) {
    const query = `SELECT is_busy FROM listeners WHERE listener_id = $1`;
    const result = await pool.query(query, [listener_id]);
    return result.rows[0]?.is_busy === true;
  }

  // Delete listener and all related data (including associated user account)
  static async delete(listener_id) {
    const client = await pool.connect();
    let voiceVerificationUrl = null;
    try {
      await client.query('BEGIN');

      // 1. Get the associated user_id before deleting
      const listenerResult = await client.query(
        'SELECT user_id, voice_verification_url FROM listeners WHERE listener_id = $1',
        [listener_id]
      );
      if (listenerResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }
      const user_id = listenerResult.rows[0].user_id;
      voiceVerificationUrl = listenerResult.rows[0].voice_verification_url || null;

      // 2. Delete listener reports first because they can reference both
      // the listener row and related call rows without ON DELETE CASCADE.
      await client.query(
        'DELETE FROM listener_reports WHERE listener_id = $1 OR reporter_user_id = $2',
        [listener_id, user_id]
      );

      // (Call records, calls, and call billing audit have ON DELETE SET NULL, 
      //  so we keep them instead of deleting, which protects transaction FKs)

      // 6. Delete ratings for this listener (CASCADE should handle, but explicit for safety)
      await client.query(
        'DELETE FROM ratings WHERE listener_id = $1',
        [listener_id]
      );

      // 7. Delete favorites referencing this listener
      await client.query(
        'DELETE FROM favorites WHERE listener_id = $1',
        [listener_id]
      );

      // 8. Delete listener payment details
      await client.query(
        'DELETE FROM listener_payment_details WHERE listener_id = $1',
        [listener_id]
      );

      // 9. Delete listener availability
      await client.query(
        'DELETE FROM listener_availability WHERE listener_id = $1',
        [listener_id]
      );

      // 10. Delete the listener row itself
      await client.query(
        'DELETE FROM listeners WHERE listener_id = $1',
        [listener_id]
      );

      // 11. If there is an associated user account, delete all user-related data too
      if (user_id) {
        // Delete notification deliveries for this user
        await client.query(
          'DELETE FROM notification_deliveries WHERE user_id = $1',
          [user_id]
        );

        // Delete contact messages by this user
        await client.query(
          'DELETE FROM contact_messages WHERE user_id = $1',
          [user_id]
        );

        // Delete delete account requests by this user
        await client.query(
          'DELETE FROM delete_account_requests WHERE user_id = $1',
          [user_id]
        );

        // Delete notifications for this user
        await client.query(
          'DELETE FROM notifications WHERE user_id = $1',
          [user_id]
        );

        // Delete transactions for this user
        await client.query(
          'DELETE FROM transactions WHERE user_id = $1',
          [user_id]
        );

        // Delete messages sent by this user
        await client.query(
          'DELETE FROM messages WHERE sender_id = $1',
          [user_id]
        );

        // Delete chats involving this user
        await client.query(
          'DELETE FROM chats WHERE user1_id = $1 OR user2_id = $1',
          [user_id]
        );

        // Delete blocked users records
        await client.query(
          'DELETE FROM blocked_users WHERE blocker_id = $1 OR blocked_id = $1',
          [user_id]
        );

        // Delete reports by or about this user
        await client.query(
          'DELETE FROM reports WHERE reporter_id = $1 OR reported_user_id = $1',
          [user_id]
        );

        // Delete user languages
        await client.query(
          'DELETE FROM user_languages WHERE user_id = $1',
          [user_id]
        );

        // Delete wallet
        await client.query(
          'DELETE FROM wallets WHERE user_id = $1',
          [user_id]
        );

        // Delete any remaining listener reports filed by this user
        await client.query(
          'DELETE FROM listener_reports WHERE reporter_user_id = $1',
          [user_id]
        );

        // Delete subscriptions that do not cascade on user deletion
        await client.query(
          'DELETE FROM subscriptions WHERE user_id = $1',
          [user_id]
        );

        // Delete any remaining calls by this user as caller
        await client.query(
          'DELETE FROM calls WHERE caller_id = $1',
          [user_id]
        );

        // Delete call records by this user
        await client.query(
          'DELETE FROM call_records WHERE user_id = $1',
          [user_id]
        );

        // Delete call billing audit by this user
        await client.query(
          'DELETE FROM call_billing_audit WHERE user_id = $1',
          [user_id]
        );

        // Finally, delete the user account itself
        await client.query(
          'DELETE FROM users WHERE user_id = $1',
          [user_id]
        );
      }

      await client.query('COMMIT');

      if (voiceVerificationUrl) {
        try {
          await deleteFromMinioByUrl(voiceVerificationUrl);
        } catch (cleanupError) {
          console.warn('[LISTENER_DELETE] Voice verification cleanup failed', {
            listenerId: listener_id,
            voiceVerificationUrl,
            message: cleanupError.message,
          });
        }
      }

      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export default Listener;
