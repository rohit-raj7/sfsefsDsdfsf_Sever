import express from 'express';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import { OAuth2Client } from 'google-auth-library';
import Admin from '../models/Admin.js';
import Listener from '../models/Listener.js';
import AppRating from '../models/AppRating.js';
import ChatChargeConfig from '../models/ChatChargeConfig.js';
import config from '../config/config.js';
import { pool } from '../db.js';
import { authenticateAdmin } from '../middleware/auth.js';
import {
  validateGlobalRateInput,
  validateRuleInput,
  getGlobalRate,
  upsertGlobalRate,
  listRateRules,
  createRateRule,
  updateRateRule,
  deleteRateRule,
  getDropdownSettings,
  updateDropdownSettings,
  listPayoutSlabs,
  createPayoutSlab,
  updatePayoutSlab,
  deletePayoutSlab
} from '../services/rateSettingsService.js';

const router = express.Router();
// Support multiple env key styles before falling back to the existing hardcoded value.
const ADMIN_GOOGLE_CLIENT_ID =
  process.env.admin_google_client_id_override ||
  process.env.ADMIN_GOOGLE_CLIENT_ID ||
  process.env.admin_google_client_id ||
  '21566908692-dbjt8f2fvdir69nv559vaod9hkshuidq.apps.googleusercontent.com';
const googleClient = new OAuth2Client(ADMIN_GOOGLE_CLIENT_ID);
const allowedAdminEmails = String(process.env.ADMIN_ALLOWED_EMAILS || '')
  .split(',')
  .map((email) => String(email || '').trim().toLowerCase())
  .filter(Boolean);

const isAllowedAdminEmail = (email = '') => allowedAdminEmails.includes(String(email).trim().toLowerCase());

const defaultOfferBannerConfig = {
  offerId: null,
  title: 'Limited Time Offer',
  headline: 'Flat 25% OFF',
  subtext: 'on recharge of \u20B9100',
  buttonText: 'Recharge for \u20B975',
  countdownPrefix: 'Offer ends in 12h',
  minWalletBalance: 5,
  expiresAt: null,
  isActive: false,
  updatedAt: null,
};

const mapOfferBannerRow = (row) => ({
  offerId: row.config_id,
  title: row.title,
  headline: row.headline,
  subtext: row.subtext,
  buttonText: row.button_text,
  countdownPrefix: row.countdown_prefix,
  minWalletBalance: Number(row.min_wallet_balance),
  expiresAt: row.expires_at,
  isActive: row.is_active === true,
  updatedAt: row.updated_at,
});

