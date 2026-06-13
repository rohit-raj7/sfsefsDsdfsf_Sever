import express from 'express';
const router = express.Router();
import { randomUUID } from 'crypto';
import Listener from '../models/Listener.js';
import Rating from '../models/Rating.js';
import User from '../models/User.js';
import { pool } from '../db.js';
import { authenticate, authenticateAdmin } from '../middleware/auth.js';
import multer from 'multer';
import { deleteFromMinioByUrl, uploadToMinio } from '../utils/minioUpload.js';


// Multer memory storage for voice uploads (no disk writes)
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB (increased from 10MB for longer recordings)
  fileFilter: (req, file, cb) => {
    // Accept all common audio MIME types sent by Android/iOS/web recording packages
    const allowed = [
      'audio/mpeg',
      'audio/wav',
      'audio/ogg',
      'audio/webm',
      'audio/m4a',
      'audio/mp4',
      'audio/aac',
      'audio/x-m4a',
      'audio/3gpp',
      'audio/amr',
      'video/mp4', // Some Android recorders send m4a as video/mp4
      'application/octet-stream', // Fallback for unknown binary
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      console.warn(`[UPLOAD_VOICE] Rejected file with MIME type: ${file.mimetype}`);
      cb(new Error(`Unsupported audio type: ${file.mimetype}`), false);
    }
  },
});

// Multer memory storage for avatar uploads
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB size limit as per requirements
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif'
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      console.warn(`[UPLOAD_AVATAR] Rejected file with MIME type: ${file.mimetype}`);
      cb(new Error(`Unsupported image type: ${file.mimetype}. Only JPEG, PNG, WEBP, and GIF are allowed.`), false);
    }
  },
});

const summarizeListenerProfilePayload = (payload = {}) => ({
  professional_name: payload.professional_name,
  has_original_name: Boolean(payload.original_name),
  specialty_count: Array.isArray(payload.specialties)
    ? payload.specialties.length
    : (payload.specialties ? 1 : 0),
  language_count: Array.isArray(payload.languages)
    ? payload.languages.length
    : (payload.languages ? 1 : 0),
  has_profile_image: Boolean(payload.profile_image),
  has_city: Boolean(payload.city),
});

const summarizePaymentPayload = (payload = {}) => ({
  payment_method: payload.payment_method,
  has_mobile_number: Boolean(payload.mobile_number),
  has_upi_id: Boolean(payload.upi_id),
  has_aadhaar_number: Boolean(payload.aadhaar_number),
  has_pan_number: Boolean(payload.pan_number),
  has_name_as_per_pan: Boolean(payload.name_as_per_pan),
  has_account_number: Boolean(payload.account_number),
  has_ifsc_code: Boolean(payload.ifsc_code),
  has_bank_name: Boolean(payload.bank_name),
  has_account_holder_name: Boolean(payload.account_holder_name),
  has_pan_aadhaar_bank: Boolean(payload.pan_aadhaar_bank),
});

const DEFAULT_WITHDRAWAL_TRANSACTION_FEE = 3.60;
const NON_EFFECTIVE_WITHDRAWAL_STATUSES = ['failed', 'rejected', 'cancelled'];

const getWithdrawalTransactionFee = async () => {
  const envFee = Number(process.env.LISTENER_WITHDRAWAL_TRANSACTION_FEE);
  if (Number.isFinite(envFee) && envFee >= 0) {
    return envFee;
  }
  return DEFAULT_WITHDRAWAL_TRANSACTION_FEE;
};

