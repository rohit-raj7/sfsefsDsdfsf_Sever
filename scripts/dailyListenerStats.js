import { pool } from '../db.js';

async function runDailyStats() {
    console.log('--- Starting Daily Listener Stats & Streak Calculation ---');
    try {
        const todayResult = await pool.query("SELECT CURRENT_DATE as today");
        const today = todayResult.rows[0].today;

        console.log(`Processing stats for date prior to: ${today}`);

        // Get all active listeners
        const listenersResult = await pool.query(
            `SELECT listener_id, daily_streak_days, last_streak_date 
       FROM listeners WHERE is_active = TRUE`
        );

        let streakMaintainedCount = 0;
        let streakLostCount = 0;

        for (const listener of listenersResult.rows) {
            const { listener_id, daily_streak_days = 0, last_streak_date } = listener;

            // Calculate stats for yesterday
            // (Using >= yesterday 00:00:00 AND < today 00:00:00)
            const statsQuery = `
        SELECT 
          COUNT(*) as daily_calls,
          SUM(duration_seconds) as total_seconds
        FROM calls
        WHERE listener_id = $1
          AND status = 'completed'
          AND started_at >= CURRENT_DATE - INTERVAL '1 day'
          AND started_at < CURRENT_DATE
      `;

            const statsResult = await pool.query(statsQuery, [listener_id]);
            const { daily_calls = 0, total_seconds = 0 } = statsResult.rows[0] || {};

            const dailyMinutes = Math.floor((total_seconds || 0) / 60);
            const callsCount = parseInt(daily_calls || 0, 10);

            // Rule: At least 40 minutes OR 5 calls
            const criteriaMet = dailyMinutes >= 40 || callsCount >= 5;

            if (criteriaMet) {
                // Streak continues
                const newStreak = daily_streak_days + 1;
                await pool.query(
                    `UPDATE listeners 
           SET daily_streak_days = $1, 
               last_streak_date = CURRENT_DATE - INTERVAL '1 day',
               last_daily_stats_date = CURRENT_DATE - INTERVAL '1 day'
           WHERE listener_id = $2`,
                    [newStreak, listener_id]
                );
                console.log(`[STREAK MAINTAINED] Listener ${listener_id} - ${callsCount} calls, ${dailyMinutes} mins -> Streak: ${newStreak}`);
                streakMaintainedCount++;

                // If streak hits a multiple of 7, they earn the weekly bonus!
                if (newStreak > 0 && newStreak % 7 === 0) {
                    const bonusAmount = 500; // Define this in rate_config ideally, hardcoding 500 for now

                    console.log(`🎉 [WEEKLY BONUS] Listener ${listener_id} hit 7-day streak! Awarding ₹${bonusAmount}`);

                    await pool.query(
                        `UPDATE listeners 
             SET wallet_balance = wallet_balance + $1,
                 total_earning = total_earning + $1
             WHERE listener_id = $2`,
                        [bonusAmount, listener_id]
                    );

                    // Add to transactions for audit
                    // First get the user_id for this listener
                    const userResult = await pool.query('SELECT user_id FROM listeners WHERE listener_id = $1', [listener_id]);
                    if (userResult.rows.length > 0) {
                        await pool.query(
                            `INSERT INTO transactions (user_id, transaction_type, amount, currency, description, status)
               VALUES ($1, 'credit', $2, 'INR', $3, 'completed')`,
                            [userResult.rows[0].user_id, bonusAmount, 'Weekly Listener Streak Bonus (7 Days)']
                        );
                    }
                }
            } else {
                // Streak lost
                if (daily_streak_days > 0) {
                    await pool.query(
                        `UPDATE listeners 
             SET daily_streak_days = 0, 
                 last_daily_stats_date = CURRENT_DATE - INTERVAL '1 day'
             WHERE listener_id = $1`,
                        [listener_id]
                    );
                    console.log(`[STREAK LOST] Listener ${listener_id} missed quota. Streak reset to 0.`);
                    streakLostCount++;
                }
            }
        }

        console.log(`--- Done! Maintained: ${streakMaintainedCount}, Lost: ${streakLostCount} ---`);
        process.exit(0);
    } catch (error) {
        console.error('Error running daily stats:', error);
        process.exit(1);
    }
}

runDailyStats();