// Admin email/password login
router.post('/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const admin = await Admin.findByEmail(email);
    if (!admin) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const isPasswordValid = await Admin.comparePassword(password, admin.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (admin.is_active === false) {
      return res.status(403).json({ error: 'Admin account is inactive' });
    }

    await Admin.updateLastLogin(admin.admin_id);

    const jwtToken = jwt.sign(
      { admin_id: admin.admin_id, email: admin.email },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    return res.json({
      message: 'Login successful',
      token: jwtToken,
      admin: {
        admin_id: admin.admin_id,
        email: admin.email,
        full_name: admin.full_name
      }
    });
  } catch (error) {
    console.error('Admin email login error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin Google login
router.post('/google-login', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    let userInfo;

    // Verify Google token
    try {
      // First, try to verify as ID token
      const ticket = await googleClient.verifyIdToken({
        idToken: token,
      });

      const payload = ticket.getPayload();

      userInfo = {
        email: String(payload.email || '').trim().toLowerCase(),
        full_name: payload.name,
      };
    } catch (idTokenError) {
      // If ID token verification fails, try as access token
      console.log('ID token verification failed, trying access token...');
      try {
        const googleRes = await axios.get(
          `https://www.googleapis.com/oauth2/v3/userinfo?access_token=${token}`
        );

        const googleUser = googleRes.data;

        userInfo = {
          email: String(googleUser.email || '').trim().toLowerCase(),
          full_name: googleUser.name,
        };
      } catch (accessTokenError) {
        console.error('Google token verification failed:', accessTokenError);
        return res.status(401).json({ error: 'Invalid Google token' });
      }
    }

    // Check if email is allow-listed for admin login
    if (!isAllowedAdminEmail(userInfo.email)) {
      return res.status(401).json({ error: 'Unauthorized: Not an admin email' });
    }

    // Find or create admin
    let admin = await Admin.findByEmail(userInfo.email);
    if (!admin) {
      // Create admin if not exists
      const hashedPassword = await Admin.hashPassword('defaultpassword'); // Not used, but required
      admin = await Admin.create({
        email: userInfo.email,
        password_hash: hashedPassword,
        full_name: userInfo.full_name,
      });
    }

    // Update last login
    await Admin.updateLastLogin(admin.admin_id);

    // Generate JWT token
    const jwtToken = jwt.sign(
      { admin_id: admin.admin_id, email: admin.email },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );

    res.json({
      message: 'Login successful',
      token: jwtToken,
      admin: {
        admin_id: admin.admin_id,
        email: admin.email,
        full_name: admin.full_name
      }
    });
  } catch (error) {
    console.error('Admin Google login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// GET /api/admin/listeners
// Get all listeners for admin panel
router.get('/listeners', authenticateAdmin, async (req, res) => {
  try {
    const listeners = await Listener.getAllForAdmin();
    res.json({ listeners });
  } catch (error) {
    console.error('Get admin listeners error:', error);
    res.status(500).json({ error: 'Failed to fetch listeners' });
  }
});

// GET /api/admin/rates/global
// Fetch the global fallback listener rates.
router.get('/rates/global', authenticateAdmin, async (req, res) => {
  try {
    const globalRate = await getGlobalRate();
    res.json({ globalRate });
  } catch (error) {
    console.error('Get global rates error:', error);
    res.status(500).json({ error: 'Failed to fetch global rates' });
  }
});

// POST /api/admin/rates/global
// Save the single global fallback listener rate record.
router.post('/rates/global', authenticateAdmin, async (req, res) => {
  try {
    const validation = validateGlobalRateInput(req.body || {});
    if (validation.error) {
      return res.status(400).json({ error: validation.error });
    }

    const globalRate = await upsertGlobalRate({
      ...validation.value,
      adminId: req.adminId
    });

    res.json({ message: 'Global rates saved', globalRate });
  } catch (error) {
    console.error('Save global rates error:', error);
    res.status(500).json({ error: 'Failed to save global rates' });
  }
});

// GET /api/admin/rates/rules
// List all listener rate rules.
router.get('/rates/rules', authenticateAdmin, async (req, res) => {
  try {
    const rules = await listRateRules();
    res.json({ rules });
  } catch (error) {
    console.error('Get rate rules error:', error);
    res.status(500).json({ error: 'Failed to fetch rate rules' });
  }
});

// POST /api/admin/rates/rules
// Create a listener rate rule.
router.post('/rates/rules', authenticateAdmin, async (req, res) => {
  try {
    const validation = validateRuleInput(req.body || {});
    if (validation.error) {
      return res.status(400).json({ error: validation.error });
    }

    const rule = await createRateRule(validation.value, req.adminId);
    res.status(201).json({ message: 'Rate rule saved', rule });
  } catch (error) {
    console.error('Create rate rule error:', error);
    if (error.code === 'DUPLICATE_RATE_RULE') {
      return res.status(409).json({
        error: 'Duplicate rule: this Avg Rating + Total Duration range already exists',
        existingRuleId: error.existingRuleId || null,
      });
    }
    res.status(500).json({ error: 'Failed to save rate rule' });
  }
});

// PUT /api/admin/rates/rules/:ruleId
// Update a listener rate rule.
router.put('/rates/rules/:ruleId', authenticateAdmin, async (req, res) => {
  try {
    const validation = validateRuleInput(req.body || {});
    if (validation.error) {
      return res.status(400).json({ error: validation.error });
    }

    const rule = await updateRateRule(req.params.ruleId, validation.value, req.adminId);
    if (!rule) {
      return res.status(404).json({ error: 'Rate rule not found' });
    }

    res.json({ message: 'Rate rule updated', rule });
  } catch (error) {
    console.error('Update rate rule error:', error);
    if (error.code === 'DUPLICATE_RATE_RULE') {
      return res.status(409).json({
        error: 'Duplicate rule: this Avg Rating + Total Duration range already exists',
        existingRuleId: error.existingRuleId || null,
      });
    }
    res.status(500).json({ error: 'Failed to update rate rule' });
  }
});

// DELETE /api/admin/rates/rules/:ruleId
// Delete a listener rate rule.
router.delete('/rates/rules/:ruleId', authenticateAdmin, async (req, res) => {
  try {
    const deleted = await deleteRateRule(req.params.ruleId);
    if (!deleted) {
      return res.status(404).json({ error: 'Rate rule not found' });
    }

    res.json({ message: 'Rate rule deleted' });
  } catch (error) {
    console.error('Delete rate rule error:', error);
    res.status(500).json({ error: 'Failed to delete rate rule' });
  }
});

// GET /api/admin/rates/dropdown-settings
// Fetch editable dropdown choices for rate-rule creation.
router.get('/rates/dropdown-settings', authenticateAdmin, async (req, res) => {
  try {
    const dropdownSettings = await getDropdownSettings();
    res.json({ dropdownSettings });
  } catch (error) {
    console.error('Get rate dropdown settings error:', error);
    res.status(500).json({ error: 'Failed to fetch dropdown settings' });
  }
});

// PUT /api/admin/rates/dropdown-settings
// Update editable dropdown choices for rate-rule creation.
router.put('/rates/dropdown-settings', authenticateAdmin, async (req, res) => {
  try {
    const result = await updateDropdownSettings(req.body?.settings || {}, req.adminId);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ message: 'Dropdown settings saved', dropdownSettings: result.value });
  } catch (error) {
    console.error('Update rate dropdown settings error:', error);
    res.status(500).json({ error: 'Failed to save dropdown settings' });
  }
});

// GET /api/admin/payout-slabs
// List all listener payout slabs.
router.get('/payout-slabs', authenticateAdmin, async (req, res) => {
  try {
    const slabs = await listPayoutSlabs();
    res.json({ slabs });
  } catch (error) {
    console.error('Get payout slabs error:', error);
    res.status(500).json({ error: 'Failed to fetch payout slabs' });
  }
});

// POST /api/admin/payout-slabs
// Create a listener payout slab.
router.post('/payout-slabs', authenticateAdmin, async (req, res) => {
  try {
    const slab = await createPayoutSlab(req.body || {}, req.adminId);
    res.status(201).json({ message: 'Payout slab saved', slab });
  } catch (error) {
    console.error('Create payout slab error:', error);
    if (error.code === 'OVERLAPPING_SLAB') {
      return res.status(409).json({ error: error.message });
    }
    res.status(500).json({ error: error.message || 'Failed to save payout slab' });
  }
});

// PUT /api/admin/payout-slabs/:slabId
// Update a listener payout slab.
router.put('/payout-slabs/:slabId', authenticateAdmin, async (req, res) => {
  try {
    const slab = await updatePayoutSlab(req.params.slabId, req.body || {}, req.adminId);
    if (!slab) {
      return res.status(404).json({ error: 'Payout slab not found' });
    }
    res.json({ message: 'Payout slab updated', slab });
  } catch (error) {
    console.error('Update payout slab error:', error);
    if (error.code === 'OVERLAPPING_SLAB') {
      return res.status(409).json({ error: error.message });
    }
    res.status(500).json({ error: error.message || 'Failed to update payout slab' });
  }
});

// DELETE /api/admin/payout-slabs/:slabId
// Delete a listener payout slab.
router.delete('/payout-slabs/:slabId', authenticateAdmin, async (req, res) => {
  try {
    const deleted = await deletePayoutSlab(req.params.slabId);
    if (!deleted) {
      return res.status(404).json({ error: 'Payout slab not found' });
    }
    res.json({ message: 'Payout slab deleted' });
  } catch (error) {
    console.error('Delete payout slab error:', error);
    res.status(500).json({ error: 'Failed to delete payout slab' });
  }
});

// POST /api/admin/listener/set-rates
// Set listener rates (admin only)
router.post('/listener/set-rates', authenticateAdmin, async (req, res) => {
  return res.status(410).json({
    error: 'Endpoint deprecated',
    details: 'Per-listener manual rates are disabled. Use /api/admin/rates/rules and /api/admin/rates/global instead.',
  });
});

// GET /api/admin/quality-overview
// View all listeners with quality status for admin management (Section 12)
router.get('/quality-overview', authenticateAdmin, async (req, res) => {
  try {
    const { status } = req.query; // filter by quality_status
    let query = `
      SELECT l.listener_id, l.user_id, l.professional_name, l.quality_status,
             l.strike_count, l.probation_calls_remaining, l.warning_reason,
             l.suspension_reason, l.suspended_until, l.average_rating,
             l.total_calls, l.listener_type, l.avg_call_duration_seconds,
             l.hangup_rate, l.is_active, l.verification_status,
             u.display_name, u.phone
      FROM listeners l
      JOIN users u ON l.user_id = u.user_id
    `;
    const params = [];
    if (status) {
      params.push(status);
      query += ` WHERE l.quality_status = $1`;
    }
    query += ` ORDER BY l.strike_count DESC, l.quality_status ASC, l.created_at DESC`;

    const result = await pool.query(query, params);

    // Count summary
    const summaryResult = await pool.query(`
      SELECT quality_status, COUNT(*) as count
      FROM listeners
      GROUP BY quality_status
    `);
    const summary = {};
    for (const row of summaryResult.rows) {
      summary[row.quality_status || 'unknown'] = Number(row.count);
    }

    res.json({
      success: true,
      summary,
      listeners: result.rows,
      count: result.rows.length,
    });
  } catch (error) {
    console.error('Quality overview error:', error);
    res.status(500).json({ error: 'Failed to fetch quality overview' });
  }
});

// PUT /api/admin/quality-status
// Update a listener's quality status (promote, warn, suspend, ban, clear strikes)
router.put('/quality-status', authenticateAdmin, async (req, res) => {
  try {
    const { listener_id, action, reason } = req.body;

    if (!listener_id || !action) {
      return res.status(400).json({ error: 'listener_id and action are required' });
    }

    const validActions = ['promote', 'warn', 'suspend', 'ban', 'unsuspend', 'clear_strikes', 'reset_probation'];
    if (!validActions.includes(action)) {
      return res.status(400).json({ error: `action must be one of: ${validActions.join(', ')}` });
    }

    let updateQuery = '';
    let updateParams = [listener_id];

    switch (action) {
      case 'promote':
        updateQuery = `UPDATE listeners SET quality_status = 'active', warning_reason = NULL, suspension_reason = NULL, is_active = TRUE WHERE listener_id = $1 RETURNING *`;
        break;
      case 'warn':
        updateQuery = `UPDATE listeners SET quality_status = 'warning', warning_reason = $2 WHERE listener_id = $1 RETURNING *`;
        updateParams.push(reason || 'Admin warning');
        break;
      case 'suspend':
        updateQuery = `UPDATE listeners SET quality_status = 'suspended', suspension_reason = $2, is_active = FALSE WHERE listener_id = $1 RETURNING *`;
        updateParams.push(reason || 'Suspended by admin');
        break;
      case 'ban':
        updateQuery = `UPDATE listeners SET quality_status = 'banned', suspension_reason = $2, is_active = FALSE WHERE listener_id = $1 RETURNING *`;
        updateParams.push(reason || 'Banned by admin');
        break;
      case 'unsuspend':
        updateQuery = `UPDATE listeners SET quality_status = 'active', suspension_reason = NULL, suspended_until = NULL, is_active = TRUE WHERE listener_id = $1 RETURNING *`;
        break;
      case 'clear_strikes':
        updateQuery = `UPDATE listeners SET strike_count = 0 WHERE listener_id = $1 RETURNING *`;
        break;
      case 'reset_probation':
        updateQuery = `UPDATE listeners SET quality_status = 'probation', probation_calls_remaining = 10, warning_reason = NULL, suspension_reason = NULL, is_active = TRUE WHERE listener_id = $1 RETURNING *`;
        break;
    }

    const result = await pool.query(updateQuery, updateParams);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Listener not found' });
    }

    console.log(`[ADMIN] Quality action '${action}' applied to listener ${listener_id}`);

    res.json({
      success: true,
      message: `Action '${action}' applied successfully`,
      listener: result.rows[0],
    });
  } catch (error) {
    console.error('Quality status update error:', error);
    res.status(500).json({ error: 'Failed to update quality status' });
  }
});

// PUT /api/admin/listener/update-rates/:listenerId
// Update listener rates (admin only)
router.put('/listener/update-rates/:listenerId', authenticateAdmin, async (req, res) => {
  return res.status(410).json({
    error: 'Endpoint deprecated',
    details: 'Per-listener manual rates are disabled. Use /api/admin/rates/rules and /api/admin/rates/global instead.',
  });
});

// PUT /api/admin/users/:user_id/wallet
// Manually edit a user's wallet balance (God Mode)
router.put('/users/:user_id/wallet', authenticateAdmin, async (req, res) => {
  try {
    const { balance } = req.body;
    const parsedBalance = Number(balance);

    if (!Number.isFinite(parsedBalance) || parsedBalance < 0) {
      return res.status(400).json({ error: 'Balance must be a non-negative number' });
    }

    // Ensure wallet exists before updating
    await pool.query(
      `INSERT INTO wallets (user_id, balance) VALUES ($1, 0.0) ON CONFLICT (user_id) DO NOTHING`,
      [req.params.user_id]
    );

    await pool.query(
      `UPDATE wallets SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
      [parsedBalance, req.params.user_id]
    );

    // Also update denormalized field in users
    await pool.query(
      `UPDATE users SET wallet_balance = $1 WHERE user_id = $2`,
      [parsedBalance, req.params.user_id]
    );

    // Record audit transaction
    await pool.query(
      `INSERT INTO transactions (user_id, transaction_type, amount, currency, description, status)
       VALUES ($1, 'credit', $2, 'INR', 'Admin Manual Balance Adjustment', 'completed')`,
      [req.params.user_id, parsedBalance]
    );

    res.json({ message: 'Wallet balance updated successfully', balance: parsedBalance });
  } catch (error) {
    console.error('Update user wallet error:', error);
    res.status(500).json({ error: 'Failed to update user wallet' });
  }
});

// PUT /api/admin/listeners/:listener_id/stats
// Manually override listener statistics (God Mode)
router.put('/listeners/:listener_id/stats', authenticateAdmin, async (req, res) => {
  try {
    const { average_rating, total_calls, total_minutes } = req.body;

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (average_rating !== undefined) {
      updates.push(`average_rating = $${paramIndex++}`);
      values.push(Number(average_rating));
    }
    if (total_calls !== undefined) {
      updates.push(`total_calls = $${paramIndex++}`);
      values.push(Number(total_calls));
    }
    if (total_minutes !== undefined) {
      updates.push(`total_minutes = $${paramIndex++}`);
      values.push(Number(total_minutes));
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No stats provided to update' });
    }

    values.push(req.params.listener_id);

    // Add updated_at
    updates.push(`updated_at = CURRENT_TIMESTAMP`);

    const query = `
      UPDATE listeners 
      SET ${updates.join(', ')} 
      WHERE listener_id = $${paramIndex}
      RETURNING listener_id, average_rating, total_calls, total_minutes
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Listener not found' });
    }

    res.json({ message: 'Listener stats updated successfully', listener: result.rows[0] });
  } catch (error) {
    console.error('Update listener stats error:', error);
    res.status(500).json({ error: 'Failed to update listener stats' });
  }
});

// GET /api/admin/app-ratings
// Fetch app ratings and feedback for admin panel
router.get('/app-ratings', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, search, min_rating, max_rating } = req.query;
    const perPage = Math.min(Math.max(Number(limit) || 20, 1), 200);
    const currentPage = Math.max(Number(page) || 1, 1);
    const offset = (currentPage - 1) * perPage;

    const minRating = min_rating !== undefined ? Number(min_rating) : undefined;
    const maxRating = max_rating !== undefined ? Number(max_rating) : undefined;

    if (min_rating !== undefined && !Number.isFinite(minRating)) {
      return res.status(400).json({ error: 'min_rating must be a valid number' });
    }

    if (max_rating !== undefined && !Number.isFinite(maxRating)) {
      return res.status(400).json({ error: 'max_rating must be a valid number' });
    }

    if (
      Number.isFinite(minRating) &&
      Number.isFinite(maxRating) &&
      Number(minRating) > Number(maxRating)
    ) {
      return res.status(400).json({ error: 'min_rating cannot be greater than max_rating' });
    }

    const result = await AppRating.getAllForAdmin({
      limit: perPage,
      offset,
      search,
      minRating,
      maxRating,
    });

    return res.json({
      ratings: result.ratings,
      count: result.count,
      average_rating: result.average_rating,
      page: currentPage,
      limit: perPage,
    });
  } catch (error) {
    console.error('Get app ratings error:', error);
    return res.status(500).json({ error: 'Failed to fetch app ratings' });
  }
});