const ensureWithdrawalRequestsTable = async (db = pool) => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS listener_withdrawal_requests(
      request_id UUID PRIMARY KEY,
      listener_id UUID NOT NULL REFERENCES listeners(listener_id) ON DELETE CASCADE,
      payout_method VARCHAR(20) NOT NULL CHECK (payout_method IN ('upi', 'bank')),
      upi_id VARCHAR(255),
      account_number VARCHAR(32),
      ifsc_code VARCHAR(20),
      bank_name VARCHAR(120),
      account_holder_name VARCHAR(120),
      withdrawal_amount NUMERIC(12,2) NOT NULL CHECK (withdrawal_amount > 0),
      tds_amount NUMERIC(12,2) NOT NULL CHECK (tds_amount >= 0),
      transaction_fee NUMERIC(12,2) NOT NULL CHECK (transaction_fee >= 0),
      final_credit_amount NUMERIC(12,2) NOT NULL CHECK (final_credit_amount >= 0),
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      transaction_id VARCHAR(120),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE listener_withdrawal_requests ADD COLUMN IF NOT EXISTS remarks TEXT;
    ALTER TABLE listener_withdrawal_requests ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES admins(admin_id) ON DELETE SET NULL;
    ALTER TABLE listener_withdrawal_requests ADD COLUMN IF NOT EXISTS approved_at TIMESTAMP;
    ALTER TABLE listener_withdrawal_requests ADD COLUMN IF NOT EXISTS transaction_id VARCHAR(120);
    CREATE INDEX IF NOT EXISTS idx_listener_withdrawal_requests_listener_created
      ON listener_withdrawal_requests(listener_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_listener_withdrawal_requests_status
      ON listener_withdrawal_requests(status);
  `);
};

const getListenerWithdrawableBalance = async (
  listener = {},
  db = pool,
) => {
  const listenerId = listener.listener_id;
  if (!listenerId) return 0;

  await ensureWithdrawalRequestsTable(db);

  const excludedStatuses = NON_EFFECTIVE_WITHDRAWAL_STATUSES;
  const earningsResult = await db.query(
    `SELECT
       COALESCE(SUM(cr.listener_earn), 0)::numeric AS total_listener_earn
     FROM call_records cr
     WHERE cr.listener_id = $1`,
    [listenerId]
  );
  const earnedFromCalls = Number(earningsResult.rows?.[0]?.total_listener_earn || 0);

  const totalEarning = Number(listener.total_earning || 0);
  const walletBalance = Number(listener.wallet_balance || 0);

  // Prefer the highest trustworthy gross source so partial call_records
  // migrations do not under-report withdrawable balance.
  const grossCandidates = [
    Number.isFinite(earnedFromCalls) ? earnedFromCalls : 0,
    Number.isFinite(totalEarning) ? totalEarning : 0,
    Number.isFinite(walletBalance) ? walletBalance : 0,
  ];
  const grossEarnings = Math.max(...grossCandidates, 0);

  const withdrawnResult = await db.query(
    `SELECT
       COALESCE(SUM(withdrawal_amount), 0)::numeric AS total_withdrawn_amount
     FROM listener_withdrawal_requests
     WHERE listener_id = $1
       AND status <> ALL($2::text[])`,
    [listenerId, excludedStatuses]
  );
  const totalWithdrawn = Number(withdrawnResult.rows?.[0]?.total_withdrawn_amount || 0);

  const available = grossEarnings - totalWithdrawn;
  return available > 0 ? Number(available.toFixed(2)) : 0;
};

// GET /api/listeners
// Get all listeners with filters-
router.get('/', async (req, res) => {
  try {
    const filters = {
      specialty: req.query.specialty,
      language: req.query.language,
      is_online: req.query.is_online !== undefined ? req.query.is_online === 'true' : undefined,
      is_busy: req.query.is_busy !== undefined ? req.query.is_busy === 'true' : undefined,
      min_rating: req.query.min_rating ? parseFloat(req.query.min_rating) : undefined,
      city: req.query.city,
      sort_by: req.query.sort_by || 'rating',
      limit: req.query.limit ? parseInt(req.query.limit) : 20,
      offset: req.query.offset ? parseInt(req.query.offset) : 0
    };

    console.log('[LISTENERS_ROUTE] Fetching listeners with filters:', filters);

    const listeners = await Listener.getAll(filters);
    console.log('[LISTENERS_ROUTE] Found', listeners.length, 'listeners from database');

    // Add avatar_url alias from profile_image and rating alias for frontend compatibility
    const listenersWithAvatar = listeners.map(listener => ({
      ...listener,
      avatar_url: listener.profile_image || null,
      rating: listener.average_rating || 0
    }));

    console.log('[LISTENERS_ROUTE] Returning', listenersWithAvatar.length, 'listeners');

    res.json({
      listeners: listenersWithAvatar,
      count: listenersWithAvatar.length,
      filters: filters
    });
  } catch (error) {
    console.error('Get listeners error:', error);
    res.status(500).json({ error: 'Failed to fetch listeners' });
  }
});

// GET /api/listeners/smart-match
// Smart Matching Algorithm — returns ranked listeners based on user type
router.get('/smart-match', authenticate, async (req, res) => {
  try {
    const userId = req.userId;
    const { gender_filter, language_filter, is_verified_only } = req.query;

    // 1. Determine user type (trial, free, low-balance, high-balance, premium)
    const userResult = await pool.query(
      `SELECT u.wallet_balance, u.is_first_time_user, u.offer_used,
        EXISTS(SELECT 1 FROM subscriptions WHERE user_id = u.user_id AND is_active = TRUE AND expires_at > CURRENT_TIMESTAMP) as is_premium
       FROM users u WHERE u.user_id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    const balance = Number(user.wallet_balance || 0);
    const isPremium = user.is_premium;
    const isTrial = user.is_first_time_user && !user.offer_used;

    let userType = 'free';
    if (isPremium) userType = 'premium';
    else if (isTrial) userType = 'trial';
    else if (balance >= 100) userType = 'high_balance';
    else if (balance >= 1 && balance < 50) userType = 'low_balance';

    // 2. Build smart query based on user type
    let query = '';
    let params = [];
    let paramIndex = 1;
    const normalizedGenderFilter = String(gender_filter || '').trim().toLowerCase();
    const hasGenderFilter =
      normalizedGenderFilter.length > 0 && normalizedGenderFilter !== 'any';
    let genderClause = '';
    if (hasGenderFilter) {
      params.push(normalizedGenderFilter);
      genderClause = ` AND LOWER(u.gender) = $${paramIndex++}`;
    }

    // Toggle ON  → 'full' (professional) experts  |  Toggle OFF → 'casual' listeners
    // NOTE: is_verified mirrors verification_status='approved', so ALL approved listeners
    // have is_verified=TRUE — it cannot distinguish casual from professional experts.
    // listener_type is the correct field: 'full' = professional, 'casual' = regular.
    const expertFilter = is_verified_only === 'true'
      ? " AND l.listener_type = 'full'"
      : " AND l.listener_type = 'casual'";


    if (userType === 'trial' || userType === 'free') {
      // Trial / Free Random → New (Probation) + Casual Talkers
      query = `
        SELECT l.*, u.display_name, u.gender,
          CASE
            WHEN l.quality_status = 'probation' THEN 1
            WHEN l.listener_type = 'casual' THEN 2
            ELSE 3
          END as match_rank
        FROM listeners l
        JOIN users u ON l.user_id = u.user_id
        WHERE l.is_active = TRUE
          AND l.is_available = TRUE
          AND l.verification_status = 'approved'
          AND (l.quality_status IN ('probation', 'active', 'warning'))
          AND l.last_active_at IS NOT NULL AND (NOW() - l.last_active_at) <= INTERVAL '2 minutes' AND l.is_busy = FALSE${expertFilter}${genderClause}
        ORDER BY match_rank ASC, l.average_rating DESC
        LIMIT 50
      `;
    } else if (userType === 'low_balance') {
      // Low Balance (<₹50) → Casual Talkers + Rated Listeners
      query = `
        SELECT l.*, u.display_name, u.gender,
          CASE
            WHEN l.listener_type = 'casual' THEN 1
            WHEN l.average_rating >= 3.5 THEN 2
            ELSE 3
          END as match_rank
        FROM listeners l
        JOIN users u ON l.user_id = u.user_id
        WHERE l.is_active = TRUE
          AND l.is_available = TRUE
          AND l.verification_status = 'approved'
          AND l.quality_status IN ('active', 'warning')
          AND l.last_active_at IS NOT NULL AND (NOW() - l.last_active_at) <= INTERVAL '2 minutes' AND l.is_busy = FALSE${expertFilter}${genderClause}
        ORDER BY match_rank ASC, l.average_rating DESC
        LIMIT 50
      `;
    } else if (userType === 'high_balance') {
      // High Balance (₹100+) → 4.0+ Rated Listeners first
      query = `
        SELECT l.*, u.display_name, u.gender,
          CASE
            WHEN l.average_rating >= 4.0 THEN 1
            WHEN l.average_rating >= 3.5 THEN 2
            ELSE 3
          END as match_rank
        FROM listeners l
        JOIN users u ON l.user_id = u.user_id
        WHERE l.is_active = TRUE
          AND l.is_available = TRUE
          AND l.verification_status = 'approved'
          AND l.quality_status = 'active'
          AND l.last_active_at IS NOT NULL AND (NOW() - l.last_active_at) <= INTERVAL '2 minutes' AND l.is_busy = FALSE${expertFilter}${genderClause}
        ORDER BY match_rank ASC, l.average_rating DESC, l.total_calls DESC
        LIMIT 50
      `;
    } else if (userType === 'premium') {
      // ₹999 Premium → Filtered by gender/language preference
      let filters = [];
      if (hasGenderFilter) {
        filters.push(`LOWER(u.gender) = $${paramIndex - 1}`);
      }
      if (language_filter) {
        params.push(`%${language_filter}%`);
        filters.push(`l.languages::text ILIKE $${paramIndex++}`);
      }
      const whereFilter = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';

      query = `
        SELECT l.*, u.display_name, u.gender
        FROM listeners l
        JOIN users u ON l.user_id = u.user_id
        WHERE l.is_active = TRUE
          AND l.is_available = TRUE
          AND l.verification_status = 'approved'
          AND l.quality_status = 'active'
          AND l.last_active_at IS NOT NULL AND (NOW() - l.last_active_at) <= INTERVAL '2 minutes' AND l.is_busy = FALSE${expertFilter}
          ${whereFilter}
        ORDER BY l.average_rating DESC, l.total_calls DESC
        LIMIT 50
      `;
    }

    const result = await pool.query(query, params);
    const resolvedRows = await Listener.applyResolvedRates(result.rows);

    const listeners = resolvedRows.map(listener => ({
      ...listener,
      avatar_url: listener.profile_image || null,
      rating: listener.average_rating || 0
    }));

    res.json({
      success: true,
      userType,
      listeners,
      count: listeners.length,
    });
  } catch (error) {
    console.error('Smart match error:', error);
    res.status(500).json({ error: 'Failed to run smart matching' });
  }
});

// GET /api/listeners/search
// Search listeners
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;

    if (!q) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const listeners = await Listener.search(q);

    res.json({
      listeners,
      count: listeners.length,
      query: q
    });
  } catch (error) {
    console.error('Search listeners error:', error);
    res.status(500).json({ error: 'Failed to search listeners' });
  }
});

// POST /api/listeners/heartbeat
// Update listener last active timestamp
router.post('/heartbeat', authenticate, async (req, res) => {
  try {
    const listener = await Listener.findByUserId(req.userId);

    if (!listener) {
      return res.status(404).json({ error: 'Experts not found' });
    }

    await Listener.updateLastActive(listener.listener_id);

    res.json({ success: true });
  } catch (error) {
    console.error('Heartbeat error:', error);
    res.status(500).json({ error: 'Failed to update heartbeat' });
  }
});

// GET /api/listeners/payout-slabs/public
// Fetch the list of payout slabs for public/verified listener info banner
router.get('/payout-slabs/public', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT start_duration, end_duration, payout_per_minute FROM listener_payout_slabs ORDER BY start_duration ASC'
    );
    res.json({ success: true, slabs: result.rows });
  } catch (error) {
    console.error('Fetch public payout slabs error:', error);
    res.status(500).json({ error: 'Failed to fetch payout slabs' });
  }
});


