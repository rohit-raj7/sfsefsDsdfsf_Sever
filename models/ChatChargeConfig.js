import { pool } from '../db.js';

// ── In-memory cache for chat charge config (avoids DB hit on every message) ──
let _cachedConfig = null;
let _cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000; // 60 seconds

class ChatChargeConfig {
  /**
   * Get the active (latest) chat charge config.
   * Uses in-memory cache (60s TTL) to avoid DB round-trip on every message.
   */
  static async getActive() {
    const now = Date.now();
    if (_cachedConfig && (now - _cacheTimestamp) < CACHE_TTL_MS) {
      return _cachedConfig;
    }

    const result = await pool.query(
      `SELECT config_id, charging_enabled, free_message_limit,
              message_block_size, charge_per_message_block, updated_at
       FROM chat_charge_config
       ORDER BY updated_at DESC
       LIMIT 1`
    );

    if (result.rows.length === 0) {
      // Seed defaults: charging disabled, 5 free messages, ₹1 per 2 messages
      const insertResult = await pool.query(
        `INSERT INTO chat_charge_config
           (charging_enabled, free_message_limit, message_block_size, charge_per_message_block)
         VALUES (FALSE, 5, 2, 1.00)
         RETURNING config_id, charging_enabled, free_message_limit,
                   message_block_size, charge_per_message_block, updated_at`
      );
      _cachedConfig = insertResult.rows[0];
    } else {
      _cachedConfig = result.rows[0];
    }

    _cacheTimestamp = now;
    return _cachedConfig;
  }

  /** Invalidate the in-memory cache (called after admin updates config). */
  static invalidateCache() {
    _cachedConfig = null;
    _cacheTimestamp = 0;
  }

  /**
   * Update (insert new row) chat charge config.
   */
  static async update({ chargingEnabled, freeMessageLimit, messageBlockSize, chargePerMessageBlock }) {
    const result = await pool.query(
      `INSERT INTO chat_charge_config
         (charging_enabled, free_message_limit, message_block_size, charge_per_message_block)
       VALUES ($1, $2, $3, $4)
       RETURNING config_id, charging_enabled, free_message_limit,
                 message_block_size, charge_per_message_block, updated_at`,
      [chargingEnabled, freeMessageLimit, messageBlockSize, chargePerMessageBlock]
    );
    // Invalidate cache so next message picks up the new config
    ChatChargeConfig.invalidateCache();
    return result.rows[0];
  }

