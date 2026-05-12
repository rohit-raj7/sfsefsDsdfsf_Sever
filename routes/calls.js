import express from 'express';
const router = express.Router();
import { AccessToken } from 'livekit-server-sdk';
import Call from '../models/Call.js';
import Rating from '../models/Rating.js';
import Listener from '../models/Listener.js';
import User from '../models/User.js';
import { authenticate, authenticateAdmin } from '../middleware/auth.js';
import config from '../config/config.js';
import { finalizeCallBilling } from '../services/callBillingService.js';
import { getRateConfig, pool } from '../db.js';
import { resolveRateForListener } from '../services/rateSettingsService.js';

const resolveDurationSeconds = (call, durationSeconds) => {
  const endedAt = new Date();
  if (call.started_at) {
    return Math.max(
      0,
      Math.round((endedAt.getTime() - new Date(call.started_at).getTime()) / 1000)
    );
  }
  if (call.created_at) {
    return Math.max(
      0,
      Math.round((endedAt.getTime() - new Date(call.created_at).getTime()) / 1000)
    );
  }
  if (durationSeconds !== undefined) {
    return Math.max(0, Number(durationSeconds) || 0);
  }
  return 0;
};

// POST /api/calls
// Initiate a new call
router.post('/', authenticate, async (req, res) => {
  try {
    const { listener_id, call_type } = req.body;

    if (!listener_id) {
      return res.status(400).json({ error: 'listener_id is required' });
    }

    // Get listener details for rate
    const listener = await Listener.findById(listener_id);

    if (!listener) {
      return res.status(404).json({ error: 'Experts not found' });
    }

    // VERIFICATION CHECK: Block calls to non-approved listeners
    // Only listeners with verificationStatus = 'approved' can receive calls
    const verificationStatus = listener.verification_status || 'approved'; // Backward compatibility
    if (verificationStatus !== 'approved') {
      console.log(`[CALLS] Call blocked: Listener ${listener_id} not approved (status: ${verificationStatus})`);
      return res.status(403).json({
        error: 'Listener not approved yet',
        details: 'This listener is currently under verification and cannot receive calls.'
      });
    }

    if (!listener.is_available || !listener.is_online) {
      console.log(`[CALLS] Experts ${listener.listener_id} unavailable: available=${listener.is_available}, online=${listener.is_online}`);
      return res.status(400).json({
        error: 'Experts is not available',
        details: { is_available: listener.is_available, is_online: listener.is_online }
      });
    }

    // BUSY CHECK: Block calls to listeners already in an active call
    if (listener.is_busy) {
      console.log(`[CALLS] Experts ${listener.listener_id} is BUSY â€” rejecting call`);
      return res.status(409).json({
        error: 'Experts is busy',
        status: 'busy',
        details: 'This listener is currently on another call. Please try again later.'
      });
    }

    const resolvedRates = await resolveRateForListener(listener.listener_id);
    const userRate = Number(resolvedRates?.userRate || 0);
    const payoutRate = Number(resolvedRates?.payoutRate || 0);
    if (!Number.isFinite(userRate) || userRate <= 0) {
      return res.status(500).json({ error: 'Experts rate is invalid' });
    }
    if (!Number.isFinite(payoutRate) || payoutRate <= 0) {
      return res.status(500).json({ error: 'Experts payout rate is invalid' });
    }

    // Check if user is eligible for first-time offer
    const caller = await User.findById(req.userId);
    const rateConfig = await getRateConfig();
    const isOfferEligible = caller && caller.is_first_time_user && !caller.offer_used
      && rateConfig.first_time_offer_enabled
      && rateConfig.offer_minutes_limit > 0
      && Number(rateConfig.offer_flat_price) > 0;

    const offerFlatPrice = isOfferEligible ? Number(rateConfig.offer_flat_price) : null;
    const offerMinutesLimit = isOfferEligible ? Number(rateConfig.offer_minutes_limit) : null;
    const effectiveRate = isOfferEligible
      ? Number(rateConfig.offer_flat_price) / rateConfig.offer_minutes_limit
      : userRate;

    const wallet = await User.getWallet(req.userId);
    const availableBalance = parseFloat(wallet.balance || 0);
    const minBalanceToStart = isOfferEligible ? offerFlatPrice : effectiveRate;
    if (availableBalance < minBalanceToStart) {
      return res.status(402).json({
        error: 'Low balance',
        details: `Minimum balance of â‚¹${Number(minBalanceToStart || 0).toFixed(2)} is required to start a call`
      });
    }

    // Create call and snapshot both normal/payout rates and offer terms.
    const call = await Call.create({
      caller_id: req.userId,
      listener_id,
      call_type: call_type || 'audio',
      rate_per_minute: effectiveRate,
      billed_user_rate_per_min: userRate,
      billed_payout_rate_per_min: payoutRate,
      offer_applied: isOfferEligible,
      offer_flat_price: offerFlatPrice,
      offer_minutes_limit: offerMinutesLimit,
    });

    // AUTO-DISCONNECT: If call is not answered within 45 seconds, automatically fail it
    setTimeout(async () => {
      try {
        const checkCall = await Call.findById(call.call_id);
        if (
          checkCall &&
          ['pending', 'ringing', 'initiated'].includes(checkCall.status)
        ) {
          console.log(`[CALLS] Call ${call.call_id} timed out after 45s. Marking missed.`);
          await Call.updateStatus(call.call_id, 'missed');
          try { await Listener.clearBusy(listener_id); } catch (e) { }
        }
      } catch (err) {
        console.error('[CALLS] Auto-timeout error:', err);
      }
    }, 45000);

    res.status(201).json({
      message: 'Call initiated',
      call
    });
  } catch (error) {
    console.error('Create call error:', error);
    res.status(500).json({ error: 'Failed to initiate call' });
  }
});

