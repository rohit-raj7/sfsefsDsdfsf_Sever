import express from 'express';
import { pool } from '../db.js';
import NotificationOutbox from '../models/NotificationOutbox.js';
import { authenticate, authenticateAdmin } from '../middleware/auth.js';
import {
  processNotifications,
  scheduleOutboxProcessing,
  unscheduleOutboxProcessing,
} from '../services/notificationWorker.js';

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

function normalizeScheduleAt(scheduleAt) {
  if (!scheduleAt) return null;
  const parsed = new Date(scheduleAt);
  if (Number.isNaN(parsed.getTime())) {
    return { error: 'Invalid scheduleAt value' };
  }
  return { value: parsed.toISOString() };
}

router.get('/outbox', authenticateAdmin, async (req, res) => {
  try {
    const { status, targetRole, page = 1, limit = 50 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const conds = [];
    const params = [];
    let idx = 1;
    if (status) {
      conds.push(`status = $${idx++}`);
      params.push(String(status).toUpperCase());
    }
    if (targetRole) {
      conds.push(`target_role = $${idx++}`);
      params.push(String(targetRole).toUpperCase());
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const q = `
      SELECT id, title, body, target_role, target_user_ids, schedule_at, repeat_interval, repeat_days, random_enabled, random_start_time, random_end_time, status, created_at, delivered_at, retry_count, last_error, delivered_count, language_filter
      FROM notification_outbox
      ${where}
      ORDER BY created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;
    params.push(Number(limit), offset);
    const r = await pool.query(q, params);
    res.json({ outbox: r.rows });
  } catch (error) {
    console.error('GET /outbox error:', error);
    res.status(500).json({ error: 'Failed to fetch outbox' });
  }
});

router.post('/outbox', authenticateAdmin, async (req, res) => {
  try {
    const { title, body, targetRole, targetUserIds, scheduleAt, repeatInterval, languageFilter } = req.body;
    if (!title || !body || !targetRole) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (targetRole !== 'USER' && targetRole !== 'LISTENER') {
      return res.status(400).json({ error: 'Invalid targetRole' });
    }
    if (repeatInterval && repeatInterval !== 'daily' && repeatInterval !== 'weekly') {
      return res.status(400).json({ error: 'Invalid repeatInterval (must be daily or weekly)' });
    }
    if (repeatInterval && !scheduleAt) {
      return res.status(400).json({ error: 'scheduleAt is required when repeatInterval is set' });
    }
    if (Array.isArray(targetUserIds) && targetUserIds.length > 10000) {
      return res.status(400).json({ error: 'targetUserIds cannot exceed 10,000 entries. Use "all" targeting instead.' });
    }
    const normalizedScheduleAt = normalizeScheduleAt(scheduleAt);
    if (normalizedScheduleAt?.error) {
      return res.status(400).json({ error: normalizedScheduleAt.error });
    }

    // Validation: Check if any users/listeners exist for the selected language
    if (languageFilter) {
      const aliases = getLanguageAliases(languageFilter);
      let count = 0;
      const hasTargetIds = Array.isArray(targetUserIds) && targetUserIds.length > 0;
      if (targetRole === 'USER') {
        let checkQuery = `
          SELECT COUNT(*)::int AS count
          FROM users u
          WHERE u.is_active = TRUE
            AND u.account_type = 'user'
            AND (
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
            )
        `;
        const params = [aliases];
        if (hasTargetIds) {
          checkQuery += ` AND u.user_id = ANY($2::uuid[])`;
          params.push(targetUserIds);
        }
        const checkRes = await pool.query(checkQuery, params);
        count = checkRes.rows[0]?.count || 0;
      } else if (targetRole === 'LISTENER') {
        let checkQuery = `
          SELECT COUNT(*)::int AS count
          FROM users u
          LEFT JOIN listeners l ON l.user_id = u.user_id
          WHERE u.is_active = TRUE
            AND u.account_type = 'listener'
            AND (
              EXISTS (
                SELECT 1 FROM unnest(l.languages) AS lang
                WHERE LOWER(BTRIM(lang)) = ANY($1::text[])
              ) OR EXISTS (
                SELECT 1 FROM user_languages ul
                WHERE ul.user_id = u.user_id
                  AND LOWER(BTRIM(ul.language)) = ANY($1::text[])
              )
            )
        `;
        const params = [aliases];
        if (hasTargetIds) {
          checkQuery += ` AND (u.user_id = ANY($2::uuid[]) OR l.listener_id = ANY($2::uuid[]))`;
          params.push(targetUserIds);
        }
        const checkRes = await pool.query(checkQuery, params);
        count = checkRes.rows[0]?.count || 0;
      }
      if (count === 0) {
        return res.status(400).json({
          error: `No users found matching the selected language: ${languageFilter}`
        });
      }
    }

    const created = await NotificationOutbox.create({
      title,
      body,
      target_role: targetRole,
      target_user_ids: Array.isArray(targetUserIds) && targetUserIds.length ? targetUserIds : null,
      schedule_at: normalizedScheduleAt?.value || null,
      repeat_interval: repeatInterval || null,
      created_by: req.adminId,
      language_filter: languageFilter || null
    });
    let outbox = created;
    if (shouldProcessImmediately(created.schedule_at)) {
      await processNotifications();
      const latest = await pool.query(
        `SELECT id, title, body, target_role, target_user_ids, schedule_at, repeat_interval, repeat_days, random_enabled, random_start_time, random_end_time, status, created_at, delivered_at, retry_count, last_error, language_filter
         FROM notification_outbox
         WHERE id = $1`,
        [created.id]
      );
      outbox = latest.rows[0] ?? created;
    } else {
      scheduleOutboxProcessing(created);
    }
    res.json({
      message: shouldProcessImmediately(created.schedule_at)
        ? 'Notification sent'
        : 'Notification scheduled',
      outbox
    });
  } catch (error) {
    console.error('POST /outbox error:', error);
    res.status(500).json({ error: 'Failed to schedule notification' });
  }
});

router.put('/outbox/:id', authenticateAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const exists = await pool.query(
      `SELECT id, status, schedule_at, repeat_interval, repeat_days, random_enabled, random_start_time, random_end_time, target_role, target_user_ids, language_filter FROM notification_outbox WHERE id = $1`,
      [id]
    );
    if (!exists.rows.length) {
      return res.status(404).json({ error: 'Outbox item not found' });
    }
    const { title, body, targetRole, targetUserIds, scheduleAt, repeatInterval, languageFilter } = req.body;
    const normalizedScheduleAt = scheduleAt !== undefined ? normalizeScheduleAt(scheduleAt) : null;
    if (normalizedScheduleAt?.error) {
      return res.status(400).json({ error: normalizedScheduleAt.error });
    }

    const finalTargetRole = targetRole !== undefined ? targetRole : exists.rows[0].target_role;
    const finalTargetUserIds = targetUserIds !== undefined
      ? (Array.isArray(targetUserIds) && targetUserIds.length ? targetUserIds : null)
      : exists.rows[0].target_user_ids;
    const finalLanguageFilter = languageFilter !== undefined ? languageFilter : exists.rows[0].language_filter;

    // Validation: Check if any users/listeners exist for the selected language
    if (finalLanguageFilter) {
      const aliases = getLanguageAliases(finalLanguageFilter);
      let count = 0;
      const hasTargetIds = Array.isArray(finalTargetUserIds) && finalTargetUserIds.length > 0;
      if (finalTargetRole === 'USER') {
        let checkQuery = `
          SELECT COUNT(*)::int AS count
          FROM users u
          WHERE u.is_active = TRUE
            AND u.account_type = 'user'
            AND (
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
            )
        `;
        const params = [aliases];
        if (hasTargetIds) {
          checkQuery += ` AND u.user_id = ANY($2::uuid[])`;
          params.push(finalTargetUserIds);
        }
        const checkRes = await pool.query(checkQuery, params);
        count = checkRes.rows[0]?.count || 0;
      } else if (finalTargetRole === 'LISTENER') {
        let checkQuery = `
          SELECT COUNT(*)::int AS count
          FROM users u
          LEFT JOIN listeners l ON l.user_id = u.user_id
          WHERE u.is_active = TRUE
            AND u.account_type = 'listener'
            AND (
              EXISTS (
                SELECT 1 FROM unnest(l.languages) AS lang
                WHERE LOWER(BTRIM(lang)) = ANY($1::text[])
              ) OR EXISTS (
                SELECT 1 FROM user_languages ul
                WHERE ul.user_id = u.user_id
                  AND LOWER(BTRIM(ul.language)) = ANY($1::text[])
              )
            )
        `;
        const params = [aliases];
        if (hasTargetIds) {
          checkQuery += ` AND (u.user_id = ANY($2::uuid[]) OR l.listener_id = ANY($2::uuid[]))`;
          params.push(finalTargetUserIds);
        }
        const checkRes = await pool.query(checkQuery, params);
        count = checkRes.rows[0]?.count || 0;
      }
      if (count === 0) {
        return res.status(400).json({
          error: `No users found matching the selected language: ${finalLanguageFilter}`
        });
      }
    }

    const updates = [];
    const params = [];
    let idx = 1;
    // Reset status to PENDING so the notification will be re-processed
    updates.push(`status = $${idx++}`);
    params.push('PENDING');
    updates.push(`delivered_at = NULL`);
    if (title !== undefined) {
      updates.push(`title = $${idx++}`);
      params.push(title);
    }
    if (body !== undefined) {
      updates.push(`body = $${idx++}`);
      params.push(body);
    }
    if (targetRole !== undefined) {
      if (targetRole !== 'USER' && targetRole !== 'LISTENER') {
        return res.status(400).json({ error: 'Invalid targetRole' });
      }
      updates.push(`target_role = $${idx++}`);
      params.push(targetRole);
    }
    if (targetUserIds !== undefined) {
      updates.push(`target_user_ids = $${idx++}`);
      params.push(Array.isArray(targetUserIds) && targetUserIds.length ? targetUserIds : null);
    }
    if (scheduleAt !== undefined) {
      updates.push(`schedule_at = $${idx++}`);
      params.push(normalizedScheduleAt?.value || null);
    }
    if (repeatInterval !== undefined) {
      if (repeatInterval && repeatInterval !== 'daily' && repeatInterval !== 'weekly') {
        return res.status(400).json({ error: 'Invalid repeatInterval (must be daily or weekly)' });
      }
      updates.push(`repeat_interval = $${idx++}`);
      params.push(repeatInterval || null);
    }
    if (languageFilter !== undefined) {
      updates.push(`language_filter = $${idx++}`);
      params.push(languageFilter || null);
    }
    const nextScheduleAt = scheduleAt !== undefined
      ? (normalizedScheduleAt?.value || null)
      : exists.rows[0].schedule_at ?? null;
    const nextRepeatInterval = repeatInterval !== undefined
      ? (repeatInterval || null)
      : exists.rows[0].repeat_interval ?? null;
    if (nextRepeatInterval && !nextScheduleAt) {
      return res.status(400).json({ error: 'scheduleAt is required when repeatInterval is set' });
    }
    if (!updates.length) {
      return res.json({ message: 'No changes' });
    }
    params.push(id);
    const q = `
      UPDATE notification_outbox
      SET ${updates.join(', ')}, retry_count = 0, last_error = NULL
      WHERE id = $${idx}
      RETURNING id, title, body, target_role, target_user_ids, schedule_at, repeat_interval, repeat_days, random_enabled, random_start_time, random_end_time, status, created_at, language_filter
    `;
    const r = await pool.query(q, params);
    let outbox = r.rows[0];
    if (outbox && shouldProcessImmediately(outbox.schedule_at)) {
      await processNotifications();
      const latest = await pool.query(
        `SELECT id, title, body, target_role, target_user_ids, schedule_at, repeat_interval, repeat_days, random_enabled, random_start_time, random_end_time, status, created_at, delivered_at, retry_count, last_error, language_filter
         FROM notification_outbox
         WHERE id = $1`,
        [outbox.id]
      );
      outbox = latest.rows[0] ?? outbox;
    } else if (outbox) {
      scheduleOutboxProcessing(outbox);
    }
    res.json({
      message: outbox && shouldProcessImmediately(outbox.schedule_at)
        ? 'Notification updated and sent'
        : 'Notification updated',
      outbox
    });
  } catch (error) {
    console.error('PUT /outbox/:id error:', error);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

router.delete('/outbox/:id', authenticateAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const exists = await pool.query(
      `SELECT id, status FROM notification_outbox WHERE id = $1`,
      [id]
    );
    if (!exists.rows.length) {
      return res.status(404).json({ error: 'Outbox item not found' });
    }
    unscheduleOutboxProcessing(id);
    // Delete associated deliveries first to avoid FK constraint errors
    await pool.query(`DELETE FROM notification_deliveries WHERE outbox_id = $1`, [id]);
    await pool.query(`DELETE FROM notification_outbox WHERE id = $1`, [id]);
    res.json({ message: 'Notification deleted', id });
  } catch (error) {
    console.error('DELETE /outbox/:id error:', error);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

router.get('/my', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const q = `
      SELECT notification_id as id, title, message as body, notification_type, is_read, data, created_at
      FROM notifications
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `;
    const rows = await pool.query(q, [req.userId, Number(limit), offset]);
    res.json({ notifications: rows.rows });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

router.post('/mark-read', authenticate, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    const q = `
      UPDATE notifications
      SET is_read = TRUE
      WHERE notification_id = $1 AND user_id = $2
      RETURNING notification_id
    `;
    const r = await pool.query(q, [id, req.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ id: r.rows[0].notification_id });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

router.get('/unread-count', authenticate, async (req, res) => {
  try {
    const q = `
      SELECT COUNT(*)::int AS count
      FROM notifications
      WHERE user_id = $1 AND is_read = FALSE
    `;
    const r = await pool.query(q, [req.userId]);
    res.json({ count: r.rows[0].count });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

export default router;
