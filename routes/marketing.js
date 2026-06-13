import express from 'express';
import { pool } from '../db.js';
import { authenticateAdmin } from '../middleware/auth.js';
import NotificationOutbox from '../models/NotificationOutbox.js';
import { processNotifications, scheduleOutboxProcessing } from '../services/notificationWorker.js';

const router = express.Router();

function getLanguageAliases(language) {
  if (!language) return [];
  const normalized = String(language).trim().toLowerCase();
  const aliasMap = {
    'hindi': ['hi', 'hindi'],
    'bhogpuri': ['bh', 'bho', 'bhojpuri', 'bhogpuri'],
    'bhojpuri': ['bh', 'bho', 'bhojpuri', 'bhogpuri'],
    'bengali': ['bn', 'bangla', 'bengali'],
    'bangla': ['bn', 'bangla', 'bengali'],
    'telugu': ['te', 'telugu'],
    'marathi': ['mr', 'marathi'],
    'tamil': ['ta', 'tamil'],
    'gujarati': ['gu', 'gujarati'],
    'kannada': ['kn', 'kannada'],
    'malayalam': ['ml', 'malayalam'],
    'punjabi': ['pa', 'punjabi']
  };
  return aliasMap[normalized] || [normalized];
}

function shouldProcessImmediately(scheduleAt) {
  if (!scheduleAt) return true;
  const parsed = new Date(scheduleAt);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.getTime() <= Date.now();
}

// GET /api/marketing/newbies
// Get all users who have not recharged (offer_used = false), with optional language filter
router.get('/newbies', authenticateAdmin, async (req, res) => {
  try {
    const { language } = req.query;
    const aliases = language ? getLanguageAliases(language) : null;

    let query = `
      SELECT
        u.user_id,
        u.display_name,
        COALESCE(u.mobile_number, u.phone_number) AS phone_number,
        u.email,
        u.created_at
      FROM users u
      WHERE u.account_type = 'user'
        AND u.is_active = TRUE
        AND u.offer_used = FALSE
    `;
    const params = [];

    if (aliases && aliases.length > 0) {
      params.push(aliases);
      query += ` AND (
        EXISTS (
          SELECT 1 FROM user_languages ul
          WHERE ul.user_id = u.user_id
            AND LOWER(BTRIM(ul.language)) = ANY($1::text[])
        ) OR (
          u.languages IS NOT NULL AND EXISTS (
            SELECT 1 FROM unnest(u.languages) AS lang
            WHERE LOWER(BTRIM(lang)) = ANY($1::text[])
          )
        )
      )`;
    }

    query += ` ORDER BY u.created_at DESC`;
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Fetch newbies error:', error);
    res.status(500).json({ error: 'Failed to fetch newbies' });
  }
});

// GET /api/marketing/campaigns
// List scheduled marketing campaigns (schedule_at IS NOT NULL) from notification_outbox
router.get('/campaigns', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const result = await pool.query(
      `SELECT id, title, body, target_role, target_user_ids, schedule_at, repeat_interval,
              status, created_at, delivered_at, retry_count, last_error, delivered_count, language_filter
       FROM notification_outbox
       WHERE target_role = 'USER'
         AND schedule_at IS NOT NULL
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [Number(limit), offset]
    );
    res.json({ campaigns: result.rows });
  } catch (error) {
    console.error('Fetch marketing campaigns error:', error);
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

// POST /api/marketing/send-notification
// Send (or schedule) a marketing campaign to newbie users
router.post('/send-notification', authenticateAdmin, async (req, res) => {
  try {
    const { title, body, scheduleAt, languageFilter } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: 'Title and body are required' });
    }

    // Validate scheduleAt if provided
    let normalizedScheduleAt = null;
    if (scheduleAt) {
      const parsed = new Date(scheduleAt);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ error: 'Invalid scheduleAt value' });
      }
      normalizedScheduleAt = parsed.toISOString();
    }

    // Build audience query with optional language filter
    const aliases = languageFilter ? getLanguageAliases(languageFilter) : null;
    let audienceQuery = `
      SELECT user_id
      FROM users u
      WHERE u.account_type = 'user'
        AND u.is_active = TRUE
        AND u.offer_used = FALSE
    `;
    const audienceParams = [];

    if (aliases && aliases.length > 0) {
      audienceParams.push(aliases);
      audienceQuery += ` AND (
        EXISTS (
          SELECT 1 FROM user_languages ul
          WHERE ul.user_id = u.user_id
            AND LOWER(BTRIM(ul.language)) = ANY($1::text[])
        ) OR (
          u.languages IS NOT NULL AND EXISTS (
            SELECT 1 FROM unnest(u.languages) AS lang
            WHERE LOWER(BTRIM(lang)) = ANY($1::text[])
          )
        )
      )`;
    }

    const result = await pool.query(audienceQuery, audienceParams);
    const targetUserIds = result.rows.map((row) => row.user_id).filter(Boolean);

    if (targetUserIds.length === 0) {
      return res.status(400).json({
        error: languageFilter
          ? `No eligible newbie users found for language: ${languageFilter}`
          : 'No eligible newbie users found for this campaign.',
        eligible_users: 0
      });
    }

    const outbox = await NotificationOutbox.create({
      title: String(title).trim(),
      body: String(body).trim(),
      target_role: 'USER',
      target_user_ids: targetUserIds,
      schedule_at: normalizedScheduleAt,
      repeat_interval: null,
      created_by: req.adminId,
      language_filter: languageFilter || null
    });

    const isImmediate = shouldProcessImmediately(outbox.schedule_at);
    if (isImmediate) {
      await processNotifications();
    } else {
      scheduleOutboxProcessing(outbox);
    }

    res.json({
      message: isImmediate
        ? 'Marketing notification sent successfully.'
        : `Campaign scheduled for ${new Date(normalizedScheduleAt).toLocaleString()}.`,
      eligible_users: targetUserIds.length,
      successCount: isImmediate ? targetUserIds.length : 0,
      scheduled: !isImmediate,
      outbox
    });
  } catch (error) {
    console.error('Marketing Send Notification Error:', error);
    res.status(500).json({ error: 'Failed to process notification request' });
  }
});

export default router;
