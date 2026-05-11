import express from 'express';
import { pool } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// POST /api/account/delete-request
router.post('/delete-request', authenticate, async (req, res) => {
  try {
    const { name, email, phone, reason } = req.body || {};

    if (!req.user) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    if (!name || !reason) {
      return res.status(400).json({ error: 'Name and reason are required' });
    }

    const authProvider = String(req.user?.auth_provider || '').trim().toLowerCase();
    const usesPhoneContact = authProvider === 'phone' || authProvider === 'mobile';
    const trimmedEmail = typeof email === 'string' ? email.trim() : '';
    const trimmedPhone = typeof phone === 'string'
      ? phone.trim().replace(/\s+/g, '')
      : '';
    const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    const phoneRegex = /^\+?[0-9]{7,15}$/;

    if (!usesPhoneContact) {
      if (!trimmedEmail) {
        return res.status(400).json({ error: 'Email is required for social login users' });
      }
      if (!emailRegex.test(trimmedEmail)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }
    } else {
      if (!trimmedPhone) {
        return res.status(400).json({ error: 'Phone number is required for mobile login users' });
      }
      if (!phoneRegex.test(trimmedPhone)) {
        return res.status(400).json({ error: 'Invalid phone number' });
      }
    }

    const role = req.user?.account_type === 'listener' ? 'listener' : 'user';

    const insertQuery = `
      INSERT INTO delete_account_requests (user_id, name, email, phone, reason, role)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING request_id, user_id, name, email, phone, reason, role, status, created_at
    `;

    const result = await pool.query(insertQuery, [
      req.userId,
      String(name).trim(),
      trimmedEmail || null,
      trimmedPhone || null,
      String(reason).trim(),
      role
    ]);

    return res.status(201).json({
      message: 'Delete request submitted',
      request: result.rows[0]
    });
  } catch (error) {
    console.error('POST /api/account/delete-request error:', error);
    return res.status(500).json({ error: 'Failed to submit delete request' });
  }
});

export default router;