// POST /api/calls/listener-initiate
// Initiate a new call from a Listener to a User
router.post('/listener-initiate', authenticate, async (req, res) => {
  try {
    const { target_user_id, call_type } = req.body;

    if (!target_user_id) {
      return res.status(400).json({ error: 'target_user_id is required' });
    }

    // Ensure the requester is actually a listener
    const listener = await Listener.findByUserId(req.userId);
    if (!listener) {
      return res.status(403).json({ error: 'Only listeners can initiate this type of call' });
    }

    const verificationStatus = listener.verification_status || 'approved';
    if (verificationStatus !== 'approved') {
      return res.status(403).json({
        error: 'Experts not approved yet',
        details: 'You are currently under verification and cannot initiate calls.'
      });
    }

    // Find the target user
    const targetUser = await User.findById(target_user_id);
    if (!targetUser) {
      return res.status(404).json({ error: 'Target user not found' });
    }

    // BUSY CHECK: Block if listener is already busy
    if (listener.is_busy) {
      return res.status(409).json({
        error: 'You are busy',
        status: 'busy',
        details: 'You are currently on another call.'
      });
    }

    // BUSY CHECK: Block only when the user is actually connected to another call.
    // Pending/ringing calls are not treated as "busy" for listener-side discovery.
    const activeUserCalls = await pool.query(
      `SELECT call_id FROM calls WHERE caller_id = $1 AND status = 'ongoing' LIMIT 1`,
      [target_user_id]
    );
    if (activeUserCalls.rows.length > 0) {
      return res.status(409).json({
        error: 'User is busy',
        status: 'busy',
        details: 'The user is currently on another call.'
      });
    }

    // Calculate effective rate (the user will pay this, the listener earns from this)
    const resolvedRates = await resolveRateForListener(listener.listener_id);
    const userRate = Number(resolvedRates?.userRate || 0);
    const payoutRate = Number(resolvedRates?.payoutRate || 0);
    if (!Number.isFinite(userRate) || userRate <= 0) {
      return res.status(500).json({ error: 'Experts rate is invalid' });
    }
    if (!Number.isFinite(payoutRate) || payoutRate <= 0) {
      return res.status(500).json({ error: 'Experts payout rate is invalid' });
    }

    const rateConfig = await getRateConfig();
    const isOfferEligible = targetUser && targetUser.is_first_time_user && !targetUser.offer_used
      && rateConfig.first_time_offer_enabled
      && rateConfig.offer_minutes_limit > 0
      && Number(rateConfig.offer_flat_price) > 0;

    const offerFlatPrice = isOfferEligible ? Number(rateConfig.offer_flat_price) : null;
    const offerMinutesLimit = isOfferEligible ? Number(rateConfig.offer_minutes_limit) : null;
    const effectiveRate = isOfferEligible
      ? Number(rateConfig.offer_flat_price) / rateConfig.offer_minutes_limit
      : userRate;

    // Create call — caller_id is target_user_id (User pays), listener_id is listener
    const call = await Call.create({
      caller_id: target_user_id,
      listener_id: listener.listener_id,
      call_type: call_type || 'audio',
      rate_per_minute: effectiveRate,
      billed_user_rate_per_min: userRate,
      billed_payout_rate_per_min: payoutRate,
      offer_applied: isOfferEligible,
      offer_flat_price: offerFlatPrice,
      offer_minutes_limit: offerMinutesLimit,
    });

    // AUTO-DISCONNECT
    setTimeout(async () => {
      try {
        const checkCall = await Call.findById(call.call_id);
        if (
          checkCall &&
          ['pending', 'ringing', 'initiated'].includes(checkCall.status)
        ) {
          console.log(`[CALLS] Listener-initiated call ${call.call_id} timed out after 45s.`);
          await Call.updateStatus(call.call_id, 'missed');
        }
      } catch (err) {
        console.error('[CALLS] Auto-timeout error:', err);
      }
    }, 45000);

    res.status(201).json({
      message: 'Call initiated by listener',
      call
    });
  } catch (error) {
    console.error('Create listener-initiated call error:', error);
    res.status(500).json({ error: 'Failed to initiate call' });
  }
});


