import express from 'express';
const router = express.Router();
import { pool } from '../db.js';
import { authenticate } from '../middleware/auth.js';

// POST /api/reports
// Submit a post-call report against a listener
router.post('/', authenticate, async (req, res) => {
    try {
        const { listener_id, call_id, report_type, description } = req.body;

        if (!listener_id || !report_type) {
            return res.status(400).json({ error: 'listener_id and report_type are required' });
        }

        const validTypes = ['silent', 'rude', 'fake', 'boring'];
        if (!validTypes.includes(report_type)) {
            return res.status(400).json({ error: `report_type must be one of: ${validTypes.join(', ')}` });
        }

        // Check for duplicate report on same call
        if (call_id) {
            const existing = await pool.query(
                `SELECT report_id FROM listener_reports WHERE call_id = $1 AND reporter_user_id = $2`,
                [call_id, req.userId]
            );
            if (existing.rows.length > 0) {
                return res.status(409).json({ error: 'You already reported this call' });
            }
        }

        // Insert report
        const reportResult = await pool.query(
            `INSERT INTO listener_reports (listener_id, reporter_user_id, call_id, report_type, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
            [listener_id, req.userId, call_id || null, report_type, description || null]
        );

        // Count total unreviewed reports for this listener in last 30 days
        const countResult = await pool.query(
            `SELECT COUNT(*) as report_count FROM listener_reports
       WHERE listener_id = $1 AND created_at > CURRENT_TIMESTAMP - INTERVAL '30 days'`,
            [listener_id]
        );
        const reportCount = Number(countResult.rows[0].report_count);

        // Auto-apply strikes based on report count thresholds
        let strikeApplied = false;
        let actionTaken = 'report_recorded';

        if (reportCount >= 3) {
            // Every 3 reports = 1 strike
            const strikeResult = await pool.query(
                `UPDATE listeners
         SET strike_count = strike_count + 1,
             updated_at = CURRENT_TIMESTAMP
         WHERE listener_id = $1
         RETURNING strike_count`,
                [listener_id]
            );

            const newStrikeCount = strikeResult.rows[0]?.strike_count || 0;
            strikeApplied = true;

            // Mark report as strike-applied
            await pool.query(
                `UPDATE listener_reports SET strike_applied = TRUE WHERE report_id = $1`,
                [reportResult.rows[0].report_id]
            );

            // Apply strike consequences
            if (newStrikeCount >= 3) {
                // Strike 3 → Permanent ban
                await pool.query(
                    `UPDATE listeners SET quality_status = 'banned', is_active = FALSE,
           suspension_reason = 'Permanently banned: 3 strikes from user reports'
           WHERE listener_id = $1`,
                    [listener_id]
                );
                actionTaken = 'banned';
                console.log(`[STRIKES] Listener ${listener_id} BANNED (3 strikes)`);
            } else if (newStrikeCount === 2) {
                // Strike 2 → Hidden 24 hours
                const suspendedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
                await pool.query(
                    `UPDATE listeners SET quality_status = 'suspended', is_active = FALSE,
           suspended_until = $1,
           suspension_reason = 'Suspended 24h: Strike 2 from user reports'
           WHERE listener_id = $2`,
                    [suspendedUntil.toISOString(), listener_id]
                );
                actionTaken = 'suspended_24h';
                console.log(`[STRIKES] Listener ${listener_id} SUSPENDED 24h (strike 2)`);
            } else if (newStrikeCount === 1) {
                // Strike 1 → Warning
                await pool.query(
                    `UPDATE listeners SET quality_status = 'warning',
           warning_reason = 'Strike 1: User reports received'
           WHERE listener_id = $1`,
                    [listener_id]
                );
                actionTaken = 'warning';
                console.log(`[STRIKES] Listener ${listener_id} WARNING (strike 1)`);
            }

            // Reset report count for this listener (reports consumed into strike)
            await pool.query(
                `UPDATE listener_reports SET reviewed = TRUE
         WHERE listener_id = $1 AND reviewed = FALSE`,
                [listener_id]
            );
        }

        res.json({
            success: true,
            message: 'Report submitted',
            report: reportResult.rows[0],
            strikeApplied,
            actionTaken,
        });
    } catch (error) {
        console.error('Submit report error:', error);
        res.status(500).json({ error: 'Failed to submit report' });
    }
});

// GET /api/reports/listener/:listener_id
// Get reports for a listener (admin use)
router.get('/listener/:listener_id', authenticate, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT r.*, u.display_name as reporter_name
       FROM listener_reports r
       LEFT JOIN users u ON r.reporter_user_id = u.user_id
       WHERE r.listener_id = $1
       ORDER BY r.created_at DESC
       LIMIT 50`,
            [req.params.listener_id]
        );

        // Get strike summary
        const strikeResult = await pool.query(
            `SELECT strike_count, quality_status, warning_reason, suspension_reason, suspended_until
       FROM listeners WHERE listener_id = $1`,
            [req.params.listener_id]
        );

        res.json({
            success: true,
            reports: result.rows,
            listener: strikeResult.rows[0] || null,
        });
    } catch (error) {
        console.error('Get reports error:', error);
        res.status(500).json({ error: 'Failed to fetch reports' });
    }
});

export default router;
