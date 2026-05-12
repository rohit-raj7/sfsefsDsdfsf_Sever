import express from 'express';
import { pool } from '../db.js';
import { authenticate, authenticateAdmin } from '../middleware/auth.js';

const router = express.Router();

// GET /recharge-packs → return all active packs sorted (Authenticated User)
router.get('/', authenticate, async (req, res) => {
  try {
    const userResult = await pool.query('SELECT is_first_time_user, offer_used FROM users WHERE user_id = $1', [req.userId]);
    const user = userResult.rows[0];
    const isEligibleForFirstTimeOffer = user && user.is_first_time_user && !user.offer_used;

    let query = 'SELECT id, amount, extra_percent_or_amount, badge_text, sort_order, is_unlimited, unlimited_days, is_first_time_only FROM recharge_packs WHERE is_active = TRUE';

    if (!isEligibleForFirstTimeOffer) {
      query += ' AND is_first_time_only = FALSE';
    }

    query += ' ORDER BY sort_order ASC';

    const result = await pool.query(query);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching recharge packs:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /recharge-packs/all → return all packs including inactive (Admin only)
router.get('/all', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM recharge_packs ORDER BY sort_order ASC'
    );
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching all recharge packs:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /recharge-packs → create pack (Admin only)
router.post('/', authenticateAdmin, async (req, res) => {
  const { amount, extra_percent_or_amount, badge_text, is_active, sort_order, is_unlimited, unlimited_days, is_first_time_only } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO recharge_packs (amount, extra_percent_or_amount, badge_text, is_active, sort_order, is_unlimited, unlimited_days, is_first_time_only) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [
        amount === '' ? 0 : (amount || 0), 
        extra_percent_or_amount === '' ? 0 : (extra_percent_or_amount || 0), 
        badge_text || null, 
        is_active !== false, 
        sort_order === '' ? 0 : (sort_order || 0), 
        is_unlimited || false, 
        unlimited_days === '' ? 0 : (unlimited_days || 0), 
        is_first_time_only || false
      ]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error creating recharge pack:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /recharge-packs/:id → update pack (Admin only)
router.put('/:id', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  const { amount, extra_percent_or_amount, badge_text, is_active, sort_order, is_unlimited, unlimited_days, is_first_time_only } = req.body;
  try {
    const result = await pool.query(
      'UPDATE recharge_packs SET amount = $1, extra_percent_or_amount = $2, badge_text = $3, is_active = $4, sort_order = $5, is_unlimited = $6, unlimited_days = $7, is_first_time_only = $8, updated_at = CURRENT_TIMESTAMP WHERE id = $9 RETURNING *',
      [
        amount === '' ? 0 : (amount || 0), 
        extra_percent_or_amount === '' ? 0 : (extra_percent_or_amount || 0), 
        badge_text || null, 
        is_active !== false, 
        sort_order === '' ? 0 : (sort_order || 0), 
        is_unlimited || false, 
        unlimited_days === '' ? 0 : (unlimited_days || 0), 
        is_first_time_only || false, 
        id
      ]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Pack not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error updating recharge pack:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// DELETE /recharge-packs/:id → disable pack (Admin only)
// Note: We use soft delete by setting is_active to false
router.delete('/:id', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'UPDATE recharge_packs SET is_active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Pack not found' });
    }
    res.json({ success: true, message: 'Pack disabled successfully' });
  } catch (error) {
    console.error('Error disabling recharge pack:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

export default router;
