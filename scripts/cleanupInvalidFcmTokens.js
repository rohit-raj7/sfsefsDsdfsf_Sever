import dotenv from 'dotenv';
import { pool } from '../db.js';
import User from '../models/User.js';

dotenv.config();

const INVALID_PATTERNS = [
  'registration-token-not-registered',
  'invalid-registration-token',
  'registration token is not a valid fcm registration token',
  'requested entity was not found',
];

function buildInvalidErrorWhereClause(startIndex = 1) {
  return INVALID_PATTERNS.map(
    (_, offset) => `LOWER(COALESCE(d.last_error, '')) LIKE $${startIndex + offset}`,
  ).join(' OR ');
}

async function cleanupInvalidFcmTokens() {
  const likeParams = INVALID_PATTERNS.map((pattern) => `%${pattern}%`);
  const invalidWhere = buildInvalidErrorWhereClause();

  const result = await pool.query(
    `
      SELECT DISTINCT ON (u.user_id)
        u.user_id,
        u.account_type,
        u.display_name,
        u.fcm_token,
        d.last_error,
        d.created_at
      FROM users u
      JOIN notification_deliveries d ON d.user_id = u.user_id
      WHERE u.fcm_token IS NOT NULL
        AND BTRIM(u.fcm_token) <> ''
        AND (${invalidWhere})
      ORDER BY u.user_id, d.created_at DESC
    `,
    likeParams,
  );

  if (result.rowCount === 0) {
    console.log('[FCM cleanup] No invalid FCM tokens found.');
    return;
  }

  let clearedCount = 0;
  for (const row of result.rows) {
    const cleared = await User.clearFcmToken(row.user_id, row.fcm_token);
    if (cleared) {
      clearedCount += 1;
      console.log(
        `[FCM cleanup] Cleared token for user=${row.user_id} account=${row.account_type} reason="${row.last_error}"`,
      );
    }
  }

  console.log(
    `[FCM cleanup] Done. Cleared ${clearedCount}/${result.rowCount} invalid token(s).`,
  );
}

cleanupInvalidFcmTokens()
  .catch((error) => {
    console.error('[FCM cleanup] Failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