// DELETE /api/admin/app-ratings
// Delete selected app ratings for admin panel
router.delete('/app-ratings', authenticateAdmin, async (req, res) => {
  try {
    const bodyIds = req.body?.rating_ids ?? req.body?.ratingIds;
    const ratingIds = Array.isArray(bodyIds) ? bodyIds : [];
    const normalizedIds = Array.from(
      new Set(
        ratingIds
          .map((value) => String(value || '').trim())
          .filter((value) => value.length > 0),
      ),
    );

    if (normalizedIds.length === 0) {
      return res.status(400).json({ error: 'rating_ids must be a non-empty array of rating IDs' });
    }

    const result = await AppRating.deleteByIds(normalizedIds);

    return res.json({
      message: `Deleted ${result.deleted_count} rating${result.deleted_count === 1 ? '' : 's'}`,
      deleted_count: result.deleted_count,
      deleted_ids: result.deleted_ids,
    });
  } catch (error) {
    console.error('Delete app ratings error:', error);
    return res.status(500).json({ error: 'Failed to delete app ratings' });
  }
});

// GET /api/admin/contact-messages
// Fetch contact/support messages for admin panel
router.get('/contact-messages', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, source, search } = req.query;
    const perPage = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const currentPage = Math.max(Number(page) || 1, 1);
    const offset = (currentPage - 1) * perPage;

    const conds = [];
    const params = [];
    let idx = 1;

    if (source && (source === 'contact' || source === 'support')) {
      conds.push(`source = $${idx++}`);
      params.push(source);
    }

    if (search) {
      conds.push(`(name ILIKE $${idx} OR email ILIKE $${idx} OR message ILIKE $${idx})`);
      params.push(`%${String(search).trim()}%`);
      idx += 1;
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const listQuery = `
      SELECT contact_id, source, name, email, message, user_id, created_at
      FROM contact_messages
      ${where}
      ORDER BY created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;
    const listParams = [...params, perPage, offset];

    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM contact_messages
      ${where}
    `;

    const [listResult, countResult] = await Promise.all([
      pool.query(listQuery, listParams),
      pool.query(countQuery, params)
    ]);

    res.json({
      messages: listResult.rows,
      count: countResult.rows[0]?.count || 0,
      page: currentPage,
      limit: perPage
    });
  } catch (error) {
    console.error('Get contact messages error:', error);
    res.status(500).json({ error: 'Failed to fetch contact messages' });
  }
});

