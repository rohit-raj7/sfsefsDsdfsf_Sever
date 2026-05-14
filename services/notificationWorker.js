import { pool } from '../db.js';
import User from '../models/User.js';
import { sendBatchFCM } from '../utils/fcm.js';

// ─── Socket Emitter ─────────────────────────────────────────────────
let notificationEmitter = null;

export function setNotificationEmitter(emitter) {
  notificationEmitter = emitter ?? null;
}

function getConnectedRoomSize(roomName) {
  try {
    return notificationEmitter?.sockets?.adapter?.rooms?.get(roomName)?.size ?? 0;
  } catch {
    return 0;
  }
}

// ─── Scheduling ─────────────────────────────────────────────────────
const scheduledOutboxTimers = new Map();
const MAX_TIMER_MS = 2147483647;
const MAX_OUTBOX_RETRIES = Number(process.env.NOTIFICATION_MAX_RETRIES || 3);
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
let processingLoopPromise = null;
let processingRequested = false;

export function triggerNotificationProcessing(reason = 'manual') {
  processingRequested = true;
  if (processingLoopPromise) {
    return processingLoopPromise;
  }

  processingLoopPromise = new Promise((resolve) => {
    setImmediate(async () => {
      try {
        let processedCount = 0;
        do {
          processingRequested = false;
          processedCount = await processNotifications();
        } while (processingRequested || processedCount > 0);
      } catch (error) {
        console.error(`[NotificationWorker] Processing loop failed (${reason}):`, error.message);
      } finally {
        processingLoopPromise = null;
        resolve();
      }
    });
  });

  return processingLoopPromise;
}

function clearScheduledTimer(outboxId) {
  const existing = scheduledOutboxTimers.get(outboxId);
  if (existing) {
    clearTimeout(existing);
    scheduledOutboxTimers.delete(outboxId);
  }
}

