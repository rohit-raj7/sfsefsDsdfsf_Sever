import { pool } from '../db.js';
import { resolveRateForListener } from './rateSettingsService.js';

const roundMoney = (value) => Number(Number(value || 0).toFixed(2));

const calculateCallCharge = (durationSeconds, userRate, payoutRate, incrementOptions = null) => {
  const seconds = Math.max(0, Math.floor(Number(durationSeconds) || 0));
  const minutes = Math.ceil(seconds / 60);
  const userCharge = roundMoney(minutes * Number(userRate || 0));

  let listenerEarn = 0;
  if (incrementOptions && incrementOptions.interval > 0 && incrementOptions.increment > 0) {
    const { interval, increment, maxRate } = incrementOptions;
    let currentRate = Number(payoutRate || 0);

    for (let m = 1; m <= minutes; m++) {
      if (m > 1 && (m - 1) % interval === 0) {
        currentRate += increment;
        if (maxRate && currentRate > maxRate) {
          currentRate = maxRate;
        }
      }
      listenerEarn += currentRate;
    }
  } else {
    listenerEarn = roundMoney(minutes * Number(payoutRate || 0));
  }

  listenerEarn = roundMoney(listenerEarn);

  return { minutes, userCharge, listenerEarn };
};

const normalizeOfferForCall = (call, caller) => {
  const offerApplied = call.offer_applied === true;
  const offerMinutesLimit = Number(call.offer_minutes_limit || 0);
  const offerFlatPrice = Number(call.offer_flat_price || 0);
  const callerEligible = caller && caller.is_first_time_user && !caller.offer_used;

  const validOffer = offerApplied
    && callerEligible
    && Number.isFinite(offerMinutesLimit)
    && offerMinutesLimit > 0
    && Number.isFinite(offerFlatPrice)
    && offerFlatPrice > 0;

  return {
    applied: validOffer,
    minutesLimit: validOffer ? offerMinutesLimit : 0,
    flatPrice: validOffer ? offerFlatPrice : 0,
  };
};

const calculateUserChargeWithOffer = (minutes, normalUserRate, offer) => {
  const normalizedMinutes = Math.max(0, Number(minutes) || 0);
  const normalRate = Number(normalUserRate || 0);

  if (!offer?.applied) {
    return roundMoney(normalizedMinutes * normalRate);
  }

  if (normalizedMinutes <= offer.minutesLimit) {
    return roundMoney(offer.flatPrice);
  }

  const overflowMinutes = normalizedMinutes - offer.minutesLimit;
  return roundMoney(offer.flatPrice + (overflowMinutes * normalRate));
};

const calculateAffordableMinutes = (walletBalance, normalUserRate, offer) => {
  const balance = Math.max(0, Number(walletBalance) || 0);
  const normalRate = Number(normalUserRate || 0);

  if (!Number.isFinite(normalRate) || normalRate <= 0) return 0;

  if (!offer?.applied) {
    return Math.max(0, Math.floor(balance / normalRate));
  }

  if (balance < offer.flatPrice) return 0;

  const overflowMinutes = Math.max(0, Math.floor((balance - offer.flatPrice) / normalRate));
  return offer.minutesLimit + overflowMinutes;
};

const fetchOrCreateWallet = async (client, userId) => {
  const walletResult = await client.query(
    'SELECT wallet_id, balance FROM wallets WHERE user_id = $1 FOR UPDATE',
    [userId]
  );

  if (walletResult.rows.length > 0) {
    return walletResult.rows[0];
  }

  const created = await client.query(
    'INSERT INTO wallets (user_id, balance) VALUES ($1, 0.0) RETURNING wallet_id, balance',
    [userId]
  );
  return created.rows[0];
};

const getExistingBilling = async (client, callId) => {
  const existing = await client.query(
    'SELECT minutes, user_charge, listener_earn FROM call_records WHERE call_id = $1',
    [callId]
  );
  return existing.rows[0] || null;
};