// GET /api/admin/report-submits
// Fetch user submitted listener reports for support/review section
router.get('/report-submits', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, report_type, reviewed, search } = req.query;
    const perPage = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const currentPage = Math.max(Number(page) || 1, 1);
    const offset = (currentPage - 1) * perPage;

    const conds = [];
    const params = [];
    let idx = 1;

    if (report_type) {
      conds.push(`lr.report_type = $${idx++}`);
      params.push(String(report_type).trim().toLowerCase());
    }

    if (reviewed === 'true' || reviewed === 'false') {
      conds.push(`lr.reviewed = $${idx++}`);
      params.push(reviewed === 'true');
    }

    if (search) {
      conds.push(`(
        reporter.display_name ILIKE $${idx}
        OR reporter.email ILIKE $${idx}
        OR reported_user.display_name ILIKE $${idx}
        OR l.professional_name ILIKE $${idx}
        OR lr.report_type ILIKE $${idx}
        OR lr.description ILIKE $${idx}
        OR lr.call_id::text ILIKE $${idx}
      )`);
      params.push(`%${String(search).trim()}%`);
      idx += 1;
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const baseFrom = `
      FROM listener_reports lr
      LEFT JOIN users reporter ON reporter.user_id = lr.reporter_user_id
      LEFT JOIN listeners l ON l.listener_id = lr.listener_id
      LEFT JOIN users reported_user ON reported_user.user_id = l.user_id
    `;

    const listQuery = `
      SELECT
        lr.report_id,
        lr.call_id,
        lr.listener_id AS reported_listener_id,
        lr.reporter_user_id,
        lr.report_type,
        lr.description,
        lr.reviewed,
        lr.strike_applied,
        lr.created_at,
        COALESCE(reporter.display_name, 'Unknown') AS reporter_name,
        reporter.email AS reporter_email,
        COALESCE(reporter.mobile_number, reporter.phone_number) AS reporter_phone,
        COALESCE(reported_user.display_name, l.professional_name, 'Unknown') AS reported_name,
        reported_user.user_id AS reported_user_id,
        reported_user.email AS reported_email,
        COALESCE(reported_user.mobile_number, reported_user.phone_number) AS reported_phone,
        l.professional_name AS reported_professional_name
      ${baseFrom}
      ${where}
      ORDER BY lr.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;
    const listParams = [...params, perPage, offset];

    const countQuery = `
      SELECT COUNT(*)::int AS count
      ${baseFrom}
      ${where}
    `;

    const [listResult, countResult] = await Promise.all([
      pool.query(listQuery, listParams),
      pool.query(countQuery, params)
    ]);

    res.json({
      reports: listResult.rows,
      count: countResult.rows[0]?.count || 0,
      page: currentPage,
      limit: perPage
    });
  } catch (error) {
    console.error('Get report submits error:', error);
    res.status(500).json({ error: 'Failed to fetch report submissions' });
  }
});

// GET /api/admin/delete-requests
// Fetch account deletion requests for admin panel
router.get('/delete-requests', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, role, status, search } = req.query;
    const perPage = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const currentPage = Math.max(Number(page) || 1, 1);
    const offset = (currentPage - 1) * perPage;

    const conds = [];
    const params = [];
    let idx = 1;

    if (role && (role === 'user' || role === 'listener')) {
      conds.push(`role = $${idx++}`);
      params.push(role);
    }

    if (status && (status === 'pending' || status === 'approved' || status === 'rejected')) {
      conds.push(`status = $${idx++}`);
      params.push(status);
    }

    if (search) {
      conds.push(
        `(name ILIKE $${idx} OR email ILIKE $${idx} OR phone ILIKE $${idx} OR reason ILIKE $${idx})`
      );
      params.push(`%${String(search).trim()}%`);
      idx += 1;
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const listQuery = `
      SELECT request_id, user_id, name, email, phone, reason, role, status, created_at
      FROM delete_account_requests
      ${where}
      ORDER BY created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;
    const listParams = [...params, perPage, offset];

    const countQuery = `
      SELECT COUNT(*)::int AS count
      FROM delete_account_requests
      ${where}
    `;

    const [listResult, countResult] = await Promise.all([
      pool.query(listQuery, listParams),
      pool.query(countQuery, params)
    ]);

    res.json({
      requests: listResult.rows,
      count: countResult.rows[0]?.count || 0,
      page: currentPage,
      limit: perPage
    });
  } catch (error) {
    console.error('Get delete requests error:', error);
    res.status(500).json({ error: 'Failed to fetch delete requests' });
  }
});