// GET /api/calls/:call_id
// Get call details
router.get('/:call_id', authenticate, async (req, res) => {
  try {
    const call = await Call.findById(req.params.call_id);

    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    // Check if user is part of the call (as caller or listener)
    const listener = await Listener.findByUserId(req.userId);
    const isListener = listener && call.listener_id === listener.listener_id;

    if (call.caller_id !== req.userId && !isListener) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json({ call });
  } catch (error) {
    console.error('Get call error:', error);
    res.status(500).json({ error: 'Failed to fetch call' });
  }
});

// PUT /api/calls/:call_id/status
// Update call status
router.put('/:call_id/status', authenticate, async (req, res) => {
  try {
    const { status, duration_seconds } = req.body;

    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }

    const validStatuses = ['pending', 'ringing', 'ongoing', 'completed', 'missed', 'rejected', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Get call and verify user is part of it
    const call = await Call.findById(req.params.call_id);

    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    // Check if user is caller or listener
    const listener = await Listener.findByUserId(req.userId);
    const isListener = listener && call.listener_id === listener.listener_id;

    if (call.caller_id !== req.userId && !isListener) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (status === 'completed') {
      const resolvedDurationSeconds = resolveDurationSeconds(call, duration_seconds);
      const billing = await finalizeCallBilling({
        callId: req.params.call_id,
        durationSeconds: resolvedDurationSeconds
      });

      if (!billing.alreadyBilled) {
        await Listener.incrementCallStats(call.listener_id, billing.minutes);
      }

      // PROBATION: Decrement remaining probation calls
      try {
        await pool.query(
          `UPDATE listeners SET probation_calls_remaining = GREATEST(probation_calls_remaining - 1, 0)
           WHERE listener_id = $1 AND quality_status = 'probation'`,
          [call.listener_id]
        );
      } catch (e) { console.error('[CALLS] probation tracking error:', e.message); }

      // BUSY: Clear busy when call completes
      try { await Listener.clearBusy(call.listener_id); } catch (e) { console.error('[CALLS] clearBusy error:', e.message); }

      const updatedCall = await Call.findById(req.params.call_id);
      return res.json({
        message: 'Call status updated',
        call: updatedCall,
        billing: {
          minutes: billing.minutes,
          userCharge: billing.userCharge,
          // FIX: Include listenerEarn and platformCommission so listener
          // dashboard can show correct payout without frontend calculation.
          // listenerEarn is computed using admin-set listener_payout_per_min
          // from the DB â€” never from frontend values.
          listenerEarn: billing.listenerEarn,
          platformCommission: billing.userCharge - billing.listenerEarn,
          durationSeconds: resolvedDurationSeconds
        }
      });
    }

    // BUSY: Set busy when call becomes ongoing, clear on terminal states
    if (status === 'ongoing') {
      try { await Listener.setBusy(call.listener_id); } catch (e) { console.error('[CALLS] setBusy error:', e.message); }
    } else if (['rejected', 'missed', 'cancelled'].includes(status)) {
      try { await Listener.clearBusy(call.listener_id); } catch (e) { console.error('[CALLS] clearBusy error:', e.message); }
    }

    const updatedCall = await Call.updateStatus(req.params.call_id, status);

    res.json({
      message: 'Call status updated',
      call: updatedCall
    });
  } catch (error) {
    console.error('Update call status error:', error);
    if (error.code === 'INSUFFICIENT_BALANCE') {
      return res.status(402).json({ error: 'Insufficient balance to complete billing' });
    }
    res.status(500).json({ error: 'Failed to update call status' });
  }
});

