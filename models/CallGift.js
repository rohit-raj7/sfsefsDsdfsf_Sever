import { pool } from '../db.js';

const DUPLICATE_REQUEST_CONSTRAINT = 'uq_call_gifts_sender_request';

const toMoney = (value) => Number(Number(value || 0).toFixed(2));

const normalizeLimit = (value, fallback = 30) => {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), 100);
};

const parseSinceDate = (value) => {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const mapGiftRow = (row = {}) => ({
  giftEventId: row.gift_event_id,
  callId: row.call_id,
  senderId: row.sender_id,
  listenerId: row.listener_id,
  listenerUserId: row.listener_user_id,
  clientRequestId: row.client_request_id,
  giftId: row.gift_id,
  giftName: row.gift_name,
  assetKey: row.asset_key,
  category: row.gift_category,
  rarity: row.rarity,
  originalCoinAmount: toMoney(row.original_coin_amount ?? row.coin_amount),
  coinAmount: toMoney(row.coin_amount),
  senderName: row.sender_display_name,
  senderAvatar: row.sender_avatar_url,
  listenerSharePercent: row.listener_share_percent !== undefined && row.listener_share_percent !== null ? Number(row.listener_share_percent) : undefined,
  listenerEarning: row.listener_earning !== undefined && row.listener_earning !== null ? Number(row.listener_earning) : undefined,
  platformCommission: row.platform_commission !== undefined && row.platform_commission !== null ? Number(row.platform_commission) : undefined,
  createdAt: row.created_at,
});

const logAudit = async ({
  giftEventId = null,
  senderId = null,
  listenerId = null,
  listenerUserId = null,
  callId = null,
  giftId = null,
  clientRequestId = null,
  status,
  reason = null,
  requestPayload = null,
}) => {
  try {
    await pool.query(
      `INSERT INTO call_gift_audit_logs (
         gift_event_id,
         sender_id,
         listener_id,
         listener_user_id,
         call_id,
         gift_id,
         client_request_id,
         status,
         reason,
         request_payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [
        giftEventId,
        senderId,
        listenerId,
        listenerUserId,
        callId,
        giftId,
        clientRequestId,
        status,
        reason,
        requestPayload ? JSON.stringify(requestPayload) : null,
      ],
    );
  } catch (auditError) {
    console.error('[GIFT] Audit log failure:', auditError.message);
  }
};

class CallGift {
  static async getCatalog() {
    const result = await pool.query(
      `SELECT id, name, original_coin_amount, coin_amount, category, priority, is_active, icon_url
       FROM gifts
       WHERE is_active = TRUE
       ORDER BY priority ASC, name ASC`
    );

    const categories = [
      { id: 'trending', label: 'Trending Gifts', subtitle: 'Most-loved picks lighting up live calls' },
      { id: 'romantic', label: 'Romantic Gifts', subtitle: 'Soft, affectionate moments with heartfelt energy' },
      { id: 'celebration', label: 'Celebration Gifts', subtitle: 'Joyful surprises for milestones and wins' },
      { id: 'luxury', label: 'Luxury Gifts', subtitle: 'Statement pieces with high-status shine' },
      { id: 'funny', label: 'Funny Gifts', subtitle: 'Playful drops to keep the vibe lively' },
      { id: 'seasonal', label: 'Seasonal Gifts', subtitle: 'Limited-feel favorites for special moods' }
    ];

    const gifts = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      assetKey: row.icon_url || row.id,
      rarity: row.coin_amount >= 890 ? 'legendary' : row.coin_amount >= 290 ? 'epic' : row.coin_amount >= 90 ? 'rare' : 'common',
      originalCoinAmount: Number(row.original_coin_amount ?? row.coin_amount),
      coinAmount: Number(row.coin_amount),
      categories: [row.category]
    }));

    return {
      version: 'premium-call-gifts-v2',
      categories,
      gifts
    };
  }

  static async getCallHistory({
    requesterUserId,
    callId,
    since = null,
    limit = 30,
  }) {
    const normalizedLimit = normalizeLimit(limit);
    const sinceDate = parseSinceDate(since);

    const accessResult = await pool.query(
      `SELECT
         c.call_id,
         c.caller_id,
         c.listener_id,
         c.status,
         l.user_id AS listener_user_id
       FROM calls c
       JOIN listeners l ON l.listener_id = c.listener_id
       WHERE c.call_id = $1
       LIMIT 1`,
      [callId],
    );

    if (accessResult.rows.length === 0) {
      const error = new Error('Call not found');
      error.code = 'CALL_NOT_FOUND';
      throw error;
    }

    const call = accessResult.rows[0];
    const isCaller = String(call.caller_id) === String(requesterUserId);
    const isListener = String(call.listener_user_id) === String(requesterUserId);
    if (!isCaller && !isListener) {
      const error = new Error('Forbidden');
      error.code = 'FORBIDDEN';
      throw error;
    }

    const params = [callId];
    let whereClause = 'WHERE cg.call_id = $1';

    if (sinceDate) {
      params.push(sinceDate.toISOString());
      whereClause += ` AND cg.created_at > $${params.length}`;
    }

    params.push(normalizedLimit);

    const result = await pool.query(
      `SELECT
         cg.gift_event_id,
         cg.call_id,
         cg.sender_id,
         cg.listener_id,
         cg.listener_user_id,
         cg.client_request_id,
         cg.gift_id,
         cg.gift_name,
         cg.asset_key,
         cg.gift_category,
         cg.rarity,
         cg.original_coin_amount,
         cg.coin_amount,
         cg.sender_display_name,
         cg.sender_avatar_url,
         cg.listener_share_percent,
         cg.listener_earning,
         cg.platform_commission,
         cg.created_at
       FROM call_gifts cg
       ${whereClause}
       ORDER BY cg.created_at ASC
       LIMIT $${params.length}`,
      params,
    );

    return {
      callId,
      gifts: result.rows.map(mapGiftRow),
    };
  }

  static async sendGift({
    senderId,
    callId,
    giftId,
    clientRequestId,
  }) {
    const giftResult = await pool.query(
      `SELECT id, name, original_coin_amount, coin_amount, category, is_active, icon_url
       FROM gifts
       WHERE id = $1 AND is_active = TRUE
       LIMIT 1`,
      [giftId]
    );

    if (giftResult.rows.length === 0) {
      const error = new Error('Invalid gift ID');
      error.code = 'INVALID_GIFT_ID';
      throw error;
    }

    const dbGift = giftResult.rows[0];
    const gift = {
      id: dbGift.id,
      name: dbGift.name,
      assetKey: dbGift.icon_url || dbGift.id,
      rarity: dbGift.coin_amount >= 890 ? 'legendary' : dbGift.coin_amount >= 290 ? 'epic' : dbGift.coin_amount >= 90 ? 'rare' : 'common',
      originalCoinAmount: Number(dbGift.original_coin_amount ?? dbGift.coin_amount),
      coinAmount: Number(dbGift.coin_amount),
      categories: [dbGift.category]
    };

    const auditPayload = {
      senderId,
      callId,
      giftId,
      clientRequestId,
      gift: {
        id: gift.id,
        name: gift.name,
        assetKey: gift.assetKey,
        rarity: gift.rarity,
        originalCoinAmount: gift.originalCoinAmount,
        coinAmount: gift.coinAmount,
        categories: [...gift.categories],
      },
    };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const callResult = await client.query(
        `SELECT
           c.call_id,
           c.caller_id,
           c.listener_id,
           c.status,
           l.user_id AS listener_user_id,
           COALESCE(NULLIF(sender.display_name, ''), NULLIF(sender.full_name, ''), 'User') AS sender_name,
           sender.avatar_url AS sender_avatar
         FROM calls c
         JOIN listeners l ON l.listener_id = c.listener_id
         LEFT JOIN users sender ON sender.user_id = $2
         WHERE c.call_id = $1
         FOR UPDATE OF c, l`,
        [callId, senderId],
      );

      if (callResult.rows.length === 0) {
        const error = new Error('Call not found');
        error.code = 'CALL_NOT_FOUND';
        throw error;
      }

      const call = callResult.rows[0];
      if (String(call.caller_id) !== String(senderId)) {
        const error = new Error('Only the caller can send gifts during this call');
        error.code = 'FORBIDDEN';
        throw error;
      }
      if (String(call.listener_user_id || '') === String(senderId)) {
        const error = new Error('Cannot send a gift to yourself');
        error.code = 'SELF_GIFT_NOT_ALLOWED';
        throw error;
      }
      if (String(call.status || '').toLowerCase() !== 'ongoing') {
        const error = new Error('Gifts can only be sent during an ongoing call');
        error.code = 'CALL_NOT_ACTIVE';
        throw error;
      }

      const existingGiftResult = await client.query(
        `SELECT
           gift_event_id,
           call_id,
           sender_id,
           listener_id,
           listener_user_id,
           client_request_id,
           gift_id,
           gift_name,
           asset_key,
           gift_category,
           rarity,
           original_coin_amount,
           coin_amount,
           sender_display_name,
           sender_avatar_url,
           listener_share_percent,
           listener_earning,
           platform_commission,
           created_at
         FROM call_gifts
         WHERE sender_id = $1
           AND client_request_id = $2
         LIMIT 1`,
        [senderId, clientRequestId],
      );

      if (existingGiftResult.rows.length > 0) {
        const walletResult = await client.query(
          `SELECT balance
           FROM wallets
           WHERE user_id = $1
           LIMIT 1`,
          [senderId],
        );

        const duplicateGift = mapGiftRow(existingGiftResult.rows[0]);
        await client.query('COMMIT');
        await logAudit({
          giftEventId: duplicateGift.giftEventId,
          senderId,
          listenerId: duplicateGift.listenerId,
          listenerUserId: duplicateGift.listenerUserId,
          callId,
          giftId,
          clientRequestId,
          status: 'duplicate',
          reason: 'existing_request_reused',
          requestPayload: auditPayload,
        });

        return {
          duplicate: true,
          giftEvent: duplicateGift,
          senderBalance: toMoney(walletResult.rows[0]?.balance || 0),
        };
      }

      await client.query(
        `INSERT INTO wallets (user_id, balance)
         VALUES ($1, 0.0)
         ON CONFLICT (user_id) DO NOTHING`,
        [senderId],
      );

      const walletDebitResult = await client.query(
        `UPDATE wallets
         SET balance = balance - $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1
           AND balance >= $2
         RETURNING balance`,
        [senderId, gift.coinAmount],
      );

      if (walletDebitResult.rows.length === 0) {
        const error = new Error('Insufficient balance');
        error.code = 'INSUFFICIENT_BALANCE';
        throw error;
      }

      const senderBalance = toMoney(walletDebitResult.rows[0].balance);

      await client.query(
        `UPDATE users
         SET wallet_balance = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1`,
        [senderId, senderBalance],
      );

      const listenerTransactionResult = await client.query(
        `INSERT INTO transactions (
           user_id,
           transaction_type,
           amount,
           currency,
           description,
           payment_method,
           status,
           related_call_id
         )
         VALUES ($1, 'debit', $2, 'INR', $3, 'in_app_gift', 'completed', $4)`,
        [senderId, gift.coinAmount, `Gift sent: ${gift.name}`, callId],
      );

      // Fetch dynamic gift settings
      const settingsResult = await client.query(
        `SELECT listener_gift_share_percent FROM gift_settings LIMIT 1`
      );
      const sharePercent = Number(settingsResult.rows[0]?.listener_gift_share_percent ?? 50.00);
      const listenerEarning = Number((gift.coinAmount * (sharePercent / 100)).toFixed(2));
      const platformCommission = Number((gift.coinAmount - listenerEarning).toFixed(2));

      // Ensure listener gift wallet exists
      await client.query(
        `INSERT INTO listener_gift_wallets (listener_id, total_earnings, available_balance, pending_withdrawals, total_withdrawn)
         VALUES ($1, 0.0, 0.0, 0.0, 0.0)
         ON CONFLICT (listener_id) DO NOTHING`,
        [call.listener_id]
      );

      // Credit listener gift wallet
      const giftWalletResult = await client.query(
        `UPDATE listener_gift_wallets
         SET total_earnings = total_earnings + $2,
             available_balance = available_balance + $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE listener_id = $1
         RETURNING available_balance`,
        [call.listener_id, listenerEarning]
      );

      await client.query(
        `INSERT INTO transactions (
           user_id,
           transaction_type,
           amount,
           currency,
           description,
           payment_method,
           status,
           related_call_id
          )
          VALUES ($1, 'credit', $2, 'INR', $3, 'in_app_gift', 'completed', $4)
          RETURNING transaction_id`,
        [
          call.listener_user_id,
          listenerEarning,
          `Gift received: ${gift.name} (${sharePercent}% Share)`,
          callId,
        ],
      );

      const giftInsertResult = await client.query(
        `INSERT INTO call_gifts (
           call_id,
           sender_id,
           listener_id,
           listener_user_id,
           client_request_id,
           gift_id,
           gift_name,
           asset_key,
           gift_category,
           rarity,
           original_coin_amount,
           coin_amount,
           sender_display_name,
           sender_avatar_url,
           listener_share_percent,
           listener_earning,
           platform_commission
         )
         VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15,
           $16, $17, $18
         )
         RETURNING
           gift_event_id,
           call_id,
           sender_id,
           listener_id,
           listener_user_id,
           client_request_id,
           gift_id,
           gift_name,
           asset_key,
           gift_category,
           rarity,
           original_coin_amount,
           coin_amount,
           sender_display_name,
           sender_avatar_url,
           listener_share_percent,
           listener_earning,
           platform_commission,
           created_at`,
        [
          callId,
          senderId,
          call.listener_id,
          call.listener_user_id,
          clientRequestId,
          gift.id,
          gift.name,
          gift.assetKey,
          gift.categories[0],
          gift.rarity,
          gift.originalCoinAmount,
          gift.coinAmount,
          call.sender_name,
          call.sender_avatar || null,
          sharePercent,
          listenerEarning,
          platformCommission
        ],
      );

      const giftEvent = mapGiftRow(giftInsertResult.rows[0]);

      await client.query(
        `INSERT INTO listener_gift_earnings_ledger (
           listener_id,
           gift_event_id,
           transaction_id,
           amount,
           status
         )
         VALUES ($1, $2, $3, $4, 'available')`,
        [
          call.listener_id,
          giftEvent.giftEventId,
          listenerTransactionResult.rows[0]?.transaction_id || null,
          listenerEarning,
        ],
      );

      await client.query(
        `INSERT INTO call_gift_audit_logs (
           gift_event_id,
           sender_id,
           listener_id,
           listener_user_id,
           call_id,
           gift_id,
           client_request_id,
           status,
           request_payload
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', $8::jsonb)`,
        [
          giftEvent.giftEventId,
          senderId,
          call.listener_id,
          call.listener_user_id,
          callId,
          gift.id,
          clientRequestId,
          JSON.stringify(auditPayload),
        ],
      );

      await client.query('COMMIT');

      return {
        duplicate: false,
        giftEvent,
        senderBalance,
        listenerBalance: toMoney(
          giftWalletResult.rows[0]?.available_balance || 0,
        ),
      };
    } catch (error) {
      await client.query('ROLLBACK');

      if (
        error?.code === '23505' &&
        error?.constraint === DUPLICATE_REQUEST_CONSTRAINT
      ) {
        const existing = await pool.query(
          `SELECT
             gift_event_id,
             call_id,
             sender_id,
             listener_id,
             listener_user_id,
             client_request_id,
             gift_id,
             gift_name,
             asset_key,
             gift_category,
             rarity,
             original_coin_amount,
             coin_amount,
             sender_display_name,
             sender_avatar_url,
             listener_share_percent,
             listener_earning,
             platform_commission,
             created_at
           FROM call_gifts
           WHERE sender_id = $1
             AND client_request_id = $2
           LIMIT 1`,
          [senderId, clientRequestId],
        );
        const walletResult = await pool.query(
          'SELECT balance FROM wallets WHERE user_id = $1 LIMIT 1',
          [senderId],
        );
        const duplicateGift = existing.rows[0]
          ? mapGiftRow(existing.rows[0])
          : null;

        await logAudit({
          giftEventId: duplicateGift?.giftEventId ?? null,
          senderId,
          listenerId: duplicateGift?.listenerId ?? null,
          listenerUserId: duplicateGift?.listenerUserId ?? null,
          callId,
          giftId,
          clientRequestId,
          status: 'duplicate',
          reason: 'unique_constraint_replay',
          requestPayload: auditPayload,
        });

        return {
          duplicate: true,
          giftEvent: duplicateGift,
          senderBalance: toMoney(walletResult.rows[0]?.balance || 0),
        };
      }

      await logAudit({
        senderId,
        callId,
        giftId,
        clientRequestId,
        status: 'failed',
        reason: error?.code || error?.message || 'unknown_error',
        requestPayload: auditPayload,
      });

      throw error;
    } finally {
      client.release();
    }
  }
}

export default CallGift;