// DELETE /api/admin/delete-requests/:request_id
// Remove a delete request from admin panel
router.delete('/delete-requests/:request_id', authenticateAdmin, async (req, res) => {
  try {
    const { request_id } = req.params;

    if (!request_id) {
      return res.status(400).json({ error: 'Request id is required' });
    }

    const deleteQuery = `
      DELETE FROM delete_account_requests
      WHERE request_id = $1
      RETURNING request_id
    `;

    const result = await pool.query(deleteQuery, [request_id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Delete request not found' });
    }

    return res.json({ message: 'Delete request removed', request_id });
  } catch (error) {
    console.error('Delete request removal error:', error);
    return res.status(500).json({ error: 'Failed to delete request' });
  }
});

// PUT /api/admin/listeners/:listener_id/verification-status
// Update listener verification status (approve/reject)
// VERIFICATION CONTROL: Admin endpoint to approve or reject listener applications
router.put('/listeners/:listener_id/verification-status', authenticateAdmin, async (req, res) => {
  try {
    const { listener_id } = req.params;
    const { status, rejection_reason } = req.body;

    console.log(`[ADMIN] Updating verification status for listener ${listener_id} to: ${status}${rejection_reason ? ` (reason: ${rejection_reason})` : ''}`);

    if (!status || !['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({
        error: 'Invalid status. Must be one of: pending, approved, rejected'
      });
    }

    // Check if listener exists
    const listener = await Listener.findById(listener_id);
    if (!listener) {
      return res.status(404).json({ error: 'Listener not found' });
    }

    // Update verification status with optional rejection reason
    const updated = await Listener.updateVerificationStatus(listener_id, status, rejection_reason);

    console.log(`[ADMIN] Listener ${listener_id} verification status updated to: ${status}`);

    res.json({
      message: `Listener verification status updated to ${status}`,
      listener: {
        listener_id: updated.listener_id,
        verification_status: updated.verification_status,
        is_verified: updated.is_verified,
        rejection_reason: updated.rejection_reason,
        reapply_attempts: updated.reapply_attempts
      }
    });
  } catch (error) {
    console.error('Update listener verification status error:', error);
    res.status(500).json({ error: 'Failed to update verification status' });
  }
});