// Calculate maximum affordable call duration based on wallet balance.
// Supports first-time-offer shape so server auto-disconnect is aligned with billing math.
const calculateMaxCallDuration = async (callerId, rateInput) => {
  try {
    const userResult = await pool.query(
      'SELECT unlimited_expires_at FROM users WHERE user_id = $1',
      [callerId]
    );
    const unlimitedExpiresAt = userResult.rows.length > 0 ? userResult.rows[0].unlimited_expires_at : null;
    const isUnlimitedActive = unlimitedExpiresAt && new Date(unlimitedExpiresAt) > new Date();

    const walletResult = await pool.query(
      'SELECT balance FROM wallets WHERE user_id = $1',
      [callerId]
    );

    const balance = walletResult.rows.length > 0
      ? Number(walletResult.rows[0].balance)
      : 0;

    const legacyRate = Number(rateInput);
    const normalRate = Number(
      typeof rateInput === 'object'
        ? (rateInput.normalRate ?? rateInput.fallbackRate ?? 0)
        : rateInput
    );
    const offerApplied = Boolean(
      typeof rateInput === 'object' && rateInput.offerApplied === true
    );
    const offerMinutesLimit = Number(
      typeof rateInput === 'object' ? rateInput.offerMinutesLimit : 0
    );
    const offerFlatPrice = Number(
      typeof rateInput === 'object' ? rateInput.offerFlatPrice : 0
    );

    if (isUnlimitedActive) {
      // Massive buffer for unlimited
      const maxAllowedSeconds = 24 * 60 * 60;
      console.log(`[BILLING] VIP UNLIMITED user=${callerId} maxCallDuration → ${maxAllowedSeconds}s`);
      return { maxAllowedSeconds, balance, rate: normalRate || legacyRate || 0, isUnlimited: true };
    }

    if (balance <= 0) return { maxAllowedSeconds: 0, balance, rate: normalRate || legacyRate || 0 };

    // Offer-aware wallet cap:
    // first N minutes cost flat price, then normal per-minute charging.
    const hasValidOffer = offerApplied
      && Number.isFinite(offerMinutesLimit)
      && offerMinutesLimit > 0
      && Number.isFinite(offerFlatPrice)
      && offerFlatPrice > 0
      && Number.isFinite(normalRate)
      && normalRate > 0;

    if (hasValidOffer) {
      if (balance < offerFlatPrice) {
        return { maxAllowedSeconds: 0, balance, rate: normalRate };
      }

      // Same style as legacy path: allow fractional seconds in overflow segment.
      const overflowSeconds = Math.max(
        0,
        Math.floor(((balance - offerFlatPrice) / normalRate) * 60)
      );
      const maxAllowedSeconds = (offerMinutesLimit * 60) + overflowSeconds;

      console.log(
        `[BILLING] maxCallDuration(offer): user=${callerId} balance=₹${balance} flat=₹${offerFlatPrice}/${offerMinutesLimit}m normal=₹${normalRate}/min → ${maxAllowedSeconds}s`
      );
      return { maxAllowedSeconds, balance, rate: normalRate };
    }

    const rate = Number.isFinite(normalRate) && normalRate > 0
      ? normalRate
      : legacyRate;
    if (!Number.isFinite(rate) || rate <= 0) return { maxAllowedSeconds: 0, balance, rate: 0 };

    // Pro-rata calculation: allow the full fractional time the wallet can afford
    // e.g., ₹5 at ₹4/min = 1.25 min × 60 = 75 seconds
    // Billing uses Math.ceil for minute rounding, but the wallet-cap in
    // finalizeCallBilling ensures we never charge more than the wallet holds.
    const maxAllowedSeconds = Math.max(0, Math.floor((balance / rate) * 60));

    console.log(`[BILLING] maxCallDuration: user=${callerId} balance=₹${balance} rate=₹${rate}/min → ${maxAllowedSeconds}s`);

    return { maxAllowedSeconds, balance, rate };
  } catch (error) {
    console.error(`[BILLING] calculateMaxCallDuration error:`, error);
    const fallbackRate = Number(
      typeof rateInput === 'object'
        ? (rateInput.normalRate ?? rateInput.fallbackRate ?? 0)
        : rateInput
    );
    return { maxAllowedSeconds: 0, balance: 0, rate: Number.isFinite(fallbackRate) ? fallbackRate : 0 };
  }
};