// POST /api/calls/end
// Finalize call billing with duration
router.post('/end', authenticate, async (req, res) => {
  try {
    const { callId, durationSeconds } = req.body || {};

    if (!callId) {
      return res.status(400).json({ error: 'callId is required' });
    }

    const call = await Call.findById(callId);
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const listener = await Listener.findByUserId(req.userId);
    const isListener = listener && call.listener_id === listener.listener_id;

    if (call.caller_id !== req.userId && !isListener) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const resolvedDurationSeconds = resolveDurationSeconds(call, durationSeconds);
    const billing = await finalizeCallBilling({
      callId,
      durationSeconds: resolvedDurationSeconds
    });

    if (!billing.alreadyBilled) {
      await Listener.incrementCallStats(call.listener_id, billing.minutes);
      // offer_used is now marked atomically inside callBillingService transaction
    }

    const updatedCall = await Call.findById(callId);

    // BUSY: Clear busy when call ends
    try { await Listener.clearBusy(call.listener_id); } catch (e) { console.error('[CALLS] clearBusy error:', e.message); }

    res.json({
      message: 'Call ended',
      call: updatedCall,
      billing: {
        minutes: billing.minutes,
        userCharge: billing.userCharge,
        // FIX: Include listenerEarn and platformCommission so listener
        // dashboard can show correct payout without frontend calculation.
        // listenerEarn is computed using admin-set listener_payout_per_min
        // from the DB â€” never from frontend values.
        listenerEarn: billing.listenerEarn,
        platformCommission: billing.userCharge - billing.listenerEarn,
        durationSeconds: resolvedDurationSeconds
      }
    });
  } catch (error) {
    console.error('End call error:', error);
    if (error.code === 'INSUFFICIENT_BALANCE') {
      return res.status(402).json({ error: 'Insufficient balance to complete billing' });
    }
    if (error.code === 'CALL_NOT_FOUND') {
      return res.status(404).json({ error: 'Call not found' });
    }
    res.status(500).json({ error: 'Failed to end call' });
  }
});

// GET /api/calls/history/me
// Get user's call history
router.get('/history/me', authenticate, async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit) : 20;
    const offset = req.query.offset ? parseInt(req.query.offset) : 0;

    const calls = await Call.getUserCallHistory(req.userId, limit, offset);

    res.json({
      calls,
      count: calls.length
    });
  } catch (error) {
    console.error('Get call history error:', error);
    res.status(500).json({ error: 'Failed to fetch call history' });
  }
});

// GET /api/calls/history/listener
// Get listener's call history (for listeners to see their callers)
router.get('/history/listener', authenticate, async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit) : 20;
    const offset = req.query.offset ? parseInt(req.query.offset) : 0;

    // Get listener_id for this user
    const listener = await Listener.findByUserId(req.userId);

    if (!listener) {
      return res.status(404).json({ error: 'Listener profile not found' });
    }

    const history = await Call.getListenerCallHistory(
      listener.listener_id,
      limit,
      offset
    );

    res.json({
      calls: history.calls,
      count: history.totalCount
    });
  } catch (error) {
    console.error('Get listener call history error:', error);
    res.status(500).json({ error: 'Failed to fetch call history' });
  }
});

// ==========================================
// ADMIN REAL-TIME OVERSIGHT & ZOMBIE SWEEPER
// ==========================================

// GET /api/calls/admin/active
// Get all currently active/ongoing calls in the system (Admin only)
router.get('/admin/active', authenticateAdmin, async (req, res) => {
  try {

    const query = `
      SELECT 
        c.call_id, c.call_type, c.status, c.created_at, c.rate_per_minute, c.duration_seconds,
        COALESCE(u.display_name, u.full_name) as caller_name, COALESCE(u.mobile_number, u.phone_number) as caller_phone,
        COALESCE(l.professional_name, 'Unknown') as listener_name, l.total_calls as listener_calls
      FROM calls c
      JOIN users u ON c.caller_id = u.user_id
      JOIN listeners l ON c.listener_id = l.listener_id
      WHERE c.status IN ('ongoing', 'initiated', 'ringing')
      ORDER BY c.created_at DESC
    `;

    const result = await pool.query(query);
    res.json({ active_calls: result.rows });
  } catch (error) {
    console.error('[ADMIN] Fetch active calls error:', error);
    res.status(500).json({ error: 'Failed to fetch active calls' });
  }
});

