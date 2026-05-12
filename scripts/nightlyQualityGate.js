/**
 * Nightly Quality Gate Cron Job
 * 
 * Runs at midnight daily to evaluate listener quality and apply:
 * - Probation graduation (after 10 calls with rating ≥3.5 and avg duration ≥3 min)
 * - Auto-demotion (rating drops, short calls, high hangup rate)
 * - Suspension lifting (if suspended_until has passed)
 * 
 * Usage: node scripts/nightlyQualityGate.js
 */

import { pool } from '../db.js';

async function runNightlyQualityGate() {
    console.log('[QUALITY GATE] Starting nightly quality evaluation...');

    try {
        // ===== 1. PROBATION GRADUATION =====
        // Listeners with probation_calls_remaining <= 0: evaluate for promotion
        const probationResult = await pool.query(`
      SELECT listener_id, average_rating, total_calls, avg_call_duration_seconds
      FROM listeners
      WHERE quality_status = 'probation' AND probation_calls_remaining <= 0
    `);

        for (const listener of probationResult.rows) {
            const avgRating = Number(listener.average_rating || 0);
            const avgDuration = Number(listener.avg_call_duration_seconds || 0);

            if (avgRating >= 3.5 && avgDuration >= 180) {
                // Promoted to active
                await pool.query(
                    `UPDATE listeners SET quality_status = 'active', warning_reason = NULL WHERE listener_id = $1`,
                    [listener.listener_id]
                );
                console.log(`[QUALITY GATE] Listener ${listener.listener_id} PROMOTED (rating: ${avgRating}, avg_dur: ${avgDuration}s)`);
            } else {
                // Failed probation → suspended
                const reason = `Failed probation: rating=${avgRating.toFixed(1)}, avg_duration=${Math.round(avgDuration)}s (need ≥3.5 rating, ≥180s)`;
                await pool.query(
                    `UPDATE listeners SET quality_status = 'suspended', suspension_reason = $1, is_active = FALSE WHERE listener_id = $2`,
                    [reason, listener.listener_id]
                );
                console.log(`[QUALITY GATE] Listener ${listener.listener_id} SUSPENDED (failed probation: rating=${avgRating}, dur=${avgDuration}s)`);
            }
        }

        // ===== 2. AUTO-DEMOTION CHECK (Active listeners only) =====
        const activeResult = await pool.query(`
      SELECT listener_id, average_rating, avg_call_duration_seconds, hangup_rate, short_calls_streak
      FROM listeners
      WHERE quality_status IN ('active', 'warning') AND is_active = TRUE
    `);

        for (const listener of activeResult.rows) {
            const avgRating = Number(listener.average_rating || 0);
            const avgDuration = Number(listener.avg_call_duration_seconds || 0);
            const hangupRate = Number(listener.hangup_rate || 0);
            const shortStreak = Number(listener.short_calls_streak || 0);

            let newStatus = listener.quality_status || 'active';
            let warningReason = null;
            let suspensionReason = null;

            // Check for SUSPENSION conditions (severe)
            if (avgRating < 2.5) {
                newStatus = 'suspended';
                suspensionReason = `Rating critically low: ${avgRating.toFixed(1)} (threshold: 2.5)`;
            } else if (avgDuration < 60 && shortStreak >= 5) {
                newStatus = 'suspended';
                suspensionReason = `Average call duration <1 min for ${shortStreak} days`;
            } else if (hangupRate > 70) {
                newStatus = 'suspended';
                suspensionReason = `Hangup rate ${hangupRate.toFixed(0)}% exceeds 70% threshold`;
            }
            // Check for WARNING conditions (moderate)
            else if (avgRating < 3.5) {
                newStatus = 'warning';
                warningReason = `Rating below 3.5: ${avgRating.toFixed(1)}`;
            } else if (avgDuration < 120 && shortStreak >= 3) {
                newStatus = 'warning';
                warningReason = `Average call duration <2 min for ${shortStreak} days`;
            } else if (hangupRate > 50) {
                newStatus = 'warning';
                warningReason = `Hangup rate ${hangupRate.toFixed(0)}% exceeds 50%`;
            }
            // If previously warned but now OK → back to active
            else if (listener.quality_status === 'warning') {
                newStatus = 'active';
            }

            if (newStatus !== (listener.quality_status || 'active')) {
                if (newStatus === 'suspended') {
                    await pool.query(
                        `UPDATE listeners SET quality_status = 'suspended', suspension_reason = $1, is_active = FALSE WHERE listener_id = $2`,
                        [suspensionReason, listener.listener_id]
                    );
                    console.log(`[QUALITY GATE] Listener ${listener.listener_id} AUTO-SUSPENDED: ${suspensionReason}`);
                } else if (newStatus === 'warning') {
                    await pool.query(
                        `UPDATE listeners SET quality_status = 'warning', warning_reason = $1 WHERE listener_id = $2`,
                        [warningReason, listener.listener_id]
                    );
                    console.log(`[QUALITY GATE] Listener ${listener.listener_id} WARNING: ${warningReason}`);
                } else if (newStatus === 'active') {
                    await pool.query(
                        `UPDATE listeners SET quality_status = 'active', warning_reason = NULL WHERE listener_id = $1`,
                        [listener.listener_id]
                    );
                    console.log(`[QUALITY GATE] Listener ${listener.listener_id} RECOVERED → active`);
                }
            }
        }

        // ===== 3. LIFT EXPIRED SUSPENSIONS =====
        const liftResult = await pool.query(`
      UPDATE listeners
      SET quality_status = 'warning', suspension_reason = NULL, suspended_until = NULL, is_active = TRUE
      WHERE quality_status = 'suspended'
        AND suspended_until IS NOT NULL
        AND suspended_until < CURRENT_TIMESTAMP
      RETURNING listener_id
    `);

        for (const row of liftResult.rows) {
            console.log(`[QUALITY GATE] Listener ${row.listener_id} suspension lifted (expired)`);
        }

        // ===== 4. UPDATE AVG CALL DURATION + HANGUP RATE =====
        // Recalculate from last 7 days of calls
        await pool.query(`
      UPDATE listeners l
      SET avg_call_duration_seconds = COALESCE(stats.avg_duration, 0),
          hangup_rate = COALESCE(stats.hangup_pct, 0)
      FROM (
        SELECT
          c.listener_id,
          ROUND(AVG(c.duration_seconds)) AS avg_duration,
          ROUND(100.0 * COUNT(*) FILTER (WHERE c.duration_seconds < 30) / NULLIF(COUNT(*), 0), 2) AS hangup_pct
        FROM calls c
        WHERE c.status = 'completed'
          AND c.created_at > CURRENT_TIMESTAMP - INTERVAL '7 days'
        GROUP BY c.listener_id
      ) stats
      WHERE l.listener_id = stats.listener_id
    `);

        // Update short_calls_streak: increment if avg_duration < 120, else reset
        await pool.query(`
      UPDATE listeners
      SET short_calls_streak = CASE
        WHEN avg_call_duration_seconds < 120 THEN short_calls_streak + 1
        ELSE 0
      END
      WHERE quality_status IN ('active', 'warning')
    `);

        console.log('[QUALITY GATE] Nightly quality evaluation complete.');
    } catch (error) {
        console.error('[QUALITY GATE] Error:', error);
    }
}

runNightlyQualityGate()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('[QUALITY GATE] Fatal error:', err);
        process.exit(1);
    });