function parseScheduleTime(scheduleAt) {
  if (!scheduleAt) return null;
  // Postgres Date objects are already UTC — don't reconstruct via Date.UTC()
  // (doing so would double-apply the local timezone offset)
  if (scheduleAt instanceof Date) {
    return Number.isNaN(scheduleAt.getTime()) ? null : scheduleAt;
  }
  const parsed = new Date(scheduleAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function unscheduleOutboxProcessing(outboxId) {
  clearScheduledTimer(outboxId);
}

export function scheduleOutboxProcessing(outbox) {
  if (!outbox?.id) return false;
  clearScheduledTimer(outbox.id);

  // Only skip truly terminal statuses; allow PROCESSING to be retried (e.g. server crash recovery)
  const status = String(outbox.status || 'PENDING').toUpperCase();
  if (status === 'SENT' || status === 'FAILED') return false;

  const scheduleTime = parseScheduleTime(outbox.schedule_at);
  if (!scheduleTime) {
    const timer = setTimeout(() => {
      scheduledOutboxTimers.delete(outbox.id);
      triggerNotificationProcessing('immediate-timer');
    }, 0);
    scheduledOutboxTimers.set(outbox.id, timer);
    return true;
  }

  const delayMs = scheduleTime.getTime() - Date.now();
  const nextDelay = delayMs <= 0 ? 0 : Math.min(delayMs, MAX_TIMER_MS);
  const timer = setTimeout(() => {
    scheduledOutboxTimers.delete(outbox.id);
    if (delayMs > MAX_TIMER_MS) {
      scheduleOutboxProcessing(outbox);
      return;
    }
    triggerNotificationProcessing('scheduled-timer');
  }, nextDelay);
  scheduledOutboxTimers.set(outbox.id, timer);
  return true;
}

export async function bootstrapScheduledNotifications(limit = 500) {
  try {
    // Reset any PROCESSING items that got stuck (e.g. server crash mid-send)
    const reset = await pool.query(
      `UPDATE notification_outbox
       SET status = 'PENDING', processing_started_at = NULL
       WHERE status = 'PROCESSING'
         AND (
           processing_started_at IS NULL
           OR processing_started_at < CURRENT_TIMESTAMP - INTERVAL '10 minutes'
         )
       RETURNING id`,
    );
    if (reset.rowCount > 0) {
      console.warn(`[NotificationWorker] Reset ${reset.rowCount} stuck PROCESSING item(s) to PENDING on startup`);
    }

    const result = await pool.query(
      `SELECT id, schedule_at, status
       FROM notification_outbox
       WHERE status = 'PENDING'
       ORDER BY COALESCE(schedule_at, created_at) ASC
       LIMIT $1`,
      [limit],
    );
    for (const row of result.rows) {
      scheduleOutboxProcessing(row);
    }
    if (result.rows.length > 0) {
      console.log(`[NotificationWorker] Bootstrapped ${result.rows.length} scheduled notification(s)`);
    }
  } catch (error) {
    console.error('[NotificationWorker] Bootstrap error:', error.message);
  }
}

// ─── Main Processing Loop ───────────────────────────────────────────
export async function processNotifications() {
  let client;
  let inTransaction = false;
  try {
    client = await pool.connect();

    // Claim outbox items with row-level lock, then release connection fast
    await client.query('BEGIN');
    inTransaction = true;
    const ready = await client.query(`
      UPDATE notification_outbox
      SET status = 'PROCESSING',
          processing_started_at = CURRENT_TIMESTAMP
      WHERE id IN (
        SELECT id FROM notification_outbox
        WHERE status = 'PENDING'
          AND (schedule_at IS NULL OR schedule_at <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))
        ORDER BY created_at ASC
        LIMIT 50
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);

    // Snapshot the rows, then commit to release locks
    const outboxItems = ready.rows;
    await client.query('COMMIT');
    inTransaction = false;
    client.release();
    client = null;

    // Process each claimed item outside the transaction
    for (const outbox of outboxItems) {
      try {
        await processOutboxItem(outbox);
      } catch (error) {
        console.error(`[NotificationWorker] Failed outbox=${outbox.id}:`, error.message);
        await markOutboxProcessingError(outbox, error);
      }
    }
    return outboxItems.length;
  } catch (error) {
    console.error('[NotificationWorker] Error processing outbox:', error.message);
    if (client) {
      if (inTransaction) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      }
      client.release();
    }
    return 0;
  }
}

function retryDelayMs(retryCount) {
  return RETRY_BACKOFF_MS[Math.min(retryCount, RETRY_BACKOFF_MS.length - 1)];
}

function retryAtFor(retryCount) {
  return new Date(Date.now() + retryDelayMs(retryCount));
}

async function markOutboxProcessingError(outbox, error) {
  const retryCount = Number(outbox.retry_count || 0);
  const canRetry = retryCount < MAX_OUTBOX_RETRIES;
  const nextRetryAt = canRetry ? retryAtFor(retryCount) : null;
  const message = `Processing error: ${error.message}`;

  const result = await pool.query(
    `UPDATE notification_outbox
     SET status = $2,
         schedule_at = CASE WHEN $2 = 'PENDING' THEN $3 ELSE schedule_at END,
         processing_started_at = NULL,
         retry_count = retry_count + 1,
         last_error = $4
     WHERE id = $1
     RETURNING id, schedule_at, status`,
    [outbox.id, canRetry ? 'PENDING' : 'FAILED', nextRetryAt, message],
  );

  if (canRetry && result.rows[0]) {
    scheduleOutboxProcessing(result.rows[0]);
  }
}

// ─── Process Single Outbox Item (Batched) ───────────────────────────
async function processOutboxItem(outbox) {
  const startTime = Date.now();
  clearScheduledTimer(outbox.id);

  // ── Step 1: Fetch recipients ──────────────────────────────────────
  const users = await fetchRecipients(outbox);
  const totalRecipients = users.length;

  if (totalRecipients === 0) {
    await pool.query(
      `UPDATE notification_outbox
       SET status = 'FAILED',
           processing_started_at = NULL,
           last_error = $2
       WHERE id = $1`,
      [outbox.id, 'No active target users found for this notification'],
    );
    return;
  }

  // ── Step 2: Batch INSERT notifications + deliveries ───────────────
  const userIds = users.map((u) => u.user_id);
  const notificationRows = await batchInsertNotifications(outbox, userIds);
  await batchInsertDeliveries(outbox.id, userIds);

  // Build notification ID map: userId -> notificationId
  const notifIdMap = new Map();
  for (const row of notificationRows) {
    notifIdMap.set(row.user_id, row);
  }

  // ── Step 3: Socket broadcast to connected users ───────────────────
  for (const user of users) {
    const notif = notifIdMap.get(user.user_id);
    if (!notif) continue;
    const payload = {
      id: notif.notification_id,
      title: outbox.title,
      body: outbox.body,
      outboxId: outbox.id,
      createdAt: notif.created_at instanceof Date ? notif.created_at.toISOString() : notif.created_at,
    };
    notificationEmitter?.to(`user_${user.user_id}`).emit('app:notification', payload);
  }

  // ── Step 4: Batch FCM send ────────────────────────────────────────
  const usersWithTokens = users.filter((u) => Boolean(u.fcm_token));
  const usersMissingTokens = users.filter((u) => !u.fcm_token);

  const fcmResults = usersWithTokens.length > 0
    ? await sendBatchFCM(
        usersWithTokens.map((u) => ({
          userId: u.user_id,
          token: u.fcm_token,
          title: outbox.title,
          body: outbox.body,
          data: {
            outboxId: String(outbox.id),
            notificationId: String(notifIdMap.get(u.user_id)?.notification_id || ''),
            type: 'admin_notification',
          },
        })),
      )
    : [];

  // ── Step 5: Classify results and batch update deliveries ──────────
  const deliveryUpdates = { userIds: [], statuses: [], errors: [] };
  let sentCount = 0;
  let failedCount = 0;
  const failureReasonCounts = new Map();
  let socketFallbackCount = 0;
  const socketFallbackReasonCounts = new Map();

  const trackFailure = (reason) => {
    const normalized = String(reason || 'Unknown delivery error').trim() || 'Unknown delivery error';
    failureReasonCounts.set(normalized, (failureReasonCounts.get(normalized) || 0) + 1);
  };

  const trackSocketFallback = (reason) => {
    const normalized = String(reason || 'Unknown socket fallback').trim() || 'Unknown socket fallback';
    socketFallbackReasonCounts.set(
      normalized,
      (socketFallbackReasonCounts.get(normalized) || 0) + 1,
    );
  };

  // Process FCM results
  const invalidTokenUsers = [];
  for (const result of fcmResults) {
    if (result.success) {
      deliveryUpdates.userIds.push(result.userId);
      deliveryUpdates.statuses.push('SENT');
      deliveryUpdates.errors.push(null);
      sentCount++;
    } else {
      // Check if user is connected via socket (fallback)
      const isConnected = getConnectedRoomSize(`user_${result.userId}`) > 0;
      if (isConnected) {
        deliveryUpdates.userIds.push(result.userId);
        deliveryUpdates.statuses.push('SENT');
        deliveryUpdates.errors.push(`FCM failed, delivered via socket: ${result.error}`);
        sentCount++;
        socketFallbackCount++;
        trackSocketFallback(result.error);
      } else {
        deliveryUpdates.userIds.push(result.userId);
        deliveryUpdates.statuses.push('FAILED');
        deliveryUpdates.errors.push(result.error);
        failedCount++;
        trackFailure(result.error);
      }
      if (result.isInvalidToken) {
        invalidTokenUsers.push({ userId: result.userId, token: result.token, error: result.error });
      }
    }
  }

  // Process users missing FCM tokens
  for (const user of usersMissingTokens) {
    const isConnected = getConnectedRoomSize(`user_${user.user_id}`) > 0;
    if (isConnected) {
      deliveryUpdates.userIds.push(user.user_id);
      deliveryUpdates.statuses.push('SENT');
      deliveryUpdates.errors.push('FCM token missing, delivered via active socket session');
      sentCount++;
      socketFallbackCount++;
      trackSocketFallback('No registered FCM token');
    } else {
      deliveryUpdates.userIds.push(user.user_id);
      deliveryUpdates.statuses.push('FAILED');
      deliveryUpdates.errors.push('No registered FCM token');
      failedCount++;
      trackFailure('No registered FCM token');
    }
  }

  // Batch UPDATE all delivery statuses in one query
  if (deliveryUpdates.userIds.length > 0) {
    await pool.query(
      `UPDATE notification_deliveries
       SET status = batch.new_status,
           delivered_at = CASE WHEN batch.new_status = 'SENT' THEN CURRENT_TIMESTAMP ELSE delivered_at END,
           last_error = batch.new_error,
           retry_count = CASE WHEN batch.new_status = 'FAILED' THEN retry_count + 1 ELSE retry_count END
       FROM (
         SELECT unnest($1::uuid[]) AS uid,
                unnest($2::text[]) AS new_status,
                unnest($3::text[]) AS new_error
       ) AS batch
       WHERE notification_deliveries.outbox_id = $4
         AND notification_deliveries.user_id = batch.uid`,
      [deliveryUpdates.userIds, deliveryUpdates.statuses, deliveryUpdates.errors, outbox.id],
    );
  }

  // ── Step 6: Clear invalid tokens (async, non-blocking) ────────────
  for (const inv of invalidTokenUsers) {
    User.clearFcmToken(inv.userId, inv.token).catch((e) => {
      console.error(`[NotificationWorker] Failed to clear invalid token user=${inv.userId}: ${e.message}`);
    });
  }

  // ── Step 7: Update outbox status ──────────────────────────────────
  const outboxStatus = sentCount > 0 ? 'SENT' : 'FAILED';
  const deliveredAt = outboxStatus === 'SENT' ? new Date() : null;
  const summarizedFailures = Array.from(failureReasonCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => `${reason} (${count})`)
    .join(', ');
  const summarizedSocketFallbacks = Array.from(socketFallbackReasonCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => `${reason} (${count})`)
    .join(', ');

  const allFailedMissingToken =
    failedCount === totalRecipients &&
    failureReasonCounts.size === 1 &&
    failureReasonCounts.has('No registered FCM token');
  const terminalFailureCount = usersMissingTokens.length + invalidTokenUsers.length;
  const allFailuresTerminal =
    sentCount === 0 &&
    failedCount === totalRecipients &&
    terminalFailureCount >= totalRecipients;

  const outboxLastError =
    totalRecipients === 0
      ? 'No active target users found for this notification'
      : allFailedMissingToken
        ? `Delivery failed for ${failedCount}/${totalRecipients} recipients: no registered FCM token (${failedCount}). Ask the user to open the updated app once so the device token can sync.`
        : failedCount > 0
          ? summarizedFailures
            ? `Delivery failed for ${failedCount}/${totalRecipients} recipients: ${summarizedFailures}`
            : `Delivery failed for ${failedCount}/${totalRecipients} recipients`
          : socketFallbackCount > 0
            ? summarizedSocketFallbacks
              ? `FCM was unavailable for ${socketFallbackCount}/${totalRecipients} recipient(s), but the message reached active app sessions via socket only: ${summarizedSocketFallbacks}. Closed-app delivery will keep failing until FCM credentials and device tokens are fixed.`
              : `FCM was unavailable for ${socketFallbackCount}/${totalRecipients} recipient(s), but the message reached active app sessions via socket only. Closed-app delivery will keep failing until FCM credentials and device tokens are fixed.`
          : null;

  const retryCount = Number(outbox.retry_count || 0);
  const shouldRetry =
    sentCount === 0 &&
    failedCount > 0 &&
    !allFailuresTerminal &&
    retryCount < MAX_OUTBOX_RETRIES;

  if (shouldRetry) {
    const nextRetryAt = retryAtFor(retryCount);
    const retryResult = await pool.query(
      `UPDATE notification_outbox
       SET status = 'PENDING',
           schedule_at = $2,
           delivered_at = NULL,
           processing_started_at = NULL,
           retry_count = retry_count + 1,
           last_error = $3,
           delivered_count = 0
       WHERE id = $1
       RETURNING id, schedule_at, status`,
      [
        outbox.id,
        nextRetryAt,
        `${outboxLastError || 'Delivery failed'}; retry scheduled at ${nextRetryAt.toISOString()}`,
      ],
    );
    scheduleOutboxProcessing(retryResult.rows[0]);
    console.warn(
      `[NotificationWorker] outbox=${outbox.id} retry=${retryCount + 1}/${MAX_OUTBOX_RETRIES} ` +
      `scheduled_at=${nextRetryAt.toISOString()} failed=${failedCount}/${totalRecipients}`,
    );
    return;
  }

  await pool.query(
    `UPDATE notification_outbox
     SET status = $2,
         delivered_at = $3,
         processing_started_at = NULL,
         retry_count = retry_count + 1,
         last_error = $4,
         delivered_count = $5
     WHERE id = $1`,
    [outbox.id, outboxStatus, deliveredAt, outboxLastError, sentCount],
  );

  // ── Step 8: Schedule next recurrence ──────────────────────────────
  if (outbox.repeat_interval && outbox.schedule_at) {
    const interval = outbox.repeat_interval === 'daily' ? '1 day' : '7 days';
    const nextOutbox = await pool.query(
      `INSERT INTO notification_outbox (
         title, body, target_role, target_user_ids,
         schedule_at, repeat_interval, created_by
       )
       VALUES ($1, $2, $3, $4, $5::timestamp + $6::interval, $7, $8)
       RETURNING id, schedule_at, status`,
      [
        outbox.title, outbox.body, outbox.target_role, outbox.target_user_ids,
        outbox.schedule_at, interval, outbox.repeat_interval, outbox.created_by,
      ],
    );
    scheduleOutboxProcessing(nextOutbox.rows[0]);
  }

  const elapsed = Date.now() - startTime;
  console.log(
    `[NotificationWorker] outbox=${outbox.id} status=${outboxStatus} recipients=${totalRecipients} ` +
    `sent=${sentCount} failed=${failedCount} fcm_batch=${usersWithTokens.length} elapsed=${elapsed}ms`,
  );
}

// ─── DB Helper: Fetch Recipients ────────────────────────────────────
async function fetchRecipients(outbox) {
  const hasTargetIds = Array.isArray(outbox.target_user_ids) && outbox.target_user_ids.length > 0;

  if (hasTargetIds && outbox.target_role === 'LISTENER') {
    const result = await pool.query(
      `SELECT DISTINCT u.user_id, u.account_type, NULLIF(BTRIM(u.fcm_token), '') AS fcm_token
       FROM users u
       LEFT JOIN listeners l ON l.user_id = u.user_id
       WHERE u.is_active = TRUE
         AND u.account_type = 'listener'
         AND (u.user_id = ANY($1::uuid[]) OR l.listener_id = ANY($1::uuid[]))`,
      [outbox.target_user_ids],
    );
    return result.rows;
  }

  if (hasTargetIds) {
    const result = await pool.query(
      `SELECT user_id, account_type, NULLIF(BTRIM(fcm_token), '') AS fcm_token
       FROM users
       WHERE user_id = ANY($1::uuid[]) AND is_active = TRUE AND account_type = 'user'`,
      [outbox.target_user_ids],
    );
    return result.rows;
  }

  const result = await pool.query(
    `SELECT user_id, account_type, NULLIF(BTRIM(fcm_token), '') AS fcm_token
     FROM users
     WHERE account_type = $1 AND is_active = TRUE`,
    [outbox.target_role === 'USER' ? 'user' : 'listener'],
  );
  return result.rows;
}

// ─── DB Helper: Batch Insert Notifications ──────────────────────────
async function batchInsertNotifications(outbox, userIds) {
  const result = await pool.query(
    `WITH target(uid) AS (
       SELECT unnest($1::uuid[])
     ),
     inserted AS (
       INSERT INTO notifications (user_id, title, message, notification_type, is_read, data, source_outbox_id)
       SELECT target.uid, $2, $3, 'system', FALSE, $4::jsonb, $5
       FROM target
       WHERE NOT EXISTS (
         SELECT 1
         FROM notifications n
         WHERE n.user_id = target.uid
           AND n.source_outbox_id = $5
       )
       RETURNING notification_id, user_id, created_at
     ),
     existing AS (
       SELECT DISTINCT ON (n.user_id) n.notification_id, n.user_id, n.created_at
       FROM notifications n
       JOIN target ON target.uid = n.user_id
       WHERE n.source_outbox_id = $5
       ORDER BY n.user_id, n.created_at ASC
     )
     SELECT notification_id, user_id, created_at FROM inserted
     UNION ALL
     SELECT notification_id, user_id, created_at
     FROM existing
     WHERE NOT EXISTS (
       SELECT 1 FROM inserted WHERE inserted.user_id = existing.user_id
     )`,
    [
      userIds,
      outbox.title,
      outbox.body,
      JSON.stringify({ targetRole: outbox.target_role }),
      outbox.id,
    ],
  );
  return result.rows;
}

// ─── DB Helper: Batch Insert Deliveries ─────────────────────────────
async function batchInsertDeliveries(outboxId, userIds) {
  await pool.query(
    `INSERT INTO notification_deliveries (outbox_id, user_id)
     SELECT $1, uid FROM unnest($2::uuid[]) AS uid
     ON CONFLICT (outbox_id, user_id) DO NOTHING`,
    [outboxId, userIds],
  );
}