// POST /api/calls/admin/zombie-sweep
// Forcibly clean up stuck calls (ongoing for > 2 hours) and un-brick listeners (Admin only)
router.post('/admin/zombie-sweep', authenticateAdmin, async (req, res) => {
  try {

    // Find calls stuck for > 2 hours
    const zombieQuery = `
      SELECT call_id, listener_id, status, created_at
      FROM calls 
      WHERE status IN ('ongoing', 'initiated', 'ringing')
        AND created_at < NOW() - INTERVAL '2 hours'
    `;
    const zombies = await pool.query(zombieQuery);

    if (zombies.rows.length === 0) {
      return res.json({ message: 'No zombie calls found. System is clean.', swept: 0 });
    }

    const sweptIds = [];
    for (const z of zombies.rows) {
      // Mark call as cancelled (it never naturally ended)
      await Call.updateStatus(z.call_id, 'cancelled');

      // CRITICAL: Unbrick the listener by forcefully clearing is_busy
      try {
        await Listener.clearBusy(z.listener_id);
      } catch (e) {
        console.error(`[ZOMBIE SWEEPER] Failed to clear busy for listener ${z.listener_id}:`, e.message);
      }

      sweptIds.push(z.call_id);
    }

    res.json({
      message: `Successfully swept ${sweptIds.length} zombie call(s). Listeners un-bricked.`,
      swept_count: sweptIds.length,
      swept_call_ids: sweptIds
    });
  } catch (error) {
    console.error('[ZOMBIE SWEEPER] Error:', error);
    res.status(500).json({ error: 'Failed to run zombie sweep' });
  }
});

// GET /api/calls/active/me
// Get user's active calls
router.get('/active/me', authenticate, async (req, res) => {
  try {
    const calls = await Call.getActiveCalls(req.userId);

    res.json({
      calls,
      count: calls.length
    });
  } catch (error) {
    console.error('Get active calls error:', error);
    res.status(500).json({ error: 'Failed to fetch active calls' });
  }
});

