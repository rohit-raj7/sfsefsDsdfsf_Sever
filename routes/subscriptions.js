import express from 'express';
const router = express.Router();
import { pool } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const FREE_RANDOM_CALL_LIMIT = 9999;

const getRandomCallUsage = async (userId) => {
    const userResult = await pool.query(
        `SELECT
           CASE
             WHEN last_random_call_date = CURRENT_DATE THEN COALESCE(random_calls_today, 0)
             ELSE 0
           END AS calls_today
         FROM users
         WHERE user_id = $1`,
        [userId]
    );
    return Number(userResult.rows[0]?.calls_today || 0);
};

const consumeRandomCallUsage = async (userId) => {
    const updateResult = await pool.query(
        `UPDATE users
         SET random_calls_today = CASE
               WHEN last_random_call_date = CURRENT_DATE THEN COALESCE(random_calls_today, 0) + 1
               ELSE 1
             END,
             last_random_call_date = CURRENT_DATE
         WHERE user_id = $1
         RETURNING random_calls_today`,
        [userId]
    );
    return Number(updateResult.rows[0]?.random_calls_today || 0);
};

// GET /api/subscriptions/status
// Check if user has an active premium subscription
router.get('/status', authenticate, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT subscription_id, plan_type, price, starts_at, expires_at, is_active
       FROM subscriptions
       WHERE user_id = $1 AND is_active = TRUE AND expires_at > CURRENT_TIMESTAMP
       ORDER BY expires_at DESC
       LIMIT 1`,
            [req.userId]
        );

        if (result.rows.length > 0) {
            const sub = result.rows[0];
            return res.json({
                success: true,
                isPremium: true,
                subscription: {
                    subscriptionId: sub.subscription_id,
                    planType: sub.plan_type,
                    price: Number(sub.price),
                    startsAt: sub.starts_at,
                    expiresAt: sub.expires_at,
                }
            });
        }

        // Also return daily random call usage for free users
        const callsToday = await getRandomCallUsage(req.userId);

        return res.json({
            success: true,
            isPremium: false,
            freeCallsUsed: callsToday,
            freeCallsLimit: FREE_RANDOM_CALL_LIMIT,
            maxFreeCallMinutes: 3,
        });
    } catch (error) {
        console.error('Subscription status error:', error);
        res.status(500).json({ error: 'Failed to check subscription status' });
    }
});

// POST /api/subscriptions/purchase
// Purchase ₹999/year premium subscription (deducted from wallet balance)
router.post('/purchase', authenticate, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const subscriptionPrice = 999;

        // Check wallet balance
        const walletResult = await client.query(
            `SELECT wallet_balance FROM users WHERE user_id = $1 FOR UPDATE`,
            [req.userId]
        );

        if (walletResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }

        const currentBalance = Number(walletResult.rows[0].wallet_balance || 0);
        if (currentBalance < subscriptionPrice) {
            await client.query('ROLLBACK');
            return res.status(402).json({
                error: 'Insufficient balance',
                details: `You need ₹${subscriptionPrice} in your wallet. Current balance: ₹${currentBalance.toFixed(2)}`
            });
        }

        // Check if already has an active subscription
        const existingSub = await client.query(
            `SELECT subscription_id, expires_at FROM subscriptions
       WHERE user_id = $1 AND is_active = TRUE AND expires_at > CURRENT_TIMESTAMP
       ORDER BY expires_at DESC LIMIT 1`,
            [req.userId]
        );

        let expiresAt;
        if (existingSub.rows.length > 0) {
            // Extend from current expiry
            expiresAt = new Date(existingSub.rows[0].expires_at);
            expiresAt.setFullYear(expiresAt.getFullYear() + 1);
        } else {
            // New subscription starts now
            expiresAt = new Date();
            expiresAt.setFullYear(expiresAt.getFullYear() + 1);
        }

        // Deduct from wallet
        await client.query(
            `UPDATE users SET wallet_balance = wallet_balance - $1 WHERE user_id = $2`,
            [subscriptionPrice, req.userId]
        );

        // Also update wallets table if exists
        await client.query(
            `UPDATE wallets SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2`,
            [subscriptionPrice, req.userId]
        );

        // Create subscription
        const subResult = await client.query(
            `INSERT INTO subscriptions (user_id, plan_type, price, starts_at, expires_at, is_active)
       VALUES ($1, 'random_premium', $2, CURRENT_TIMESTAMP, $3, TRUE)
       RETURNING *`,
            [req.userId, subscriptionPrice, expiresAt.toISOString()]
        );

        // Log transaction
        await client.query(
            `INSERT INTO transactions (user_id, transaction_type, amount, currency, description, status)
       VALUES ($1, 'debit', $2, 'INR', $3, 'completed')`,
            [req.userId, subscriptionPrice, 'Random Premium Subscription (₹999/year)']
        );

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Subscription activated!',
            subscription: subResult.rows[0]
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Subscription purchase error:', error);
        res.status(500).json({ error: 'Failed to purchase subscription' });
    } finally {
        client.release();
    }
});

// POST /api/subscriptions/check-random-call
// Check if user can make a random call (gating logic)
router.post('/check-random-call', authenticate, async (req, res) => {
    try {
        // Check premium status
        const subResult = await pool.query(
            `SELECT subscription_id FROM subscriptions
       WHERE user_id = $1 AND is_active = TRUE AND expires_at > CURRENT_TIMESTAMP
       LIMIT 1`,
            [req.userId]
        );

        if (subResult.rows.length > 0) {
            // Premium user — unlimited, no ads, gender filter allowed
            return res.json({
                allowed: true,
                isPremium: true,
                adRequired: false,
                maxMinutes: null, // unlimited
                filtersEnabled: true,
            });
        }

        // Free user — check daily limit
        const callsToday = await getRandomCallUsage(req.userId);
        const nextCallCount = callsToday + 1;
        // Show ad on the 1st call and then every 5th call (e.g., 1, 5, 10, 15...)
        const adRequired = (nextCallCount % 5 === 0);

        return res.json({
            allowed: true,
            isPremium: false,
            adRequired: adRequired,
            maxMinutes: null, // Unlimited minutes for random call
            filtersEnabled: false,
            freeCallsUsed: callsToday,
            nextFreeCallsUsed: nextCallCount,
            freeCallsLimit: FREE_RANDOM_CALL_LIMIT,
            consumed: false,
        });
    } catch (error) {
        console.error('Check random call error:', error);
        res.status(500).json({ error: 'Failed to check random call eligibility' });
    }
});

// POST /api/subscriptions/consume-random-call
// Consume one free random-call slot when an actual match/call is started.
router.post('/consume-random-call', authenticate, async (req, res) => {
    try {
        const subResult = await pool.query(
            `SELECT subscription_id FROM subscriptions
       WHERE user_id = $1 AND is_active = TRUE AND expires_at > CURRENT_TIMESTAMP
       LIMIT 1`,
            [req.userId]
        );

        if (subResult.rows.length > 0) {
            return res.json({
                allowed: true,
                isPremium: true,
                consumed: false,
                freeCallsUsed: null,
                freeCallsLimit: null,
            });
        }

        const currentCallCount = await consumeRandomCallUsage(req.userId);
        return res.json({
            allowed: true,
            isPremium: false,
            consumed: true,
            freeCallsUsed: currentCallCount,
            freeCallsLimit: FREE_RANDOM_CALL_LIMIT,
        });
    } catch (error) {
        console.error('Consume random call error:', error);
        res.status(500).json({ error: 'Failed to consume random call eligibility' });
    }
});

export default router;