  /**
   * Check if a user should be charged and has sufficient balance.
   * Uses GLOBAL per-user counters (total_messages_sent, free_messages_used)
   * stored in the users table — NOT per-chat message counts.
   *
   * This ensures:
   * - Free messages are shared across ALL listeners/conversations
   * - Clearing chat history does NOT reset free message usage
   * - Backend is the single source of truth (no localStorage dependency)
   *
   * IMPORTANT: Only charges users (account_type='user'), NEVER listeners.
   *
   * @param {string} userId
   * @param {string} [accountType] - 'user' | 'listener' — pass to skip DB lookup
   * @returns {{ allowed, charged, chargeAmount, reason?, message?, remainingFreeMessages?, totalMessagesSent?, newBalance? }}
   */
  static async checkAndCharge(userId, accountType) {
    // ── Fast path: use cached config (no DB query when cache is warm) ──
    const config = await ChatChargeConfig.getActive();

    // If charging is disabled globally, allow message immediately
    if (!config.charging_enabled) {
      return { allowed: true, charged: false, chargeAmount: 0 };
    }

    // ── Listeners are NEVER charged ──
    if (accountType === 'listener') {
      return { allowed: true, charged: false, chargeAmount: 0 };
    }

    // If accountType not provided, look it up
    if (!accountType) {
      const userResult = await pool.query(
        `SELECT account_type FROM users WHERE user_id = $1`,
        [userId]
      );
      if (userResult.rows.length === 0) {
        return { allowed: false, charged: false, reason: 'User not found' };
      }
      if (userResult.rows[0].account_type === 'listener') {
        return { allowed: true, charged: false, chargeAmount: 0 };
      }
    }

    // ── Read global user counters ──
    const userRow = await pool.query(
      `SELECT total_messages_sent, free_messages_used FROM users WHERE user_id = $1`,
      [userId]
    );
    if (userRow.rows.length === 0) {
      return { allowed: false, charged: false, reason: 'User not found' };
    }

    const { total_messages_sent, free_messages_used } = userRow.rows[0];
    const freeLimit = Number(config.free_message_limit);
    const blockSize = Number(config.message_block_size);
    const chargePerBlock = Number(config.charge_per_message_block);

    // ── Still within free limit ──
    if (free_messages_used < freeLimit) {
      // Increment counters (free message consumed)
      await pool.query(
        `UPDATE users
         SET total_messages_sent = total_messages_sent + 1,
             free_messages_used = free_messages_used + 1,
             updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );
      return {
        allowed: true,
        charged: false,
        chargeAmount: 0,
        remainingFreeMessages: freeLimit - free_messages_used - 1,
        totalMessagesSent: total_messages_sent + 1
      };
    }

    // ── Past free limit — check if this message falls on a charge boundary ──
    const paidMessages = total_messages_sent - freeLimit;
    // Charge every `blockSize` messages after free limit
    // e.g., if blockSize=2, charge on message 0,2,4,6... (0-indexed past free limit)
    const shouldChargeNow = paidMessages >= 0 && (paidMessages % blockSize) === 0;

    if (!shouldChargeNow) {
      // Within a paid block that was already charged — allow free
      await pool.query(
        `UPDATE users
         SET total_messages_sent = total_messages_sent + 1,
             updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );
      return {
        allowed: true,
        charged: false,
        chargeAmount: 0,
        remainingFreeMessages: 0,
        totalMessagesSent: total_messages_sent + 1
      };
    }

    // ── Need to charge — deduct from wallet atomically ──
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Ensure wallet exists
      await client.query(
        `INSERT INTO wallets (user_id, balance) VALUES ($1, 0.0) ON CONFLICT (user_id) DO NOTHING`,
        [userId]
      );

      // Check balance and deduct atomically
      const walletResult = await client.query(
        `UPDATE wallets
         SET balance = balance - $2, updated_at = NOW()
         WHERE user_id = $1 AND balance >= $2
         RETURNING balance`,
        [userId, chargePerBlock]
      );

      if (walletResult.rows.length === 0) {
        // Insufficient balance — block message
        await client.query('ROLLBACK');
        return {
          allowed: false,
          charged: false,
          chargeAmount: chargePerBlock,
          reason: 'LOW_BALANCE',
          message: 'Insufficient balance. Please recharge.',
          remainingFreeMessages: 0,
          totalMessagesSent: total_messages_sent
        };
      }

      // Record transaction
      await client.query(
        `INSERT INTO transactions
           (user_id, transaction_type, amount, currency, description, status)
         VALUES ($1, 'debit', $2, 'INR', $3, 'completed')`,
        [userId, chargePerBlock, `Chat charge: ₹${chargePerBlock} for ${blockSize} message(s)`]
      );

      // Increment global user counters + set last_charge_applied_at
      await client.query(
        `UPDATE users
         SET total_messages_sent = total_messages_sent + 1,
             last_charge_applied_at = NOW(),
             updated_at = NOW()
         WHERE user_id = $1`,
        [userId]
      );

      await client.query('COMMIT');

      return {
        allowed: true,
        charged: true,
        chargeAmount: chargePerBlock,
        newBalance: Number(walletResult.rows[0].balance),
        remainingFreeMessages: 0,
        totalMessagesSent: total_messages_sent + 1
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export default ChatChargeConfig;
