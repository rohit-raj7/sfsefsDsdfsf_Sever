import express from 'express';
const router = express.Router();
import User from '../models/User.js';
import { pool } from '../db.js';
import { authenticate, authenticateAdmin } from '../middleware/auth.js';

async function resolveFollowTarget(targetId) {
  const query = `
    SELECT
      l.listener_id,
      l.user_id AS listener_user_id,
      l.professional_name,
      u.display_name
    FROM listeners l
    JOIN users u ON u.user_id = l.user_id
    WHERE (l.user_id = $1 OR l.listener_id = $1)
      AND COALESCE(l.verification_status, 'approved') = 'approved'
    LIMIT 1
  `;

  const result = await pool.query(query, [targetId]);
  return result.rows[0] ?? null;
}

async function getFollowSnapshot(currentUserId, listenerUserId) {
  const snapshotQuery = `
    SELECT
      EXISTS (
        SELECT 1
        FROM user_listener_follows
        WHERE follower_user_id = $1
          AND listener_user_id = $2
      ) AS is_following,
      (
        SELECT COUNT(*)
        FROM user_listener_follows
        WHERE listener_user_id = $2
      )::int AS followers_count
  `;

  const result = await pool.query(snapshotQuery, [currentUserId, listenerUserId]);
  const row = result.rows[0] ?? {};

  return {
    isFollowing: row.is_following === true,
    followersCount: Number(row.followers_count ?? 0)
  };
}
// GET /api/users
router.get('/', async (req, res) => {
  try {
    const params = [];
    const conditions = [];
    let index = 1;

    const gender = req.query.gender?.toString().trim();
    if (gender) {
      conditions.push(`LOWER(gender) = LOWER($${index++})`);
      params.push(gender);
    }

    const accountType = req.query.account_type?.toString().trim();
    if (accountType) {
      conditions.push(`account_type = $${index++}`);
      params.push(accountType);
    }

    const excludeAccountType = req.query.exclude_account_type?.toString().trim();
    if (excludeAccountType) {
      conditions.push(`account_type <> $${index++}`);
      params.push(excludeAccountType);
    }

    const isActive = req.query.is_active?.toString().trim();
    if (isActive == 'true' || isActive == 'false') {
      conditions.push(`is_active = $${index++}`);
      params.push(isActive == 'true');
    }

    const limitValue = Number.parseInt(req.query.limit?.toString() ?? '100', 10);
    const offsetValue = Number.parseInt(req.query.offset?.toString() ?? '0', 10);
    const limit = Number.isFinite(limitValue)
      ? Math.min(Math.max(limitValue, 1), 100)
      : 100;
    const offset = Number.isFinite(offsetValue) ? Math.max(offsetValue, 0) : 0;

    params.push(limit);
    const limitParam = `$${index++}`;
    params.push(offset);
    const offsetParam = `$${index++}`;

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    const result = await pool.query(
      `
        SELECT
          user_id,
          email,
          auth_provider,
          phone_number,
          mobile_number,
          full_name,
          display_name,
          gender,
          date_of_birth,
          city,
          country,
          avatar_url,
          account_type,
          is_verified,
          is_active,
          created_at
        FROM users
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ${limitParam} OFFSET ${offsetParam}
      `,
      params
    );

    const users = result.rows;
    res.json(users);
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET /api/users/profile
// Get user profile
router.get('/profile', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// PUT /api/users/profile
// Update user profile
router.put('/profile', authenticate, async (req, res) => {
  try {
    const allowedFields = [
      'email',
      'full_name',
      'display_name',
      'gender',
      'date_of_birth',
      'city',
      'country',
      'avatar_url',
      'bio',
      'mobile_number'
    ];
    const updates = {};

    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided for update' });
    }

    const updatedUser = await User.update(req.userId, updates);

    res.json({
      message: 'Profile updated successfully',
      user: updatedUser
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// POST /api/users/languages
// Add language preference
router.post('/languages', authenticate, async (req, res) => {
  try {
    const { language, proficiency_level } = req.body;

    if (!language) {
      return res.status(400).json({ error: 'Language is required' });
    }

    // Delete existing language records for this user to update their primary native language
    await pool.query('DELETE FROM user_languages WHERE user_id = $1', [req.userId]);

    const query = `
      INSERT INTO user_languages (user_id, language, proficiency_level)
      VALUES ($1, $2, $3)
      RETURNING *
    `;
    const result = await pool.query(query, [req.userId, language, proficiency_level || 'Basic']);

    res.json({
      message: 'Language added successfully',
      language: result.rows[0]
    });
  } catch (error) {
    console.error('Add language error:', error);
    res.status(500).json({ error: 'Failed to add language' });
  }
});

// GET /api/users/languages
// Get user languages
router.get('/languages/me', authenticate, async (req, res) => {
  try {
    const query = `
      SELECT * FROM user_languages 
      WHERE user_id = $1
      ORDER BY created_at ASC
    `;
    const result = await pool.query(query, [req.userId]);

    res.json({ languages: result.rows });
  } catch (error) {
    console.error('Get languages error:', error);
    res.status(500).json({ error: 'Failed to fetch languages' });
  }
});

// GET /api/users/follows/:target_id/status
// Get follow status + followers count for a listener target
router.get('/follows/:target_id/status', authenticate, async (req, res) => {
  try {
    const target = await resolveFollowTarget(req.params.target_id);

    if (!target) {
      return res.status(404).json({ error: 'Listener not found' });
    }

    const snapshot = await getFollowSnapshot(req.userId, target.listener_user_id);

    res.json({
      message: 'Follow status fetched successfully',
      targetUserId: target.listener_user_id,
      isFollowing: snapshot.isFollowing,
      followersCount: snapshot.followersCount
    });
  } catch (error) {
    console.error('Get follow status error:', error);
    res.status(500).json({ error: 'Failed to fetch follow status' });
  }
});

// POST /api/users/follows/:target_id
// Follow an approved listener target
router.post('/follows/:target_id', authenticate, async (req, res) => {
  try {
    const target = await resolveFollowTarget(req.params.target_id);

    if (!target) {
      return res.status(404).json({ error: 'Listener not found' });
    }

    if (target.listener_user_id === req.userId) {
      return res.status(400).json({ error: 'You cannot follow yourself' });
    }

    await pool.query(
      `
        INSERT INTO user_listener_follows (follower_user_id, listener_user_id)
        VALUES ($1, $2)
        ON CONFLICT (follower_user_id, listener_user_id) DO NOTHING
      `,
      [req.userId, target.listener_user_id]
    );

    const snapshot = await getFollowSnapshot(req.userId, target.listener_user_id);

    res.json({
      message: snapshot.isFollowing ? 'Listener followed successfully' : 'Already following this listener',
      targetUserId: target.listener_user_id,
      isFollowing: snapshot.isFollowing,
      followersCount: snapshot.followersCount
    });
  } catch (error) {
    console.error('Follow listener error:', error);
    res.status(500).json({ error: 'Failed to follow listener' });
  }
});

// DELETE /api/users/follows/:target_id
// Unfollow an approved listener target
router.delete('/follows/:target_id', authenticate, async (req, res) => {
  try {
    const target = await resolveFollowTarget(req.params.target_id);

    if (!target) {
      return res.status(404).json({ error: 'Listener not found' });
    }

    await pool.query(
      `
        DELETE FROM user_listener_follows
        WHERE follower_user_id = $1
          AND listener_user_id = $2
      `,
      [req.userId, target.listener_user_id]
    );

    const snapshot = await getFollowSnapshot(req.userId, target.listener_user_id);

    res.json({
      message: 'Listener unfollowed successfully',
      targetUserId: target.listener_user_id,
      isFollowing: snapshot.isFollowing,
      followersCount: snapshot.followersCount
    });
  } catch (error) {
    console.error('Unfollow listener error:', error);
    res.status(500).json({ error: 'Failed to unfollow listener' });
  }
});

// DELETE /api/users/languages/:language_id
// Remove language
router.delete('/languages/:language_id', authenticate, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM user_languages WHERE id = $1 AND user_id = $2',
      [req.params.language_id, req.userId]
    );

    res.json({ message: 'Language removed successfully' });
  } catch (error) {
    console.error('Delete language error:', error);
    res.status(500).json({ error: 'Failed to remove language' });
  }
});

// GET /api/users/wallet
// Get user wallet
router.get('/wallet', authenticate, async (req, res) => {
  try {
    const wallet = await User.getWallet(req.userId);
    let unlimitedExpiresAt = null;
    try {
      const userResult = await pool.query(
        'SELECT unlimited_expires_at FROM users WHERE user_id = $1',
        [req.userId]
      );
      unlimitedExpiresAt = userResult.rows[0]?.unlimited_expires_at ?? null;
    } catch (columnError) {
      // Backward compatibility for databases that have not yet applied the column migration.
      if (columnError?.code !== '42703') {
        throw columnError;
      }
      console.warn('users.unlimited_expires_at column missing; returning null in /users/wallet');
    }

    res.json({
      wallet,
      unlimited_expires_at: unlimitedExpiresAt
    });
  } catch (error) {
    console.error('Get wallet error:', error);
    res.status(500).json({ error: 'Failed to fetch wallet' });
  }
});

// GET /api/users/offer-banner
// Returns active offer banner only for eligible users (wallet below threshold)
router.get('/offer-banner', authenticate, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO wallets (user_id, balance)
       VALUES ($1, 0.0)
       ON CONFLICT (user_id) DO NOTHING`,
      [req.userId]
    );

    const [walletResult, activeNonExpiredResult, activeAnyResult] = await Promise.all([
      pool.query('SELECT balance FROM wallets WHERE user_id = $1 LIMIT 1', [req.userId]),
      // 1) Try to find an active, non-expired banner
      pool.query(
        `SELECT config_id, title, headline, subtext, button_text, countdown_prefix,
                min_wallet_balance, expires_at, is_active, updated_at
         FROM offer_banner_config
         WHERE is_active = TRUE
           AND (starts_at IS NULL OR starts_at <= CURRENT_TIMESTAMP)
           AND expires_at > CURRENT_TIMESTAMP
         ORDER BY updated_at DESC
         LIMIT 1`
      ),
      // 2) Also fetch any active banner (even if expired) for auto-extend
      pool.query(
        `SELECT config_id, title, headline, subtext, button_text, countdown_prefix,
                min_wallet_balance, expires_at, is_active, updated_at
         FROM offer_banner_config
         WHERE is_active = TRUE
         ORDER BY updated_at DESC
         LIMIT 1`
      ),
    ]);

    const walletBalance = Number(walletResult.rows[0]?.balance ?? 0);
    let activeBanner = activeNonExpiredResult.rows[0];

    // Auto-extend: if there's an active banner but it's expired, extend by 12 hours
    if (!activeBanner && activeAnyResult.rows[0]) {
      const expiredBanner = activeAnyResult.rows[0];
      const newStartsAt = new Date();
      const newExpiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);

      console.log('[offer-banner] Auto-extending expired active banner:', expiredBanner.config_id,
        'old expires_at:', expiredBanner.expires_at, '-> new expires_at:', newExpiresAt);

      const updated = await pool.query(
        `UPDATE offer_banner_config
         SET starts_at = $1, expires_at = $2, updated_at = CURRENT_TIMESTAMP
         WHERE config_id = $3
         RETURNING config_id, title, headline, subtext, button_text, countdown_prefix,
                   min_wallet_balance, expires_at, is_active, updated_at`,
        [newStartsAt, newExpiresAt, expiredBanner.config_id]
      );
      activeBanner = updated.rows[0] || null;
    }

    console.log('[offer-banner] userId:', req.userId, '| walletBalance:', walletBalance,
      '| activeBannerFound:', Boolean(activeBanner));

    if (!activeBanner) {
      return res.json({
        activeOffer: false,
        walletBalance,
        reason: 'none_active',
      });
    }

    const minWalletBalance = 5;
    if (walletBalance >= minWalletBalance) {
      return res.json({
        activeOffer: false,
        walletBalance,
        minWalletBalance,
        reason: 'wallet_sufficient',
      });
    }

    res.json({
      activeOffer: true,
      walletBalance,
      minWalletBalance,
      offerBanner: {
        offerId: activeBanner.config_id,
        title: activeBanner.title,
        headline: activeBanner.headline,
        subtext: activeBanner.subtext,
        buttonText: activeBanner.button_text,
        countdownPrefix: activeBanner.countdown_prefix,
        expiresAt: activeBanner.expires_at,
        isActive: activeBanner.is_active === true,
        updatedAt: activeBanner.updated_at,
      },
    });
  } catch (error) {
    console.error('Get offer banner error:', error);
    res.status(500).json({ error: 'Failed to fetch offer banner' });
  }
});

// POST /api/users/wallet/add
// Add balance to wallet after successful payment
router.post('/wallet/add', authenticate, async (req, res) => {
  try {
    const { amount, payment_id, payment_method, description, pack_id } = req.body;
    const parsedAmount = Number(amount);

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Valid amount is required' });
    }

    // Calculate extra bonus from recharge pack
    let bonusAmount = 0;
    let isUnlimited = false;
    let unlimitedDays = 0;
    let isFirstTimeOnly = false;

    if (pack_id) {
      const packResult = await pool.query(
        'SELECT extra_percent_or_amount, is_unlimited, unlimited_days, is_first_time_only FROM recharge_packs WHERE id = $1 AND is_active = TRUE',
        [pack_id]
      );
      if (packResult.rows.length > 0) {
        const pack = packResult.rows[0];
        const extraPercent = Number(pack.extra_percent_or_amount) || 0;
        bonusAmount = Number((parsedAmount * extraPercent / 100).toFixed(2));
        isUnlimited = pack.is_unlimited === true;
        unlimitedDays = Number(pack.unlimited_days) || 0;
        isFirstTimeOnly = pack.is_first_time_only === true;
      }
    }

    const totalCredit = Number((parsedAmount + bonusAmount).toFixed(2));

    let paymentDesc = description || 'Wallet recharge';
    if (isUnlimited && unlimitedDays > 0) {
      paymentDesc = `Subscription: ${unlimitedDays}-Day Unlimited VIP`;
    } else if (bonusAmount > 0) {
      paymentDesc = `Wallet recharge ₹${parsedAmount} + ₹${bonusAmount} extra bonus`;
    }

    const paymentDetails = {
      payment_id,
      payment_method: payment_method || 'razorpay',
      description: paymentDesc,
      currency: 'INR'
    };

    // If it's an unlimited pack, we DO NOT credit the standard wallet balance
    const creditWallet = !(isUnlimited && unlimitedDays > 0);
    const wallet = await User.addBalance(req.userId, totalCredit, paymentDetails, creditWallet);

    let unlimited_expires_at = null;

    if (isUnlimited && unlimitedDays > 0) {
      // Update unlimited_expires_at to NOW + unlimitedDays
      const updateQuery = `
        UPDATE users 
        SET unlimited_expires_at = CURRENT_TIMESTAMP + INTERVAL '${unlimitedDays} days'
        WHERE user_id = $1
        RETURNING unlimited_expires_at
      `;
      const updateResult = await pool.query(updateQuery, [req.userId]);
      unlimited_expires_at = updateResult.rows[0].unlimited_expires_at;
    }

    // If they bought the first-time offer pack, mark offer_used = true
    if (isFirstTimeOnly) {
      await pool.query(
        'UPDATE users SET offer_used = TRUE WHERE user_id = $1',
        [req.userId]
      );
    }

    res.json({
      message: isUnlimited ? 'Unlimited plan activated successfully' : 'Balance added successfully',
      balance: wallet.balance,
      base_amount: parsedAmount,
      bonus_amount: bonusAmount,
      total_credited: creditWallet ? totalCredit : 0,
      is_unlimited: isUnlimited,
      unlimited_expires_at
    });
  } catch (error) {
    console.error('Add balance error:', error);
    res.status(500).json({ error: 'Failed to add balance' });
  }
});

// POST /api/users/favorites/:listener_id
// Add listener to favorites
router.post('/favorites/:listener_id', authenticate, async (req, res) => {
  try {
    const query = `
      INSERT INTO favorites (user_id, listener_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, listener_id) DO NOTHING
      RETURNING *
    `;
    const result = await pool.query(query, [req.userId, req.params.listener_id]);

    res.json({
      message: 'Added to favorites',
      favorite: result.rows[0]
    });
  } catch (error) {
    console.error('Add favorite error:', error);
    res.status(500).json({ error: 'Failed to add favorite' });
  }
});

// DELETE /api/users/favorites/:listener_id
// Remove listener from favorites
router.delete('/favorites/:listener_id', authenticate, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM favorites WHERE user_id = $1 AND listener_id = $2',
      [req.userId, req.params.listener_id]
    );

    res.json({ message: 'Removed from favorites' });
  } catch (error) {
    console.error('Remove favorite error:', error);
    res.status(500).json({ error: 'Failed to remove favorite' });
  }
});

// GET /api/users/favorites
// Get user's favorite listeners
router.get('/favorites', authenticate, async (req, res) => {
  try {
    const query = `
      SELECT l.*, u.display_name, u.city, u.country, f.created_at as favorited_at
      FROM favorites f
      JOIN listeners l ON f.listener_id = l.listener_id
      JOIN users u ON l.user_id = u.user_id
      WHERE f.user_id = $1
      ORDER BY f.created_at DESC
    `;
    const result = await pool.query(query, [req.userId]);

    res.json({ favorites: result.rows });
  } catch (error) {
    console.error('Get favorites error:', error);
    res.status(500).json({ error: 'Failed to fetch favorites' });
  }
});

// DELETE /api/users/account
// Delete user account
router.delete('/account', authenticate, async (req, res) => {
  try {
    await User.deactivate(req.userId);
    res.json({ message: 'Account deactivated successfully' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// POST /api/users/update-fcm-token
// Update user FCM token
router.post('/update-fcm-token', authenticate, async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }
    const updated = await User.updateFcmToken(req.userId, token);
    if (!updated) {
      return res.status(404).json({ error: 'User not found' });
    }

    console.log(
      `[FCM] Updated token for user=${req.userId} rows=1 length=${token.length}`,
    );
    res.json({ message: 'FCM token updated successfully' });
  } catch (error) {
    console.error('Update FCM token error:', error);
    res.status(500).json({ error: 'Failed to update FCM token' });
  }
});

// GET /api/users/fcm-token-health
// Admin diagnostics for missing / stale FCM tokens
router.get('/fcm-token-health', authenticateAdmin, async (req, res) => {
  try {
    const accountType = String(req.query.account_type || '').trim().toLowerCase();
    const validAccountType =
      accountType === 'user' || accountType === 'listener' ? accountType : null;
    const limitRaw = Number.parseInt(String(req.query.limit || '200'), 10);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 1000)
      : 200;

    const whereParts = ['is_active = TRUE'];
    const params = [];
    let idx = 1;

    if (validAccountType) {
      whereParts.push(`account_type = $${idx++}`);
      params.push(validAccountType);
    }

    const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

    const summary = await pool.query(
      `
        SELECT
          COUNT(*)::int AS total_active,
          COUNT(*) FILTER (WHERE fcm_token IS NOT NULL AND BTRIM(fcm_token) <> '')::int AS with_token,
          COUNT(*) FILTER (WHERE fcm_token IS NULL OR BTRIM(fcm_token) = '')::int AS missing_token
        FROM users
        ${whereClause}
      `,
      params
    );

    const missingParams = [...params, limit];
    const missing = await pool.query(
      `
        SELECT
          user_id,
          account_type,
          display_name,
          email,
          mobile_number,
          created_at,
          last_login,
          updated_at
        FROM users
        ${whereClause}
          AND (fcm_token IS NULL OR BTRIM(fcm_token) = '')
        ORDER BY COALESCE(last_login, created_at) DESC
        LIMIT $${idx}
      `,
      missingParams
    );

    res.json({
      account_type: validAccountType || 'all',
      summary: summary.rows[0] || { total_active: 0, with_token: 0, missing_token: 0 },
      missing_users: missing.rows
    });
  } catch (error) {
    console.error('FCM token health error:', error);
    res.status(500).json({ error: 'Failed to fetch FCM token health' });
  }
});

// PUT /api/users/:user_id/status
// Toggle user active status (admin only)
router.put('/:user_id/status', authenticateAdmin, async (req, res) => {
  try {
    const { is_active } = req.body;
    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ error: 'is_active must be a boolean' });
    }

    const user = await User.findById(req.params.user_id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updated = await User.updateStatus(req.params.user_id, is_active);
    res.json({
      message: is_active ? 'User reactivated successfully' : 'User suspended successfully',
      user: updated
    });
  } catch (error) {
    console.error('Toggle user status error:', error);
    res.status(500).json({ error: 'Failed to update user status' });
  }
});

// GET /api/users/:user_id
// Get user by ID (public profile) — MUST be last to avoid catching /wallet, /favorites, etc.
router.get('/:user_id', async (req, res) => {
  try {
    const user = await User.findById(req.params.user_id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Return limited public info
    const publicProfile = {
      user_id: user.user_id,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      city: user.city,
      country: user.country,
      bio: user.bio
    };

    res.json({ user: publicProfile });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// PUT /api/users/:user_id
// Update user by ID for admin
router.put('/:user_id', authenticateAdmin, async (req, res) => {
  try {
    const {
      is_active,
      full_name,
      display_name,
      email,
      city,
      country,
      bio,
      mobile_number
    } = req.body;

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (is_active !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(is_active);
    }
    if (full_name !== undefined) {
      updates.push(`full_name = $${paramIndex++}`);
      values.push(full_name);
    }
    if (display_name !== undefined) {
      updates.push(`display_name = $${paramIndex++}`);
      values.push(display_name);
    }
    if (email !== undefined) {
      updates.push(`email = $${paramIndex++}`);
      values.push(email);
    }
    if (city !== undefined) {
      updates.push(`city = $${paramIndex++}`);
      values.push(city);
    }
    if (country !== undefined) {
      updates.push(`country = $${paramIndex++}`);
      values.push(country);
    }
    if (bio !== undefined) {
      updates.push(`bio = $${paramIndex++}`);
      values.push(bio);
    }
    if (mobile_number !== undefined) {
      updates.push(`mobile_number = $${paramIndex++}`);
      values.push(mobile_number);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields provided for update' });
    }

    values.push(req.params.user_id);
    const query = `
      UPDATE users 
      SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $${paramIndex}
      RETURNING user_id, email, full_name, display_name, city, country, bio, mobile_number, is_active
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      message: 'User updated successfully',
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Update user error (admin):', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// DELETE /api/users/:user_id
// Delete user by ID for admin
router.delete('/:user_id', authenticateAdmin, async (req, res) => {
  try {
    const { user_id } = req.params;
    const deleted = await User.delete(user_id);
    if (!deleted) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ message: 'User and all related data deleted successfully' });
  } catch (error) {
    console.error('Delete user error (admin):', error);
    res.status(500).json({ error: 'Failed to delete user completely' });
  }
});

export default router;
