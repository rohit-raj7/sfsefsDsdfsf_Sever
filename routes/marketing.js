import express from 'express';
import { pool } from '../db.js';
import { authenticateAdmin } from '../middleware/auth.js';
import NotificationOutbox from '../models/NotificationOutbox.js';
import { triggerNotificationProcessing } from '../services/notificationWorker.js';

const router = express.Router();

// GET /api/marketing/newbies
// Get all users who have not recharged (offer_used = false)
router.get('/newbies', authenticateAdmin, async (req, res) => {
    try {
        const query = `
      SELECT
        u.user_id,
        u.display_name,
        COALESCE(u.mobile_number, u.phone_number) AS phone_number,
        u.email,
        u.created_at
      FROM users u
      LEFT JOIN wallets w ON u.user_id = w.user_id
      WHERE u.account_type = 'user'
        AND u.is_active = TRUE
        AND u.offer_used = FALSE
      ORDER BY u.created_at DESC
    `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (error) {
        console.error('Fetch newbies error:', error);
        res.status(500).json({ error: 'Failed to fetch newbies' });
    }
});

// POST /api/marketing/send-notification
router.post('/send-notification', authenticateAdmin, async (req, res) => {
    try {
        const { title, body } = req.body;

        if (!title || !body) {
            return res.status(400).json({ error: 'Title and body are required' });
        }

        const audienceQuery = `
      SELECT user_id
      FROM users u
      WHERE u.account_type = 'user'
        AND u.is_active = TRUE
        AND u.offer_used = FALSE
    `;
        const result = await pool.query(audienceQuery);
        const targetUserIds = result.rows
            .map((row) => row.user_id)
            .filter(Boolean);

        if (targetUserIds.length === 0) {
            return res.json({
                message: 'No eligible users found for this campaign.',
                eligible_users: 0,
                successCount: 0
            });
        }

        const outbox = await NotificationOutbox.create({
            title: String(title).trim(),
            body: String(body).trim(),
            target_role: 'USER',
            target_user_ids: targetUserIds,
            schedule_at: null,
            repeat_interval: null,
            created_by: req.adminId
        });

        triggerNotificationProcessing('marketing');

        res.json({
            message: 'Marketing notification queued for delivery.',
            eligible_users: targetUserIds.length,
            successCount: targetUserIds.length,
            outbox
        });
    } catch (error) {
        console.error('Marketing Send Notification Error:', error);
        res.status(500).json({ error: 'Failed to process notification request' });
    }
});

export default router;