// GET /api/listeners/stats/leaderboard
// Get the top listeners using persisted backend call and rating data
router.get('/stats/leaderboard', authenticate, async (req, res) => {
  try {
    const requestedPeriod = String(req.query.period || 'weekly').toLowerCase();
    const allowedPeriods = new Set(['weekly', 'monthly', 'overall']);
    const period = allowedPeriods.has(requestedPeriod)
      ? requestedPeriod
      : 'weekly';

    const requestedSortBy = String(req.query.sortBy || 'duration').toLowerCase();
    const allowedSortBy = new Set(['duration', 'rating', 'followers']);
    const sortBy = allowedSortBy.has(requestedSortBy)
      ? requestedSortBy
      : 'duration';

    let callPeriodClause = '';
    let ratingPeriodClause = '';
    let followerPeriodClause = '';

    if (period === 'weekly') {
      callPeriodClause = ` AND c.created_at >= NOW() - INTERVAL '7 days'`;
      ratingPeriodClause = ` AND r.created_at >= NOW() - INTERVAL '7 days'`;
      followerPeriodClause = ` AND created_at >= NOW() - INTERVAL '7 days'`;
    } else if (period === 'monthly') {
      callPeriodClause = ` AND c.created_at >= NOW() - INTERVAL '30 days'`;
      ratingPeriodClause = ` AND r.created_at >= NOW() - INTERVAL '30 days'`;
      followerPeriodClause = ` AND created_at >= NOW() - INTERVAL '30 days'`;
    }

    let orderBySql = '';
    if (sortBy === 'rating') {
      orderBySql = `
        COALESCE(rs.average_rating, l.average_rating, 0) DESC,
        COALESCE(cs.total_minutes, 0) DESC,
        COALESCE(fs.followers_count, 0) DESC,
        l.created_at ASC
      `;
    } else if (sortBy === 'followers') {
      orderBySql = `
        COALESCE(fs.followers_count, 0) DESC,
        COALESCE(rs.average_rating, l.average_rating, 0) DESC,
        COALESCE(cs.total_minutes, 0) DESC,
        l.created_at ASC
      `;
    } else {
      // Default: duration
      orderBySql = `
        COALESCE(cs.total_minutes, 0) DESC,
        COALESCE(rs.average_rating, l.average_rating, 0) DESC,
        COALESCE(cs.total_calls, 0) DESC,
        COALESCE(fs.followers_count, 0) DESC,
        l.created_at ASC
      `;
    }

    const leaderboardQuery = `
      WITH call_stats AS (
        SELECT
          c.listener_id,
          COUNT(*)::int AS total_calls,
          COALESCE(
            SUM(
              COALESCE(
                c.billed_minutes,
                CASE
                  WHEN COALESCE(c.duration_seconds, 0) > 0
                  THEN CEIL(c.duration_seconds / 60.0)
                  ELSE 0
                END
              )
            ),
            0
          )::int AS total_minutes
        FROM calls c
        WHERE c.status = 'completed'
          AND c.listener_id IS NOT NULL
          ${callPeriodClause}
        GROUP BY c.listener_id
      ),
      rating_stats AS (
        SELECT
          r.listener_id,
          ROUND(AVG(r.rating)::numeric, 2) AS average_rating,
          COUNT(*)::int AS total_ratings
        FROM ratings r
        WHERE r.listener_id IS NOT NULL
          ${ratingPeriodClause}
        GROUP BY r.listener_id
      ),
      follower_stats AS (
        SELECT
          listener_user_id,
          COUNT(*)::int AS followers_count
        FROM user_listener_follows
        WHERE 1=1
          ${followerPeriodClause}
        GROUP BY listener_user_id
      ),
      ranked AS (
        SELECT
          l.listener_id,
          l.user_id,
          l.professional_name,
          l.profile_image,
          COALESCE(cs.total_calls, 0) AS total_calls,
          COALESCE(cs.total_minutes, 0) AS total_minutes,
          COALESCE(rs.average_rating, l.average_rating, 0) AS average_rating,
          COALESCE(rs.total_ratings, l.total_ratings, 0) AS total_ratings,
          COALESCE(fs.followers_count, 0) AS followers_count,
          RANK() OVER (
            ORDER BY
              ${orderBySql}
          ) AS rank
        FROM listeners l
        LEFT JOIN call_stats cs ON cs.listener_id = l.listener_id
        LEFT JOIN rating_stats rs ON rs.listener_id = l.listener_id
        LEFT JOIN follower_stats fs ON fs.listener_user_id = l.user_id
        WHERE l.is_active = TRUE
          AND (l.verification_status = 'approved' OR l.is_verified = TRUE)
      )
      SELECT
        listener_id,
        user_id,
        professional_name,
        profile_image,
        total_calls,
        total_minutes,
        average_rating,
        total_ratings,
        followers_count,
        rank
      FROM ranked
      WHERE total_calls > 0 OR total_ratings > 0 OR followers_count > 0
      ORDER BY rank ASC
      LIMIT 10
    `;

    const leaderboardResult = await pool.query(leaderboardQuery);
    const leaderboard = leaderboardResult.rows;

    let myStats = null;
    try {
      const myStatsQuery = `
        WITH call_stats AS (
          SELECT
            c.listener_id,
            COUNT(*)::int AS total_calls,
            COALESCE(
              SUM(
                COALESCE(
                  c.billed_minutes,
                  CASE
                    WHEN COALESCE(c.duration_seconds, 0) > 0
                    THEN CEIL(c.duration_seconds / 60.0)
                    ELSE 0
                  END
                )
              ),
              0
            )::int AS total_minutes
          FROM calls c
          WHERE c.status = 'completed'
            AND c.listener_id IS NOT NULL
            ${callPeriodClause}
          GROUP BY c.listener_id
        ),
        rating_stats AS (
          SELECT
            r.listener_id,
            ROUND(AVG(r.rating)::numeric, 2) AS average_rating,
            COUNT(*)::int AS total_ratings
          FROM ratings r
          WHERE r.listener_id IS NOT NULL
            ${ratingPeriodClause}
          GROUP BY r.listener_id
        ),
        follower_stats AS (
          SELECT
            listener_user_id,
            COUNT(*)::int AS followers_count
          FROM user_listener_follows
          WHERE 1=1
            ${followerPeriodClause}
          GROUP BY listener_user_id
        ),
        ranked AS (
          SELECT
            l.listener_id,
            l.user_id,
            COALESCE(cs.total_calls, 0) AS total_calls,
            COALESCE(cs.total_minutes, 0) AS total_minutes,
            COALESCE(rs.average_rating, l.average_rating, 0) AS average_rating,
            COALESCE(rs.total_ratings, l.total_ratings, 0) AS total_ratings,
            COALESCE(fs.followers_count, 0) AS followers_count,
            RANK() OVER (
              ORDER BY
                ${orderBySql}
            ) AS rank
          FROM listeners l
          LEFT JOIN call_stats cs ON cs.listener_id = l.listener_id
          LEFT JOIN rating_stats rs ON rs.listener_id = l.listener_id
          LEFT JOIN follower_stats fs ON fs.listener_user_id = l.user_id
          WHERE l.is_active = TRUE
            AND (l.verification_status = 'approved' OR l.is_verified = TRUE)
        )
        SELECT rank, total_calls, total_minutes, average_rating, total_ratings, followers_count
        FROM ranked
        WHERE user_id = $1
      `;

      const myStatsResult = await pool.query(myStatsQuery, [req.userId]);
      if (myStatsResult.rows.length > 0) {
        myStats = myStatsResult.rows[0];
      }
    } catch (e) {
      console.error('Error getting leaderboard rank:', e);
    }

    res.json({
      success: true,
      period,
      sortBy,
      leaderboard,
      myStats,
    });
  } catch (error) {
    console.error('Get leaderboard error:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// GET /api/listeners/:listener_id
// Get listener profile
router.get('/:listener_id', async (req, res) => {
  try {
    const listener = await Listener.findById(req.params.listener_id);

    if (!listener) {
      return res.status(404).json({ error: 'Experts not found' });
    }

    // Map DB response to frontend-friendly keys (provide avatar_url alias)
    const responseListener = { ...listener };
    if (listener && listener.profile_image) {
      responseListener.avatar_url = listener.profile_image;
    }

    delete responseListener.listener_payout_per_min;
    delete responseListener.wallet_balance;
    delete responseListener.total_earning;

    // Get listener stats
    const stats = await Listener.getStats(req.params.listener_id);
    if (stats) {
      responseListener.total_calls = Number(stats.total_calls || 0);
      responseListener.total_minutes = Number(stats.total_minutes || 0);
      responseListener.average_rating = Number(stats.average_rating || responseListener.average_rating || 0);
      responseListener.rating = responseListener.average_rating;
    }

    // Get recent ratings
    const ratings = await Rating.getListenerRatings(req.params.listener_id, 5, 0);

    res.json({
      listener: responseListener,
      stats,
      recent_ratings: ratings
    });
  } catch (error) {
    console.error('Get listener error:', error);
    res.status(500).json({ error: 'Failed to fetch Experts' });
  }
});

// POST /api/listeners
// Create listener profile (user becomes a listener)
router.post('/', authenticate, async (req, res) => {
  try {
    console.log('[LISTENERS_ROUTE] Creating listener profile', {
      userId: req.userId,
      payload: summarizeListenerProfilePayload(req.body),
    });

    const {
      professional_name,
      original_name,
      age,
      specialties,
      languages,
      rate_per_minute,
      experience_years,
      education,
      certifications,
      profile_image,
      city
    } = req.body;

    // Validate required fields
    if (!professional_name || !specialties || !languages) {
      return res.status(400).json({
        error: 'Professional name, specialties, and languages are required'
      });
    }

    // Validate rate if provided (rates are admin-controlled)
    const rateValue = rate_per_minute !== undefined && rate_per_minute !== null
      ? parseFloat(rate_per_minute)
      : null;
    if (rateValue !== null && (isNaN(rateValue) || rateValue <= 0)) {
      return res.status(400).json({
        error: 'Rate per minute must be a valid positive number'
      });
    }

    // Check if user already has a listener profile
    const existingListener = await Listener.findByUserId(req.userId);
    console.log('Existing Experts found:', existingListener ? existingListener.listener_id : 'none');

    let listener;
    if (existingListener) {
      // Update existing listener profile instead of rejecting
      console.log('Updating existing Experts profile:', existingListener.listener_id);
      listener = await Listener.update(existingListener.listener_id, {
        original_name,
        professional_name,
        age: age ? parseInt(age) : undefined,
        specialties: Array.isArray(specialties) ? specialties : [specialties],
        languages: Array.isArray(languages) ? languages : [languages],
        experience_years: experience_years ? parseInt(experience_years) : undefined,
        education,
        certifications: Array.isArray(certifications) ? certifications : [],
        profile_image
      });
    } else {
      // Create new listener profile.
      // Rates are admin-controlled: ignore client rate and resolve from admin rules/global config.
      listener = await Listener.create({
        user_id: req.userId,
        original_name,
        professional_name,
        age: age ? parseInt(age) : undefined,
        specialties: Array.isArray(specialties) ? specialties : [specialties],
        languages: Array.isArray(languages) ? languages : [languages],
        rate_per_minute: 0,
        experience_years: experience_years ? parseInt(experience_years) : undefined,
        education,
        certifications: Array.isArray(certifications) ? certifications : [],
        profile_image
      });

      // Update user account type
      await pool.query(
        "UPDATE users SET account_type = 'listener' WHERE user_id = $1",
        [req.userId]
      );
    }

    console.log('Listener profile saved successfully:', listener.listener_id);

    // Update user city if provided
    if (city) {
      await pool.query(
        "UPDATE users SET city = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2",
        [city, req.userId]
      );
      console.log('User city updated to:', city);
    }

    res.status(201).json({
      message: 'Listener profile created successfully',
      listener
    });
  } catch (error) {
    console.error('Create listener error:', error);
    console.error('Error details:', {
      message: error.message,
      detail: error.detail,
      code: error.code,
      constraint: error.constraint
    });

    // Return more specific error messages
    if (error.code === '23505') { // Unique constraint violation
      return res.status(400).json({
        error: 'A listener profile already exists for this user'
      });
    }

    if (error.code === '23503') { // Foreign key constraint
      return res.status(400).json({
        error: 'Invalid user reference'
      });
    }

    res.status(500).json({
      error: error.message || 'Failed to create listener profile',
      details: process.env.NODE_ENV === 'development' ? error.detail : undefined
    });
  }
});

// PUT /api/listeners/:listener_id
// Update listener profile
router.put('/:listener_id', authenticate, async (req, res) => {
  try {
    const ownershipResult = await pool.query(
      'SELECT user_id FROM listeners WHERE listener_id = $1 LIMIT 1',
      [req.params.listener_id]
    );
    const listenerOwnerId = ownershipResult.rows[0]?.user_id;

    if (!listenerOwnerId) {
      return res.status(404).json({ error: 'Listener profile not found. Please complete profile setup first (POST /api/listeners).' });
    }

    if (listenerOwnerId !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const incoming = { ...req.body };

    if (incoming.avatar_url && !incoming.profile_image) {
      incoming.profile_image = incoming.avatar_url;
      delete incoming.avatar_url;
    }

    // Get current profile image to check if it needs to be deleted
    const currentProfileResult = await pool.query(
      'SELECT profile_image FROM listeners WHERE listener_id = $1 LIMIT 1',
      [req.params.listener_id]
    );
    const oldImageUrl = currentProfileResult.rows[0]?.profile_image;

    if (incoming.profile_image !== undefined && incoming.profile_image !== oldImageUrl) {
      if (oldImageUrl) {
        try {
          await deleteFromMinioByUrl(oldImageUrl);
          console.log(`[UPDATE_PROFILE] Old avatar deleted from Cloudflare: ${oldImageUrl}`);
        } catch (deleteError) {
          console.error(`[UPDATE_PROFILE] Failed to delete old avatar: ${oldImageUrl}`, deleteError);
        }
      }
    }

    ['specialties', 'languages', 'certifications'].forEach(field => {
      if (incoming[field] && typeof incoming[field] === 'string') {
        incoming[field] = incoming[field]
          .split(',')
          .map(s => s.trim())
          .filter(Boolean);
      }
    });

    const listenerUpdates = { ...incoming };
    const userUpdates = {};

    if (typeof incoming.city === 'string' && incoming.city.trim() !== '') {
      userUpdates.city = incoming.city.trim();
      delete listenerUpdates.city;
    }

    if (Object.keys(listenerUpdates).length === 0 && Object.keys(userUpdates).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided for update' });
    }

    let updatedListener = null;
    if (Object.keys(listenerUpdates).length > 0) {
      updatedListener = await Listener.update(req.params.listener_id, listenerUpdates);
    } else {
      updatedListener = await Listener.findById(req.params.listener_id);
    }

    if (Object.keys(userUpdates).length > 0) {
      await User.update(listenerOwnerId, userUpdates);
    }

    const responseListener = { ...updatedListener };
    if (updatedListener && updatedListener.profile_image) {
      responseListener.avatar_url = updatedListener.profile_image;
    }
    responseListener.city = userUpdates.city ?? req.user?.city ?? responseListener.city;
    responseListener.country = req.user?.country ?? responseListener.country;

    delete responseListener.listener_payout_per_min;
    delete responseListener.wallet_balance;
    delete responseListener.total_earning;

    res.json({
      message: 'Listener profile updated successfully',
      listener: responseListener
    });
  } catch (error) {
    // Detailed error logging to assist debugging
    console.error('Update listener error:', {
      message: error.message,
      detail: error.detail,
      code: error.code,
      constraint: error.constraint,
      requestBody: req.body
    });

    res.status(500).json({
      error: 'Failed to update listener profile',
      details: process.env.NODE_ENV === 'development' ? {
        message: error.message,
        detail: error.detail,
        code: error.code,
        constraint: error.constraint
      } : undefined
    });
  }
});

// DELETE /api/listeners/:listener_id
// Delete listener and all related data including user account (admin only)
router.delete('/:listener_id', authenticateAdmin, async (req, res) => {
  try {
    const listener = await Listener.findById(req.params.listener_id);
    if (!listener) {
      return res.status(404).json({ error: 'Listener not found' });
    }

    const deleted = await Listener.delete(req.params.listener_id);
    if (!deleted) {
      return res.status(404).json({ error: 'Listener not found' });
    }

    res.json({ message: 'Listener and all associated data deleted successfully' });
  } catch (error) {
    console.error('Delete listener error:', error);
    res.status(500).json({ error: 'Failed to delete listener' });
  }
});

// PUT /api/listeners/:listener_id/status
// Update availability status (not online status, which is automatic)
router.put('/:listener_id/status', authenticate, async (req, res) => {
  try {
    const { is_available } = req.body;

    if (is_available === undefined) {
      return res.status(400).json({ error: 'is_available status is required' });
    }

    // Verify listener belongs to user
    const listener = await Listener.findById(req.params.listener_id);
    if (!listener) {
      return res.status(404).json({ error: 'Listener not found' });
    }
    if (listener.user_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Update only is_available, not is_online
    await Listener.update(req.params.listener_id, { is_available });

    res.json({
      message: 'Availability updated successfully'
    });
  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({ error: 'Failed to update availability' });
  }
});

// GET /api/listeners/:listener_id/ratings
// Get listener ratings and reviews
router.get('/:listener_id/ratings', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit) : 20;
    const offset = req.query.offset ? parseInt(req.query.offset) : 0;

    const ratings = await Rating.getListenerRatings(
      req.params.listener_id,
      limit,
      offset
    );

    const averageData = await Rating.getListenerAverageRating(req.params.listener_id);

    res.json({
      ratings,
      count: ratings.length,
      average_rating: parseFloat(averageData.average_rating),
      total_ratings: parseInt(averageData.total_ratings)
    });
  } catch (error) {
    console.error('Get ratings error:', error);
    res.status(500).json({ error: 'Failed to fetch ratings' });
  }
});

// GET /api/listeners/:listener_id/stats
// Get listener statistics
router.get('/:listener_id/stats', async (req, res) => {
  try {
    const stats = await Listener.getStats(req.params.listener_id);

    res.json({ stats });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// POST /api/listeners/:listener_id/availability
// Set listener availability schedule
router.post('/:listener_id/availability', authenticate, async (req, res) => {
  try {
    const { day_of_week, start_time, end_time, is_available } = req.body;

    if (day_of_week === undefined || !start_time || !end_time) {
      return res.status(400).json({
        error: 'day_of_week, start_time, and end_time are required'
      });
    }

    // Verify listener belongs to user
    const listener = await Listener.findById(req.params.listener_id);
    if (!listener) {
      return res.status(404).json({ error: 'Listener not found' });
    }
    if (listener.user_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const query = `
      INSERT INTO listener_availability
        (listener_id, day_of_week, start_time, end_time, is_available)
      VALUES($1, $2, $3, $4, $5)
      RETURNING *
        `;

    const result = await pool.query(query, [
      req.params.listener_id,
      day_of_week,
      start_time,
      end_time,
      is_available !== false
    ]);

    res.json({
      message: 'Availability schedule added',
      availability: result.rows[0]
    });
  } catch (error) {
    console.error('Add availability error:', error);
    res.status(500).json({ error: 'Failed to add availability' });
  }
});

// GET /api/listeners/:listener_id/availability
// Get listener availability schedule
router.get('/:listener_id/availability', async (req, res) => {
  try {
    const query = `
      SELECT * FROM listener_availability
      WHERE listener_id = $1
      ORDER BY day_of_week, start_time
        `;
    const result = await pool.query(query, [req.params.listener_id]);

    res.json({ availability: result.rows });
  } catch (error) {
    console.error('Get availability error:', error);
    res.status(500).json({ error: 'Failed to fetch availability' });
  }
});

// GET /api/listeners/me/profile
// Get current user's listener profile
router.get('/me/profile', authenticate, async (req, res) => {
  try {
    const listener = await Listener.findByUserId(req.userId);

    if (!listener) {
      return res.status(404).json({ error: 'Listener profile not found' });
    }

    // Map DB response to frontend-friendly keys (provide avatar_url alias)
    const responseListener = { ...listener };
    if (listener && listener.profile_image) {
      responseListener.avatar_url = listener.profile_image;
    }

    const stats = await Listener.getStats(listener.listener_id);
    if (stats) {
      responseListener.total_calls = Number(stats.total_calls || 0);
      responseListener.total_minutes = Number(stats.total_minutes || 0);
      responseListener.average_rating = Number(stats.average_rating || responseListener.average_rating || 0);
      responseListener.rating = responseListener.average_rating;
    }

    res.json({
      listener: responseListener,
      stats
    });
  } catch (error) {
    console.error('Get my profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});
// POST /api/listeners/me/reapply
// Reapply for verification after rejection (max 3 attempts)
router.post('/me/reapply', authenticate, async (req, res) => {
  try {
    const listener = await Listener.findByUserId(req.userId);

    if (!listener) {
      return res.status(404).json({ error: 'Listener profile not found' });
    }

    const result = await Listener.reapplyForVerification(listener.listener_id);

    console.log(`[LISTENER] Listener ${listener.listener_id} reapplied for verification(attempt ${result.reapply_attempts})`);

    res.json({
      message: 'Reapplication submitted successfully. Your profile will be reviewed again.',
      listener: {
        listener_id: result.listener_id,
        verification_status: result.verification_status,
        reapply_attempts: result.reapply_attempts
      }
    });
  } catch (error) {
    console.error('Reapply for verification error:', error);

    // Return specific error messages
    if (error.message.includes('Can only reapply')) {
      return res.status(400).json({ error: error.message });
    }
    if (error.message.includes('Maximum reapply')) {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: 'Failed to submit reapplication' });
  }
});

// PUT /api/listeners/me/payment-details
// Update payment details for current listener
router.put('/me/payment-details', authenticate, async (req, res) => {
  try {
    console.log('[LISTENERS_ROUTE] Updating payment details', {
      userId: req.userId,
      payload: summarizePaymentPayload(req.body),
    });

    // Get listener for current user
    const listener = await Listener.findByUserId(req.userId);
    if (!listener) {
      return res.status(404).json({ error: 'Listener profile not found' });
    }

    const {
      payment_method,
      mobile_number,
      upi_id,
      aadhaar_number,
      pan_number,
      name_as_per_pan,
      account_number,
      ifsc_code,
      bank_name,
      account_holder_name,
      pan_aadhaar_bank
    } = req.body;

    if (!payment_method || !['upi', 'bank', 'both'].includes(payment_method)) {
      return res.status(400).json({ error: 'Valid payment_method (upi/bank/both) is required' });
    }

    // Validate payment method fields
    if (payment_method === 'upi' || payment_method === 'both') {
      if (!upi_id) {
        return res.status(400).json({
          error: 'UPI method requires: upi_id'
        });
      }
    }

    if (payment_method === 'bank' || payment_method === 'both') {
      if (!account_number || !ifsc_code || !account_holder_name) {
        return res.status(400).json({
          error: 'Bank method requires: account_number, ifsc_code, account_holder_name'
        });
      }
    }

    // Try to create the table if it doesn't exist (for Vercel compatibility)
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS listener_payment_details(
          payment_detail_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          listener_id UUID UNIQUE REFERENCES listeners(listener_id) ON DELETE CASCADE,
          payment_method VARCHAR(20) CHECK(payment_method IN('upi', 'bank', 'both')),
          mobile_number VARCHAR(15),
          upi_id VARCHAR(255),
          aadhaar_number VARCHAR(12),
          pan_number VARCHAR(10),
          name_as_per_pan VARCHAR(100),
          account_number VARCHAR(20),
          ifsc_code VARCHAR(11),
          bank_name VARCHAR(100),
          account_holder_name VARCHAR(100),
          pan_aadhaar_bank VARCHAR(20),
          is_verified BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        `);
    } catch (tableError) {
      console.log('Table already exists or error creating table:', tableError.message);
    }

    const query = `
      INSERT INTO listener_payment_details(
          listener_id, payment_method, mobile_number, upi_id, aadhaar_number, pan_number,
          name_as_per_pan, account_number, ifsc_code, bank_name,
          account_holder_name, pan_aadhaar_bank
        )
      VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT(listener_id) DO UPDATE SET
      payment_method = $2, mobile_number = $3, upi_id = $4, aadhaar_number = $5, pan_number = $6,
        name_as_per_pan = $7, account_number = $8, ifsc_code = $9, bank_name = $10,
        account_holder_name = $11, pan_aadhaar_bank = $12, updated_at = CURRENT_TIMESTAMP
      RETURNING *
        `;

    const result = await pool.query(query, [
      listener.listener_id, payment_method, mobile_number || null, upi_id || null, aadhaar_number || null, pan_number || null,
      name_as_per_pan || null, account_number || null, ifsc_code || null, bank_name || null, account_holder_name || null, pan_aadhaar_bank || null
    ]);

    console.log('Payment details updated successfully for listener:', listener.listener_id);

    res.json({
      message: 'Payment details updated successfully',
      payment_details: result.rows[0]
    });
  } catch (error) {
    console.error('Update payment details error:', error);
    console.error('Error details:', {
      message: error.message,
      detail: error.detail,
      code: error.code,
      constraint: error.constraint,
      payload: summarizePaymentPayload(req.body)
    });

    res.status(500).json({
      error: error.message || 'Failed to update payment details',
      details: process.env.NODE_ENV === 'development' ? error.detail : undefined
    });
  }
});

// PUT /api/listeners/:listener_id/experiences
// Update listener experiences
router.put('/:listener_id/experiences', authenticate, async (req, res) => {
  try {
    console.log('Update experiences request body:', req.body);
    let { experiences, yearsOfExperience, expertise } = req.body;

    // Accept both array and string for experiences
    if (typeof experiences === 'string') {
      experiences = experiences.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(experiences)) {
      return res.status(400).json({ error: 'Experiences must be an array or comma-separated string' });
    }

    // Verify listener belongs to user
    const listener = await Listener.findById(req.params.listener_id);
    if (!listener) {
      return res.status(404).json({ error: 'Listener not found' });
    }
    if (listener.user_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Update experiences array
    const result = await Listener.updateExperiences(req.params.listener_id, experiences);

    // Optionally update yearsOfExperience and expertise if present
    const updateFields = {};
    if (yearsOfExperience !== undefined) {
      updateFields.experience_years = parseInt(yearsOfExperience) || 0;
    }
    if (expertise !== undefined) {
      updateFields.specialties = Array.isArray(expertise)
        ? expertise
        : (typeof expertise === 'string' ? expertise.split(',').map(s => s.trim()).filter(Boolean) : undefined);
    }
    if (Object.keys(updateFields).length > 0) {
      await Listener.update(req.params.listener_id, updateFields);
    }

    res.json({
      message: 'Experiences updated successfully',
      experiences: result.experiences
    });
  } catch (error) {
    console.error('Update experiences error:', error);
    res.status(500).json({ error: 'Failed to update experiences' });
  }
});

// POST /api/listeners/upload-voice
// Upload voice recording to Cloudflare R2 (returns secure_url)
router.post('/upload-voice', authenticate, voiceUpload.single('voiceFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'No audio file provided. Send as multipart field "voiceFile".',
        code: 'VOICE_FILE_MISSING',
      });
    }

    console.log('[UPLOAD_VOICE] Incoming request', {
      userId: req.userId,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      fieldName: req.file.fieldname,
    });

    // Upload buffer to Cloudflare R2
    const result = await uploadToMinio(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      'voice_verifications'
    );

    console.log('[UPLOAD_VOICE] R2 upload success', {
      userId: req.userId,
      secureUrl: result.secure_url,
      publicId: result.public_id,
      format: result.format,
    });

    res.json({
      message: 'Voice uploaded successfully',
      secure_url: result.secure_url,
      public_id: result.public_id,
      duration: result.duration,
      format: result.format,
    });
  } catch (error) {
    console.error('[UPLOAD_VOICE] Error', {
      userId: req.userId,
      message: error.message,
      code: error.code || error.Code || 'VOICE_UPLOAD_FAILED',
      statusCode: error.statusCode || error?.$metadata?.httpStatusCode || 500,
    });
    res.status(error.statusCode || 500).json({
      error: error.message || 'Failed to upload voice to Cloudflare R2',
      code: error.code || error.Code || 'VOICE_UPLOAD_FAILED',
    });
  }
});

// POST /api/listeners/upload-avatar
// Upload avatar image to Cloudflare R2 and update listener profile (returns secure_url)
router.post('/upload-avatar', authenticate, (req, res, next) => {
  avatarUpload.single('avatarFile')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Image size must be less than 2 MB' });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  let oldImageUrl = null;
  let isOldDeleted = false;

  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'No image file provided. Send as multipart field "avatarFile".',
        code: 'AVATAR_FILE_MISSING',
      });
    }

    console.log('[UPLOAD_AVATAR] Incoming request', {
      userId: req.userId,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
    });

    // 1. Fetch the listener to get the old profile image URL
    const getQuery = `
      SELECT profile_image
      FROM listeners
      WHERE user_id = $1
    `;
    const getResult = await pool.query(getQuery, [req.userId]);

    if (getResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listener profile not found' });
    }

    oldImageUrl = getResult.rows[0].profile_image;

    // 2. Delete the old image from Cloudflare FIRST
    if (oldImageUrl) {
      try {
        await deleteFromMinioByUrl(oldImageUrl);
        console.log(`[UPLOAD_AVATAR] Old avatar deleted successfully: ${oldImageUrl}`);
        isOldDeleted = true;
      } catch (deleteError) {
        console.error(`[UPLOAD_AVATAR] Failed to delete old avatar: ${oldImageUrl}`, deleteError);
        // Continue anyway so the user can still update their avatar
      }
    }

    // 3. Upload the new buffer to Cloudflare R2
    let result;
    try {
      result = await uploadToMinio(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
        'avatars'
      );
      console.log('[UPLOAD_AVATAR] R2 upload success', {
        userId: req.userId,
        secureUrl: result.secure_url,
        publicId: result.public_id,
      });
    } catch (uploadError) {
      // If upload fails but we already deleted the old image, clear it in DB
      if (isOldDeleted) {
        const clearQuery = `
          UPDATE listeners
          SET profile_image = NULL
          WHERE user_id = $1
        `;
        await pool.query(clearQuery, [req.userId]);
        console.log('[UPLOAD_AVATAR] Cleared broken old image link in database due to upload failure.');
      }
      throw uploadError; // rethrow to be caught by outer catch
    }

    // 4. Save the new URL to the listeners table
    const updateQuery = `
      UPDATE listeners
      SET profile_image = $1
      WHERE user_id = $2
      RETURNING profile_image
    `;
    await pool.query(updateQuery, [result.secure_url, req.userId]);

    res.json({
      message: 'Avatar uploaded successfully',
      secure_url: result.secure_url,
      public_id: result.public_id,
      format: result.format,
    });
  } catch (error) {
    console.error('[UPLOAD_AVATAR] Error', {
      userId: req.userId,
      message: error.message,
      code: error.code || error.Code || 'AVATAR_UPLOAD_FAILED',
    });
    // Check if error is from multer limits
    if (error.message && error.message.includes('large')) {
      return res.status(413).json({
        error: 'Image size must be less than 2 MB',
        code: 'FILE_TOO_LARGE',
      });
    }
    res.status(error.statusCode || 500).json({
      error: error.message || 'Failed to upload avatar to Cloudflare R2',
      code: error.code || error.Code || 'AVATAR_UPLOAD_FAILED',
    });
  }
});

// GET /api/listeners/me/withdrawal-meta
router.get('/me/withdrawal-meta', authenticate, async (req, res) => {
  try {
    const listener = await Listener.findByUserId(req.userId);
    if (!listener) {
      return res.status(404).json({ error: 'Listener profile not found' });
    }

    const paymentInfo = listener.payment_info || {};
    const payoutMethods = {
      upi: {
        available: Boolean(paymentInfo.upi_id),
        upi_id: paymentInfo.upi_id || null,
        account_holder_name: paymentInfo.account_holder_name || null,
      },
      bank: {
        available: Boolean(
          paymentInfo.account_number &&
          paymentInfo.ifsc_code &&
          paymentInfo.account_holder_name
        ),
        account_number: paymentInfo.account_number || null,
        ifsc_code: paymentInfo.ifsc_code || null,
        bank_name: paymentInfo.bank_name || null,
        account_holder_name: paymentInfo.account_holder_name || null,
      },
    };

    const transactionFee = await getWithdrawalTransactionFee();
    const availableBalance = await getListenerWithdrawableBalance(listener);

    return res.json({
      listenerId: listener.listener_id,
      availableBalance,
      transactionFee,
      currentUserRatePerMinute: Number(
        listener.user_rate_per_min || listener.rate_per_minute || 0
      ),
      currentPayoutRatePerMinute: Number(
        listener.listener_payout_per_min || 0
      ),
      payoutMethods,
    });
  } catch (error) {
    console.error('Get withdrawal meta error:', error);
    return res.status(500).json({ error: 'Failed to fetch withdrawal details' });
  }
});

// GET /api/listeners/me/withdrawals/summary
router.get('/me/withdrawals/summary', authenticate, async (req, res) => {
  try {
    const listener = await Listener.findByUserId(req.userId);
    if (!listener) {
      return res.status(404).json({ error: 'Listener profile not found' });
    }

    await ensureWithdrawalRequestsTable();
    const summaryResult = await pool.query(
      `SELECT
         COALESCE(SUM(withdrawal_amount), 0)::numeric AS total_withdrawn_amount,
         COALESCE(SUM(final_credit_amount), 0)::numeric AS total_credit_amount,
         COUNT(*)::int AS requests_count
       FROM listener_withdrawal_requests
       WHERE listener_id = $1
         AND status <> ALL($2::text[])`,
      [listener.listener_id, NON_EFFECTIVE_WITHDRAWAL_STATUSES]
    );

    const row = summaryResult.rows[0] || {};
    return res.json({
      listenerId: listener.listener_id,
      totalWithdrawnAmount: Number(row.total_withdrawn_amount || 0),
      totalCreditAmount: Number(row.total_credit_amount || 0),
      requestsCount: Number(row.requests_count || 0),
    });
  } catch (error) {
    console.error('Get withdrawal summary error:', error);
    return res.status(500).json({ error: 'Failed to fetch withdrawal summary' });
  }
});

// GET /api/listeners/me/gift-earnings/summary
router.get('/me/gift-earnings/summary', authenticate, async (req, res) => {
  try {
    const listener = await Listener.findByUserId(req.userId);
    if (!listener) {
      return res.status(404).json({ error: 'Listener profile not found' });
    }

    // Call Earnings (standard call earnings)
    const callEarningsResult = await pool.query(
      `SELECT COALESCE(SUM(cr.listener_earn), 0)::numeric AS total_call_earnings
       FROM call_records cr
       WHERE cr.listener_id = $1`,
      [listener.listener_id]
    );
    const totalCallEarnings = Number(callEarningsResult.rows[0]?.total_call_earnings || 0);

    // Gift Wallet (Available Balance, Pending Balance, etc.)
    const giftWalletResult = await pool.query(
      `SELECT total_earnings, available_balance, pending_withdrawals, total_withdrawn
       FROM listener_gift_wallets
       WHERE listener_id = $1`,
      [listener.listener_id]
    );

    let totalGiftEarnings = 0;
    let availableGiftBalance = 0;
    let pendingGiftBalance = 0;
    let totalWithdrawnGifts = 0;

    if (giftWalletResult.rows.length > 0) {
      const w = giftWalletResult.rows[0];
      totalGiftEarnings = Number(w.total_earnings);
      availableGiftBalance = Number(w.available_balance);
      pendingGiftBalance = Number(w.pending_withdrawals);
      totalWithdrawnGifts = Number(w.total_withdrawn);
    }

    // Gift revenue (gross sum coin_amount of all gifts sent to them)
    const giftRevenueResult = await pool.query(
      `SELECT COALESCE(SUM(coin_amount), 0)::numeric AS total_gift_revenue
       FROM call_gifts
       WHERE listener_id = $1`,
      [listener.listener_id]
    );
    const totalGiftRevenue = Number(giftRevenueResult.rows[0]?.total_gift_revenue || 0);

    // Top Gift Received
    const topGiftResult = await pool.query(
      `SELECT gift_name, COUNT(*)::int AS count
       FROM call_gifts
       WHERE listener_id = $1
       GROUP BY gift_name
       ORDER BY count DESC, gift_name ASC
       LIMIT 1`,
      [listener.listener_id]
    );
    const topGiftReceived = topGiftResult.rows[0]?.gift_name || null;

    // Monthly Gift Earnings (grouped by year-month)
    const monthlyResult = await pool.query(
      `SELECT TO_CHAR(created_at, 'YYYY-MM') AS month,
              COALESCE(SUM(listener_earning), 0)::numeric AS earnings
       FROM call_gifts
       WHERE listener_id = $1
       GROUP BY TO_CHAR(created_at, 'YYYY-MM')
       ORDER BY month DESC
       LIMIT 6`,
      [listener.listener_id]
    );
    const monthlyGiftEarnings = monthlyResult.rows.map(r => ({
      month: r.month,
      earnings: Number(r.earnings)
    })).reverse();

    // Total count of gifts received
    const totalGiftsCountResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM call_gifts WHERE listener_id = $1`,
      [listener.listener_id]
    );
    const totalGiftsReceived = totalGiftsCountResult.rows[0]?.count || 0;

    return res.json({
      success: true,
      totalCallEarnings,
      totalGiftEarnings,
      availableGiftBalance,
      pendingGiftBalance,
      totalGiftRevenue,
      totalWithdrawnGifts,
      topGiftReceived,
      totalGiftsReceived,
      monthlyGiftEarnings
    });
  } catch (error) {
    console.error('Get gift earnings summary error:', error);
    return res.status(500).json({ error: 'Failed to fetch gift earnings summary' });
  }
});

// GET /api/listeners/me/gift-earnings/history
router.get('/me/gift-earnings/history', authenticate, async (req, res) => {
  try {
    const listener = await Listener.findByUserId(req.userId);
    if (!listener) {
      return res.status(404).json({ error: 'Listener profile not found' });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const result = await pool.query(
      `SELECT sender_display_name AS sender_name,
              gift_name,
              coin_amount AS gift_amount,
              listener_share_percent,
              listener_earning,
              created_at,
              asset_key
       FROM call_gifts
       WHERE listener_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [listener.listener_id, limit, offset]
    );

    return res.json({
      success: true,
      history: result.rows.map(r => ({
        senderName: r.sender_name || 'User',
        giftName: r.gift_name,
        giftAmount: Number(r.gift_amount),
        listenerSharePercent: Number(r.listener_share_percent),
        listenerEarning: Number(r.listener_earning),
        createdAt: r.created_at,
        assetKey: r.asset_key
      }))
    });
  } catch (error) {
    console.error('Get gift earnings history error:', error);
    return res.status(500).json({ error: 'Failed to fetch gift earnings history' });
  }
});

// GET /api/listeners/me/gift-withdrawals/history
router.get('/me/gift-withdrawals/history', authenticate, async (req, res) => {
  try {
    const listener = await Listener.findByUserId(req.userId);
    if (!listener) {
      return res.status(404).json({ error: 'Listener profile not found' });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);

    const result = await pool.query(
      `SELECT request_id, amount, status, remarks, created_at, updated_at
       FROM listener_gift_withdrawal_requests
       WHERE listener_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [listener.listener_id, limit]
    );

    return res.json({
      success: true,
      withdrawals: result.rows.map(r => ({
        requestId: r.request_id,
        amount: Number(r.amount),
        status: r.status,
        remarks: r.remarks,
        createdAt: r.created_at,
        updatedAt: r.updated_at
      }))
    });
  } catch (error) {
    console.error('Get gift withdrawals history error:', error);
    return res.status(500).json({ error: 'Failed to fetch gift withdrawals history' });
  }
});

// POST /api/listeners/me/gift-withdrawals
router.post('/me/gift-withdrawals', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    const listener = await Listener.findByUserId(req.userId);
    if (!listener) {
      return res.status(404).json({ error: 'Listener profile not found' });
    }

    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Withdrawal amount must be greater than 0' });
    }

    await client.query('BEGIN');

    // Ensure listener gift wallet exists
    await client.query(
      `INSERT INTO listener_gift_wallets (listener_id, total_earnings, available_balance, pending_withdrawals, total_withdrawn)
       VALUES ($1, 0.0, 0.0, 0.0, 0.0)
       ON CONFLICT (listener_id) DO NOTHING`,
      [listener.listener_id]
    );

    // Lock listener gift wallet for update
    const walletResult = await client.query(
      `SELECT available_balance
       FROM listener_gift_wallets
       WHERE listener_id = $1
       FOR UPDATE`,
      [listener.listener_id]
    );

    const availableBalance = Number(walletResult.rows[0]?.available_balance || 0);
    if (amount > availableBalance) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Withdrawal amount exceeds available balance' });
    }

    // Deduct available, credit pending
    await client.query(
      `UPDATE listener_gift_wallets
       SET available_balance = available_balance - $2,
           pending_withdrawals = pending_withdrawals + $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE listener_id = $1`,
      [listener.listener_id, amount]
    );

    // Insert withdrawal request
    const requestResult = await client.query(
      `INSERT INTO listener_gift_withdrawal_requests (listener_id, amount, status)
       VALUES ($1, $2, 'pending')
       RETURNING request_id, amount, status, created_at`,
      [listener.listener_id, amount]
    );

    // Record transaction entry
    await client.query(
      `INSERT INTO transactions (user_id, transaction_type, amount, currency, description, status)
       VALUES ($1, 'withdrawal', $2, 'INR', 'Gift Earnings Payout Request', 'pending')`,
      [req.userId, amount]
    );

    await client.query('COMMIT');

    return res.json({
      success: true,
      message: 'Gift earnings withdrawal request submitted successfully',
      request: {
        requestId: requestResult.rows[0].request_id,
        amount: Number(requestResult.rows[0].amount),
        status: requestResult.rows[0].status,
        createdAt: requestResult.rows[0].created_at
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Request gift withdrawal error:', error);
    return res.status(500).json({ error: 'Failed to request withdrawal' });
  } finally {
    client.release();
  }
});

// GET /api/listeners/me/withdrawals
router.get('/me/withdrawals', authenticate, async (req, res) => {
  try {
    const listener = await Listener.findByUserId(req.userId);
    if (!listener) {
      return res.status(404).json({ error: 'Listener profile not found' });
    }

    await ensureWithdrawalRequestsTable();

    const parsedLimit = Number.parseInt(String(req.query.limit || '100'), 10);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 500)
      : 100;

    const historyResult = await pool.query(
      `SELECT
         request_id,
         listener_id,
         payout_method,
         upi_id,
         account_number,
         ifsc_code,
         bank_name,
         account_holder_name,
         withdrawal_amount,
         tds_amount,
         transaction_fee,
         final_credit_amount,
         status,
         created_at,
         updated_at
       FROM listener_withdrawal_requests
       WHERE listener_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [listener.listener_id, limit]
    );

    const withdrawals = historyResult.rows.map((row) => ({
      request_id: row.request_id,
      listener_id: row.listener_id,
      payout_method: row.payout_method,
      upi_id: row.upi_id,
      account_number: row.account_number,
      ifsc_code: row.ifsc_code,
      bank_name: row.bank_name,
      account_holder_name: row.account_holder_name,
      withdrawal_amount: Number(row.withdrawal_amount || 0),
      tds_amount: Number(row.tds_amount || 0),
      transaction_fee: Number(row.transaction_fee || 0),
      final_credit_amount: Number(row.final_credit_amount || 0),
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));

    return res.json({
      listenerId: listener.listener_id,
      withdrawals,
    });
  } catch (error) {
    console.error('Get withdrawal history error:', error);
    return res.status(500).json({ error: 'Failed to fetch withdrawal history' });
  }
});

// POST /api/listeners/me/withdrawals
router.post('/me/withdrawals', authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    const listener = await Listener.findByUserId(req.userId);
    if (!listener) {
      return res.status(404).json({ error: 'Listener profile not found' });
    }

    const { payout_method, withdrawal_amount } = req.body || {};
    const method = String(payout_method || '').trim().toLowerCase();
    const withdrawalAmount = Number(withdrawal_amount);

    if (!['upi', 'bank'].includes(method)) {
      return res.status(400).json({ error: 'Please select a valid payout method' });
    }
    if (!Number.isFinite(withdrawalAmount) || withdrawalAmount <= 0) {
      return res.status(400).json({ error: 'Withdrawal amount must be greater than 0' });
    }

    const paymentInfo = listener.payment_info || {};
    if (method === 'upi' && !paymentInfo.upi_id) {
      return res.status(400).json({ error: 'No UPI ID found. Please add payout details first.' });
    }
    if (
      method === 'bank' &&
      !(paymentInfo.account_number && paymentInfo.ifsc_code && paymentInfo.account_holder_name)
    ) {
      return res.status(400).json({ error: 'No bank details found. Please add payout details first.' });
    }

    const transactionFee = await getWithdrawalTransactionFee();
    const tdsAmount = Number((withdrawalAmount * 0.01).toFixed(2));
    const finalCreditAmount = Number((withdrawalAmount - tdsAmount - transactionFee).toFixed(2));

    if (finalCreditAmount < 0) {
      return res.status(400).json({ error: 'Withdrawal amount is too low after deductions' });
    }

    await client.query('BEGIN');
    await ensureWithdrawalRequestsTable(client);

    const lockedListenerResult = await client.query(
      `SELECT listener_id, total_earning, wallet_balance
       FROM listeners
       WHERE listener_id = $1
       FOR UPDATE`,
      [listener.listener_id]
    );
    if (lockedListenerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Listener profile not found' });
    }

    const lockedListener = {
      ...listener,
      ...lockedListenerResult.rows[0],
    };
    const availableBalance = await getListenerWithdrawableBalance(
      lockedListener,
      client,
    );
    if (withdrawalAmount > availableBalance) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Withdrawal amount exceeds available balance' });
    }

    const requestId = randomUUID();
    const insertResult = await client.query(
      `INSERT INTO listener_withdrawal_requests(
        request_id, listener_id, payout_method, upi_id, account_number, ifsc_code, bank_name, account_holder_name,
        withdrawal_amount, tds_amount, transaction_fee, final_credit_amount, status
      )
      VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')
      RETURNING request_id, listener_id, payout_method, upi_id, account_number, ifsc_code,
                bank_name, account_holder_name, withdrawal_amount, tds_amount,
                transaction_fee, final_credit_amount, status, created_at`,
      [
        requestId,
        listener.listener_id,
        method,
        method === 'upi' ? paymentInfo.upi_id : null,
        method === 'bank' ? paymentInfo.account_number : null,
        method === 'bank' ? paymentInfo.ifsc_code : null,
        method === 'bank' ? paymentInfo.bank_name : null,
        paymentInfo.account_holder_name || null,
        withdrawalAmount.toFixed(2),
        tdsAmount.toFixed(2),
        transactionFee.toFixed(2),
        finalCreditAmount.toFixed(2),
      ]
    );

    await client.query('COMMIT');

    return res.status(201).json({
      message: 'Withdrawal request submitted successfully',
      withdrawal: insertResult.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Create withdrawal request error:', error);
    const errorText = String(error?.message || '').toLowerCase();
    const canUseDummyFallback =
      errorText.includes('listener_withdrawal_requests') ||
      errorText.includes('uuid_generate_v4') ||
      errorText.includes('relation');

    if (canUseDummyFallback) {
      const nowIso = new Date().toISOString();
      const requestId = randomUUID();
      const transactionFee = await getWithdrawalTransactionFee();
      const amount = Number(req.body?.withdrawal_amount || 0);
      const tdsAmount = Number((amount * 0.01).toFixed(2));
      const finalCreditAmount = Number((amount - tdsAmount - transactionFee).toFixed(2));

      return res.status(201).json({
        message: 'Withdrawal request submitted successfully (demo mode)',
        withdrawal: {
          request_id: requestId,
          listener_id: 'demo',
          payout_method: req.body?.payout_method || 'upi',
          upi_id: null,
          account_number: null,
          ifsc_code: null,
          bank_name: null,
          account_holder_name: null,
          withdrawal_amount: amount.toFixed(2),
          tds_amount: tdsAmount.toFixed(2),
          transaction_fee: transactionFee.toFixed(2),
          final_credit_amount: finalCreditAmount.toFixed(2),
          status: 'pending',
          created_at: nowIso,
          is_dummy: true,
        },
      });
    }

    return res.status(500).json({ error: 'Failed to create withdrawal request' });
  } finally {
    client.release();
  }
});

// PUT /api/listeners/:listener_id/voice-verification
// Update voice verification status
router.put('/:listener_id/voice-verification', authenticate, async (req, res) => {
  try {
    const { voice_url, voice_data, mime_type } = req.body;

    // Accept either a URL or base64 audio data
    let finalVoiceUrl = voice_url;

    if (!finalVoiceUrl && voice_data) {
      // voice_data is base64-encoded audio — store as data URL
      const mimeType = mime_type || 'audio/ogg';
      finalVoiceUrl = `data:${mimeType};base64,${voice_data}`;
    }

    if (!finalVoiceUrl) {
      return res.status(400).json({ error: 'Voice URL or voice data is required' });
    }

    // Verify listener belongs to user
    const listener = await Listener.findById(req.params.listener_id);
    if (!listener) {
      return res.status(404).json({ error: 'Listener not found' });
    }
    if (listener.user_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const previousVoiceUrl = listener.voice_verification_url;

    // If listener is rejected, mark as pending review (not auto-verified)
    const isRejected = listener.verification_status === 'rejected';
    const result = await Listener.updateVoiceVerification(req.params.listener_id, finalVoiceUrl, { verified: !isRejected });

    if (
      previousVoiceUrl &&
      previousVoiceUrl !== finalVoiceUrl
    ) {
      try {
        await deleteFromMinioByUrl(previousVoiceUrl);
      } catch (cleanupError) {
        console.warn('[VOICE_VERIFICATION] Previous voice cleanup failed', {
          listenerId: req.params.listener_id,
          previousVoiceUrl,
          message: cleanupError.message,
        });
      }
    }

    res.json({
      message: 'Voice verification updated successfully',
      voice_verified: result.voice_verified
    });
  } catch (error) {
    console.error('Update voice verification error:', error);
    res.status(500).json({ error: 'Failed to update voice verification' });
  }
});

// POST /api/listeners/:listener_id/payment-details
// Add or update payment details for listener
router.post('/:listener_id/payment-details', authenticate, async (req, res) => {
  try {
    console.log('[LISTENERS_ROUTE] Saving payment details', {
      listenerId: req.params.listener_id,
      userId: req.userId,
      payload: summarizePaymentPayload(req.body),
    });

    const {
      payment_method,
      mobile_number,
      upi_id,
      aadhaar_number,
      pan_number,
      name_as_per_pan,
      account_number,
      ifsc_code,
      bank_name,
      account_holder_name,
      pan_aadhaar_bank
    } = req.body;

    if (!payment_method || !['upi', 'bank', 'both'].includes(payment_method)) {
      return res.status(400).json({ error: 'Valid payment_method (upi/bank/both) is required' });
    }

    // Verify listener belongs to user
    const listener = await Listener.findById(req.params.listener_id);
    if (!listener) {
      return res.status(404).json({ error: 'Listener not found' });
    }
    if (listener.user_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Validate payment method fields
    if (payment_method === 'upi' || payment_method === 'both') {
      if (!upi_id) {
        return res.status(400).json({
          error: 'UPI method requires: upi_id'
        });
      }
    }

    if (payment_method === 'bank' || payment_method === 'both') {
      if (!account_number || !ifsc_code || !account_holder_name) {
        return res.status(400).json({
          error: 'Bank method requires: account_number, ifsc_code, account_holder_name'
        });
      }
    }

    // Try to create the table if it doesn't exist (for Vercel compatibility)
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS listener_payment_details(
          payment_detail_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          listener_id UUID UNIQUE REFERENCES listeners(listener_id) ON DELETE CASCADE,
          payment_method VARCHAR(20) CHECK(payment_method IN('upi', 'bank', 'both')),
          mobile_number VARCHAR(15),
          upi_id VARCHAR(255),
          aadhaar_number VARCHAR(12),
          pan_number VARCHAR(10),
          name_as_per_pan VARCHAR(100),
          account_number VARCHAR(20),
          ifsc_code VARCHAR(11),
          bank_name VARCHAR(100),
          account_holder_name VARCHAR(100),
          pan_aadhaar_bank VARCHAR(20),
          is_verified BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
  `);
    } catch (tableError) {
      console.log('Table already exists or error creating table:', tableError.message);
    }

    const query = `
      INSERT INTO listener_payment_details(
    listener_id, payment_method, mobile_number, upi_id, aadhaar_number, pan_number,
    name_as_per_pan, account_number, ifsc_code, bank_name,
    account_holder_name, pan_aadhaar_bank
  )
VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT(listener_id) DO UPDATE SET
payment_method = $2, mobile_number = $3, upi_id = $4, aadhaar_number = $5, pan_number = $6,
  name_as_per_pan = $7, account_number = $8, ifsc_code = $9, bank_name = $10,
  account_holder_name = $11, pan_aadhaar_bank = $12, updated_at = CURRENT_TIMESTAMP
RETURNING *
  `;

    const result = await pool.query(query, [
      req.params.listener_id, payment_method, mobile_number || null, upi_id || null, aadhaar_number || null, pan_number || null,
      name_as_per_pan || null, account_number || null, ifsc_code || null, bank_name || null, account_holder_name || null, pan_aadhaar_bank || null
    ]);

    console.log('Payment details saved successfully for listener:', req.params.listener_id);

    res.status(201).json({
      message: 'Payment details saved successfully',
      payment_details: result.rows[0]
    });
  } catch (error) {
    console.error('Add payment details error:', error);
    console.error('Error details:', {
      message: error.message,
      detail: error.detail,
      code: error.code,
      constraint: error.constraint,
      payload: summarizePaymentPayload(req.body)
    });

    if (error.code === '23505') { // Unique constraint violation
      return res.status(400).json({
        error: 'Payment details already exist for this listener'
      });
    }

    if (error.code === '23503') { // Foreign key constraint
      return res.status(400).json({
        error: 'Invalid listener reference'
      });
    }

    res.status(500).json({
      error: error.message || 'Failed to save payment details',
      details: process.env.NODE_ENV === 'development' ? error.detail : undefined
    });
  }
});

// GET /api/listeners/random
// Get a random available listener (for random calls)
router.get('/random', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit) : 1;
    const excludeListenerId = req.query.exclude || null;

    const listeners = await Listener.getRandomAvailable(limit, excludeListenerId);

    if (listeners.length === 0) {
      return res.status(404).json({ error: 'No available listeners found' });
    }

    res.json({
      listeners,
      count: listeners.length
    });
  } catch (error) {
    console.error('Get random listeners error:', error);
    res.status(500).json({ error: 'Failed to fetch random listeners' });
  }
});

export default router;