// POST /api/calls/:call_id/rating
// Rate a completed call
router.post('/:call_id/rating', authenticate, async (req, res) => {
  try {
    const { rating, review_text } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    // Get call details
    const call = await Call.findById(req.params.call_id);

    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    if (call.caller_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (call.status !== 'completed') {
      return res.status(400).json({ error: 'Can only rate completed calls' });
    }

    // Check if already rated
    const alreadyRated = await Rating.isCallRated(req.params.call_id);
    if (alreadyRated) {
      return res.status(400).json({ error: 'Call already rated' });
    }

    // Create rating
    const ratingRecord = await Rating.create({
      call_id: req.params.call_id,
      listener_id: call.listener_id,
      user_id: req.userId,
      rating: parseFloat(rating),
      review_text
    });

    // Update listener's average rating and total ratings
    const averageData = await Rating.getListenerAverageRating(call.listener_id);
    await Listener.updateRatingStats(call.listener_id, averageData.average_rating, averageData.total_ratings);

    res.status(201).json({
      message: 'Rating submitted successfully',
      rating: ratingRecord
    });
  } catch (error) {
    console.error('Create rating error:', error);
    res.status(500).json({ error: 'Failed to submit rating' });
  }
});

// POST /api/calls/random
// Initiate a random call with a random listener
router.post('/random', authenticate, async (req, res) => {
  try {
    const { call_type } = req.body;

    // Get a random available listener
    const listeners = await Listener.getRandomAvailable(1);

    if (listeners.length === 0) {
      return res.status(404).json({ error: 'No available listeners found' });
    }

    const listener = listeners[0];

    if (!listener.is_available || !listener.is_online) {
      console.log(`[CALLS] Listener ${listener.listener_id} unavailable: available=${listener.is_available}, online=${listener.is_online}`);
      return res.status(400).json({
        error: 'Listener is not available',
        details: { is_available: listener.is_available, is_online: listener.is_online }
      });
    }

    // BUSY CHECK: getRandomAvailable already filters busy, but guard against race condition
    if (listener.is_busy) {
      console.log(`[CALLS] Random listener ${listener.listener_id} is BUSY â€” rejecting`);
      return res.status(409).json({
        error: 'Listener is busy',
        status: 'busy',
        details: 'Selected listener is currently on another call. Please try again.'
      });
    }

    const resolvedRates = await resolveRateForListener(listener.listener_id);
    const userRate = Number(resolvedRates?.userRate || 0);
    const payoutRate = Number(resolvedRates?.payoutRate || 0);
    if (!Number.isFinite(userRate) || userRate <= 0) {
      return res.status(500).json({ error: 'Listener rate is invalid' });
    }
    if (!Number.isFinite(payoutRate) || payoutRate <= 0) {
      return res.status(500).json({ error: 'Listener payout rate is invalid' });
    }

    // Check if user is eligible for first-time offer
    const caller = await User.findById(req.userId);
    const rateConfig = await getRateConfig();
    const isOfferEligible = caller && caller.is_first_time_user && !caller.offer_used
      && rateConfig.first_time_offer_enabled
      && rateConfig.offer_minutes_limit > 0
      && Number(rateConfig.offer_flat_price) > 0;

    const offerFlatPrice = isOfferEligible ? Number(rateConfig.offer_flat_price) : null;
    const offerMinutesLimit = isOfferEligible ? Number(rateConfig.offer_minutes_limit) : null;
    const effectiveRate = isOfferEligible
      ? Number(rateConfig.offer_flat_price) / rateConfig.offer_minutes_limit
      : userRate;

    const wallet = await User.getWallet(req.userId);
    const availableBalance = parseFloat(wallet.balance || 0);
    const minBalanceToStart = isOfferEligible ? offerFlatPrice : effectiveRate;
    if (availableBalance < minBalanceToStart) {
      return res.status(402).json({
        error: 'Insufficient balance',
        details: `Minimum balance of â‚¹${Number(minBalanceToStart || 0).toFixed(2)} is required to start a call`
      });
    }

    // Create call with random listener â€” store effective rate
    const call = await Call.create({
      caller_id: req.userId,
      listener_id: listener.listener_id,
      call_type: call_type || 'audio',
      rate_per_minute: effectiveRate,
      billed_user_rate_per_min: userRate,
      billed_payout_rate_per_min: payoutRate,
      offer_applied: isOfferEligible,
      offer_flat_price: offerFlatPrice,
      offer_minutes_limit: offerMinutesLimit,
    });

    res.status(201).json({
      message: 'Random call initiated',
      call,
      listener: {
        listener_id: listener.listener_id,
        professional_name: listener.professional_name,
        avatar_url: listener.profile_image,
        rating: listener.average_rating,
        city: listener.city
      }
    });
  } catch (error) {
    console.error('Random call error:', error);
    res.status(500).json({ error: 'Failed to initiate random call' });
  }
});

// POST /api/calls/livekit/token
// Generate LiveKit JWT token for a call
router.post('/livekit/token', authenticate, async (req, res) => {
  try {
    const { channel_name } = req.body;

    if (!channel_name) {
      return res.status(400).json({ error: 'channel_name is required' });
    }

    // Prefer env-configured LiveKit credentials for self-hosted deployments.
    // Keep hardcoded values as fallback for legacy setup.
    const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
    const apiSecret = process.env.LIVEKIT_API_SECRET || 'appdostlivekitsecretkey2024productionxyz1234ab';
    const participantIdentity = req.userId.toString();
    const participantName = `User_${participantIdentity.substring(0, 5)}`;

    const at = new AccessToken(apiKey, apiSecret, {
      identity: participantIdentity,
      name: participantName,
    });

    at.addGrant({ roomJoin: true, room: channel_name, canPublish: true, canSubscribe: true });

    const token = await at.toJwt();

    res.json({
      token,
      channel_name,
      // Use plain WebSocket ws:// directly to port 7880 on the VPS.
      // Coolify's SSL proxy does NOT terminate WebSocket on this port.
      // Using wss:// causes TLS handshake failure: WRONG_VERSION_NUMBER
      url: process.env.LIVEKIT_URL || 'ws://91.108.111.194:7880'
    });
  } catch (error) {
    console.error('Fatal error generating LiveKit token:', error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});


export default router;
