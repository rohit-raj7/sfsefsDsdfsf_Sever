import express from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import config from '../config/config.js';
import User from '../models/User.js';

const router = express.Router();

const allowedSources = new Set(['contact', 'support']);

async function optionalAuth(req, _res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    if (decoded && decoded.user_id) {
      const user = await User.findById(decoded.user_id);
      if (user && user.is_active) {
        req.userId = user.user_id;
      }
    }
  } catch (error) {
    // Ignore invalid tokens for optional auth
  }

  return next();
}

// POST /api/contacts
router.post('/', optionalAuth, async (req, res) => {
  try {
    const { name, email, message, source } = req.body || {};
    const normalizedSource = typeof source === 'string' ? source.trim().toLowerCase() : 'contact';

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message are required' });
    }

    if (!allowedSources.has(normalizedSource)) {
      return res.status(400).json({ error: 'Invalid source (contact or support)' });
    }

    const insertQuery = `
      INSERT INTO contact_messages (source, name, email, message, user_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING contact_id, source, name, email, message, user_id, created_at
    `;

    const result = await pool.query(insertQuery, [
      normalizedSource,
      String(name).trim(),
      String(email).trim(),
      String(message).trim(),
      req.userId || null
    ]);

    return res.status(201).json({
      message: 'Contact message received',
      contact: result.rows[0]
    });
  } catch (error) {
    console.error('POST /api/contacts error:', error);
    return res.status(500).json({ error: 'Failed to save contact message' });
  }
});

export default router;