// Mark call as started with server-authoritative timestamp
const markCallStarted = async (callId) => {
  try {
    const result = await pool.query(
      `UPDATE calls
       SET status = 'ongoing', started_at = CURRENT_TIMESTAMP
       WHERE call_id = $1 AND status IN ('pending', 'ringing')
       RETURNING call_id, started_at, rate_per_minute, billed_user_rate_per_min,
                 offer_applied, offer_flat_price, offer_minutes_limit,
                 caller_id, listener_id`,
      [callId]
    );

    if (result.rows.length === 0) {
      // Call might already be ongoing — return existing data
      const existing = await pool.query(
        `SELECT call_id, started_at, rate_per_minute, billed_user_rate_per_min,
                offer_applied, offer_flat_price, offer_minutes_limit,
                caller_id, listener_id
         FROM calls
         WHERE call_id = $1`,
        [callId]
      );
      return existing.rows[0] || null;
    }

    console.log(`[BILLING] Call ${callId} marked as started at ${result.rows[0].started_at}`);
    return result.rows[0];
  } catch (error) {
    console.error(`[BILLING] markCallStarted error for call ${callId}:`, error);
    return null;
  }
};

const finalizeCallBilling = async ({ callId, durationSeconds }) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const callResult = await client.query(
      'SELECT * FROM calls WHERE call_id = $1 FOR UPDATE',
      [callId]
    );

    if (callResult.rows.length === 0) {
      const error = new Error('Call not found');
      error.code = 'CALL_NOT_FOUND';
      throw error;
    }

    const call = callResult.rows[0];

    // Server-authoritative duration: prefer started_at from DB over frontend value
    if (call.started_at) {
      const serverMs = Date.now() - new Date(call.started_at).getTime();
      const serverDuration = Math.max(0, Math.round(serverMs / 1000));
      const clientDuration = durationSeconds;
      // Use the LESSER of server and frontend duration to prevent overcharging;
      // server value is ground truth, but API latency can inflate it slightly
      durationSeconds = clientDuration > 0
        ? Math.min(serverDuration, clientDuration)
        : serverDuration;
      console.log(`[BILLING] Duration resolved: server=${serverDuration}s, client=${clientDuration}s → effective=${durationSeconds}s`);
    }

    const existingBilling = await getExistingBilling(client, callId);
    if (existingBilling) {
      await client.query('COMMIT');
      return {
        alreadyBilled: true,
        minutes: Number(existingBilling.minutes),
        userCharge: roundMoney(existingBilling.user_charge),
        listenerEarn: roundMoney(existingBilling.listener_earn)
      };
    }

    const listenerResult = await client.query(
      `SELECT listener_id
       FROM listeners
       WHERE listener_id = $1
       FOR UPDATE`,
      [call.listener_id]
    );

    if (listenerResult.rows.length === 0) {
      console.error(`[BILLING] Listener not found for call ${callId}, listener_id=${call.listener_id}`);
      const error = new Error('Listener not found for billing');
      error.code = 'LISTENER_NOT_FOUND';
      throw error;
    }

    // Keep billing deterministic: prefer the rates snapshotted at call creation.
    // Only fall back to live rule resolution for legacy calls missing snapshots.
    let userRate = Number(call.billed_user_rate_per_min || call.rate_per_minute || 0);
    let payoutRate = Number(call.billed_payout_rate_per_min || 0);

    const resolvedRates = await resolveRateForListener(call.listener_id, client);

    if (!Number.isFinite(userRate) || userRate <= 0 || !Number.isFinite(payoutRate) || payoutRate <= 0) {
      if (!Number.isFinite(userRate) || userRate <= 0) {
        userRate = Number(resolvedRates?.userRate || 0);
      }
      if (!Number.isFinite(payoutRate) || payoutRate <= 0) {
        payoutRate = Number(resolvedRates?.payoutRate || 0);
      }
    }

    if (!Number.isFinite(userRate) || userRate <= 0) {
      console.error(`[BILLING] Invalid user rate for listener ${call.listener_id}. Active rate rules/global fallback must be configured by admin.`);
      const error = new Error('Invalid user rate for billing');
      error.code = 'INVALID_USER_RATE';
      throw error;
    }

    if (!Number.isFinite(payoutRate) || payoutRate <= 0) {
      console.error(`[BILLING] Invalid payout rate for listener ${call.listener_id}. Active rate rules/global fallback must be configured by admin.`);
      const error = new Error('Invalid payout rate for billing');
      error.code = 'INVALID_PAYOUT_RATE';
      throw error;
    }

    const callerResult = await client.query(
      `SELECT is_first_time_user, offer_used, unlimited_expires_at
       FROM users
       WHERE user_id = $1
       FOR UPDATE`,
      [call.caller_id]
    );
    const caller = callerResult.rows[0];
    const isUnlimitedActive = caller && caller.unlimited_expires_at && new Date(caller.unlimited_expires_at) > new Date();
    const offer = normalizeOfferForCall(call, caller);
    const offerApplied = offer.applied;

    const incrementOptions = resolvedRates ? {
      interval: Number(resolvedRates.incrementIntervalMins || 0),
      increment: Number(resolvedRates.payoutIncrement || 0),
      maxRate: Number(resolvedRates.maxPayoutRate || 0),
    } : null;

    const { minutes, listenerEarn } = calculateCallCharge(
      durationSeconds,
      userRate,
      payoutRate,
      incrementOptions
    );
    const userCharge = calculateUserChargeWithOffer(minutes, userRate, offer);

    // Log the billing calculation for audit trail
    console.log(`[BILLING] call=${callId} | duration=${durationSeconds}s → ${minutes}min | userRate=₹${userRate}/min → charge=₹${userCharge} | payoutRate=₹${payoutRate}/min → listenerEarn=₹${listenerEarn} | commission=₹${(userCharge - listenerEarn).toFixed(2)}`);

    // ── Wallet-capped billing ──
    // Cap billing to wallet balance so connected calls NEVER fail with INSUFFICIENT_BALANCE.
    // Instead of rejecting the entire transaction, bill only what the wallet can afford.
    const wallet = await fetchOrCreateWallet(client, call.caller_id);
    const walletBalance = Number(wallet.balance);

    let billedMinutes = minutes;
    let billedUserCharge = userCharge;
    let billedListenerEarn = listenerEarn;

    if (isUnlimitedActive) {
      billedUserCharge = 0; // VIP users pay 0
      console.log(`[BILLING] VIP UNLIMITED: user=${call.caller_id} charged ₹0. Listener=${call.listener_id} earns ₹${billedListenerEarn}`);
    } else if (walletBalance < userCharge && userCharge > 0) {
      const affordableMinutes = calculateAffordableMinutes(walletBalance, userRate, offer);
      billedMinutes = affordableMinutes;
      billedUserCharge = calculateUserChargeWithOffer(billedMinutes, userRate, offer);
      billedListenerEarn = roundMoney(billedMinutes * payoutRate);
      console.log(`[BILLING] CAPPED: wallet=₹${walletBalance} < charge=₹${userCharge}. Capped to ${billedMinutes}min → user=₹${billedUserCharge}, listener=₹${billedListenerEarn}`);
    }

    // Deduct user wallet (skip if nothing to charge)
    if (billedUserCharge > 0) {
      const walletUpdate = await client.query(
        `UPDATE wallets
         SET balance = balance - $2, updated_at = NOW()
         WHERE user_id = $1 AND balance >= $2
         RETURNING balance`,
        [call.caller_id, billedUserCharge]
      );

      if (walletUpdate.rows.length === 0) {
        // Race condition: another transaction deducted between our read and write
        // Fall back to zero billing rather than failing the whole call
        console.log(`[BILLING] WARNING: Wallet race condition for user ${call.caller_id}. Zeroing billing.`);
        billedMinutes = 0;
        billedUserCharge = 0;
        billedListenerEarn = 0;
      } else {
        const updatedUserBalance = walletUpdate.rows[0].balance;
        await client.query(
          'UPDATE users SET wallet_balance = $2 WHERE user_id = $1',
          [call.caller_id, updatedUserBalance]
        );

        // Record debit transaction for audit trail
        await client.query(
          `INSERT INTO transactions (user_id, transaction_type, amount, currency, description, status, related_call_id)
           VALUES ($1, 'debit', $2, 'INR', $3, 'completed', $4)`,
          [call.caller_id, billedUserCharge, `Call charge (${billedMinutes} min)`, callId]
        );
      }
    }

    // Credit listener wallet (skip if nothing to credit)
    if (billedListenerEarn > 0) {
      const listenerUpdate = await client.query(
        `UPDATE listeners
         SET wallet_balance = wallet_balance + $2,
             total_earning = total_earning + $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE listener_id = $1
         RETURNING wallet_balance, total_earning`,
        [call.listener_id, billedListenerEarn]
      );

      if (listenerUpdate.rows.length === 0) {
        console.error(`[BILLING] CRITICAL: Listener ${call.listener_id} wallet update returned 0 rows. User charged ₹${billedUserCharge} but listener not credited.`);
      }
    }

    // Update call record
    await client.query(
      `UPDATE calls
       SET status = 'completed',
           duration_seconds = $2,
           billed_minutes = $3,
           total_cost = $4,
           rate_per_minute = $5,
           billed_user_rate_per_min = $5,
           billed_payout_rate_per_min = $6,
           ended_at = CURRENT_TIMESTAMP
        WHERE call_id = $1`,
      [callId, durationSeconds, billedMinutes, billedUserCharge, userRate, payoutRate]
    );

    // Create immutable billing record (unique index on call_id prevents duplicates)
    await client.query(
      `INSERT INTO call_records (
         call_id, user_id, listener_id, minutes, user_charge, listener_earn, started_at, ended_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)`,
      [
        callId,
        call.caller_id,
        call.listener_id,
        billedMinutes,
        billedUserCharge,
        billedListenerEarn,
        call.started_at
      ]
    );

    // Audit log
    await client.query(
      `INSERT INTO call_billing_audit (
         call_id, user_id, listener_id, minutes, user_charge, listener_earn, user_rate_per_min, listener_payout_per_min
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        callId,
        call.caller_id,
        call.listener_id,
        billedMinutes,
        billedUserCharge,
        billedListenerEarn,
        userRate,
        payoutRate
      ]
    );

    // Mark offer as used INSIDE the transaction to prevent race conditions
    // This ensures a user can only ever get the offer rate on one call
    if (offerApplied) {
      await client.query(
        `UPDATE users SET offer_used = TRUE, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1`,
        [call.caller_id]
      );
      console.log(`[BILLING] Marked offer_used=true for user ${call.caller_id} (inside transaction)`);
    }

    await client.query('COMMIT');

    return {
      alreadyBilled: false,
      minutes: billedMinutes,
      userCharge: billedUserCharge,
      listenerEarn: billedListenerEarn
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

export { calculateCallCharge, finalizeCallBilling, calculateMaxCallDuration, markCallStarted };