// Get user transactions (admin)
router.get('/users/:user_id/transactions', authenticateAdmin, async (req, res) => {
  try {
    const { user_id } = req.params;

    // Fetch user info
    const userResult = await pool.query(
      'SELECT user_id, display_name, email, mobile_number, city, country, account_type, is_active, created_at FROM users WHERE user_id = $1',
      [user_id]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Fetch wallet
    const walletResult = await pool.query(
      'SELECT balance, currency, updated_at FROM wallets WHERE user_id = $1',
      [user_id]
    );

    // Fetch transactions
    const txResult = await pool.query(
      `SELECT transaction_id, transaction_type, amount, currency, description, payment_method, payment_gateway_id, status, related_call_id, created_at
       FROM transactions WHERE user_id = $1 ORDER BY created_at DESC`,
      [user_id]
    );

    res.json({
      user: userResult.rows[0],
      wallet: walletResult.rows[0] || { balance: '0.00', currency: 'INR' },
      transactions: txResult.rows
    });
  } catch (error) {
    console.error('Get user transactions error:', error);
    res.status(500).json({ error: 'Failed to fetch user transactions' });
  }
});

// ============================================
// OFFER BANNER CONFIG ROUTES
// ============================================

// GET /api/admin/offer-banner
router.get('/offer-banner', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT config_id, title, headline, subtext, button_text, countdown_prefix,
              min_wallet_balance, expires_at, is_active, updated_at
       FROM offer_banner_config
       ORDER BY updated_at DESC
       LIMIT 1`
    );

    const row = result.rows[0];
    res.json({
      hasConfig: Boolean(row),
      offerBanner: row ? mapOfferBannerRow(row) : defaultOfferBannerConfig,
    });
  } catch (error) {
    console.error('Get offer banner config error:', error);
    res.status(500).json({ error: 'Failed to fetch offer banner config' });
  }
});

// PUT /api/admin/offer-banner
router.put('/offer-banner', authenticateAdmin, async (req, res) => {
  try {
    const {
      title,
      headline,
      subtext,
      buttonText,
      countdownPrefix,
      isActive,
    } = req.body || {};

    const normalizedTitle = String(title ?? '').trim();
    const normalizedHeadline = String(headline ?? '').trim();
    const normalizedSubtext = String(subtext ?? '').trim();
    const normalizedButtonText = String(buttonText ?? '').trim();
    const normalizedCountdownPrefix = String(countdownPrefix ?? '').trim();

    if (!normalizedTitle) {
      return res.status(400).json({ error: 'title is required' });
    }
    if (!normalizedHeadline) {
      return res.status(400).json({ error: 'headline is required' });
    }
    if (!normalizedSubtext) {
      return res.status(400).json({ error: 'subtext is required' });
    }
    if (!normalizedButtonText) {
      return res.status(400).json({ error: 'buttonText is required' });
    }
    if (!normalizedCountdownPrefix) {
      return res.status(400).json({ error: 'countdownPrefix is required' });
    }

    const enableBanner = isActive === true;

    // Default: starts now, expires in 12 hours
    const finalStartsAt = new Date();
    const finalExpiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);

    const client = await pool.connect();
    let saveResult;
    try {
      await client.query('BEGIN');

      // Keep exactly one active banner at a time.
      await client.query(
        `UPDATE offer_banner_config
         SET is_active = FALSE
         WHERE is_active = TRUE`
      );

      saveResult = await client.query(
        `INSERT INTO offer_banner_config (
           title,
           headline,
           subtext,
           button_text,
           countdown_prefix,
           recharge_amount,
           discounted_amount,
           min_wallet_balance,
           starts_at,
           expires_at,
           is_active,
           updated_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING config_id, title, headline, subtext, button_text, countdown_prefix,
                   min_wallet_balance, expires_at, is_active, updated_at`,
        [
          normalizedTitle,
          normalizedHeadline,
          normalizedSubtext,
          normalizedButtonText,
          normalizedCountdownPrefix,
          0,
          0,
          5,
          finalStartsAt,
          finalExpiresAt,
          enableBanner,
          req.adminId || null,
        ],
      );

      await client.query('COMMIT');
    } catch (dbError) {
      await client.query('ROLLBACK');
      throw dbError;
    } finally {
      client.release();
    }

    res.json({
      message: 'Offer banner config updated',
      offerBanner: mapOfferBannerRow(saveResult.rows[0]),
    });
  } catch (error) {
    console.error('Update offer banner config error:', error);
    res.status(500).json({ error: 'Failed to update offer banner config' });
  }
});

// ============================================
// CHAT CHARGE CONFIG ROUTES
// ============================================

// GET /api/admin/chat-charge-config
router.get('/chat-charge-config', authenticateAdmin, async (req, res) => {
  try {
    const config = await ChatChargeConfig.getActive();
    res.json({
      chatChargeConfig: {
        chargingEnabled: config.charging_enabled === true,
        freeMessageLimit: Number(config.free_message_limit),
        messageBlockSize: Number(config.message_block_size),
        chargePerMessageBlock: Number(config.charge_per_message_block),
        updatedAt: config.updated_at
      }
    });
  } catch (error) {
    console.error('Get chat charge config error:', error);
    res.status(500).json({ error: 'Failed to fetch chat charge config' });
  }
});

// PUT /api/admin/chat-charge-config
router.put('/chat-charge-config', authenticateAdmin, async (req, res) => {
  try {
    const {
      chargingEnabled,
      freeMessageLimit,
      messageBlockSize,
      chargePerMessageBlock
    } = req.body || {};

    const enabled = chargingEnabled === true;
    const freeLimit = Number(freeMessageLimit);
    const blockSize = Number(messageBlockSize);
    const chargePerBlock = Number(chargePerMessageBlock);

    if (!Number.isFinite(freeLimit) || freeLimit < 0) {
      return res.status(400).json({ error: 'freeMessageLimit must be a non-negative number' });
    }

    if (enabled) {
      if (!Number.isFinite(blockSize) || blockSize <= 0) {
        return res.status(400).json({ error: 'messageBlockSize must be a positive number' });
      }
      if (!Number.isFinite(chargePerBlock) || chargePerBlock <= 0) {
        return res.status(400).json({ error: 'chargePerMessageBlock must be a positive number' });
      }
    }

    const updated = await ChatChargeConfig.update({
      chargingEnabled: enabled,
      freeMessageLimit: freeLimit,
      messageBlockSize: enabled ? blockSize : (blockSize || 2),
      chargePerMessageBlock: enabled ? chargePerBlock : (chargePerBlock || 1.00)
    });

    res.json({
      message: 'Chat charge config updated',
      chatChargeConfig: {
        chargingEnabled: updated.charging_enabled === true,
        freeMessageLimit: Number(updated.free_message_limit),
        messageBlockSize: Number(updated.message_block_size),
        chargePerMessageBlock: Number(updated.charge_per_message_block),
        updatedAt: updated.updated_at
      }
    });
  } catch (error) {
    console.error('Update chat charge config error:', error);
    res.status(500).json({ error: 'Failed to update chat charge config' });
  }
});

// ============================================
// DASHBOARD ANALYTICS
// ============================================

// GET /api/admin/dashboard/stats
router.get('/dashboard/stats', authenticateAdmin, async (req, res) => {
  try {
    // 1. Total & Daily Active Users
    const usersRes = await pool.query(
      `SELECT 
        COUNT(*) as total_users,
        COUNT(CASE WHEN last_login > NOW() - INTERVAL '24 hours' THEN 1 END) as daily_active_users
       FROM users WHERE account_type = 'user'`
    );

    // 2. Active Listeners
    const listenersRes = await pool.query(
      `SELECT COUNT(*) as total_listeners FROM listeners WHERE is_active = TRUE AND verification_status = 'approved'`
    );

    // 3. Live Active Calls
    const activeCallsRes = await pool.query(
      `SELECT COUNT(*) as active_calls FROM calls WHERE status = 'in-progress'`
    );

    // 4. Conversion Rate (Recharged vs Total)
    const conversionRes = await pool.query(
      `SELECT 
        COUNT(CASE WHEN offer_used = TRUE THEN 1 END) as recharged_users 
       FROM users WHERE account_type = 'user'`
    );
    const totalUsers = parseInt(usersRes.rows[0].total_users) || 0;
    const rechargedUsers = parseInt(conversionRes.rows[0].recharged_users) || 0;
    const conversionRate = totalUsers > 0 ? ((rechargedUsers / totalUsers) * 100).toFixed(1) : 0;

    // 5. Pending Support Messages
    const supportRes = await pool.query(
      `SELECT COUNT(*) as pending_messages FROM contact_messages WHERE source = 'support'` // Assuming they're unread by default, or just count today's
    );

    // 6. Total Sales / Revenue (Completed Transactions)
    const salesRes = await pool.query(
      `SELECT SUM(amount) as total_sales FROM transactions WHERE status = 'completed'`
    );

    // 7. Top 5 Listeners by Calls
    const topListenersRes = await pool.query(
      `SELECT l.listener_id, l.professional_name, l.total_calls, l.average_rating 
       FROM listeners l 
       WHERE l.is_active = TRUE 
       ORDER BY l.total_calls DESC LIMIT 5`
    );

    // 8. Total OTPs Sent
    let totalOtps = 0;
    try {
      const otpRes = await pool.query(`SELECT COUNT(*) as total FROM otp_tracking`);
      totalOtps = parseInt(otpRes.rows[0].total) || 0;
    } catch(e) {
      // Ignored if table doesn't exist yet
    }

    res.json({
      total_users: totalUsers,
      total_otps: totalOtps,
      daily_active_users: parseInt(usersRes.rows[0].daily_active_users) || 0,
      total_listeners: parseInt(listenersRes.rows[0].total_listeners) || 0,
      active_calls: parseInt(activeCallsRes.rows[0].active_calls) || 0,
      conversion_rate: parseFloat(conversionRate),
      pending_support_messages: parseInt(supportRes.rows[0].pending_messages) || 0,
      total_sales: parseFloat(salesRes.rows[0].total_sales) || 0,
      top_listeners: topListenersRes.rows || []
    });

  } catch (error) {
    console.error('Fetch dashboard stats error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

export default router;
