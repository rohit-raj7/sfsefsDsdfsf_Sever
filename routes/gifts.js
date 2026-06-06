import express from 'express';
import rateLimit from 'express-rate-limit';
import CallGift from '../models/CallGift.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

const giftSendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many gift requests. Please slow down for a moment.',
  },
});

router.get('/catalog', authenticate, async (req, res) => {
  try {
    res.json(await CallGift.getCatalog());
  } catch (error) {
    console.error('Get gift catalog error:', error);
    res.status(500).json({ error: 'Failed to fetch gift catalog' });
  }
});

router.get('/history', authenticate, async (req, res) => {
  try {
    const callId = String(req.query.call_id || req.query.callId || '').trim();
    if (!callId) {
      return res.status(400).json({ error: 'callId is required' });
    }

    const history = await CallGift.getCallHistory({
      requesterUserId: req.userId,
      callId,
      since: req.query.since || null,
      limit: req.query.limit || 30,
    });

    res.json({
      callId: history.callId,
      gifts: history.gifts,
      count: history.gifts.length,
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Get gift history error:', error);
    if (error?.code === 'CALL_NOT_FOUND') {
      return res.status(404).json({ error: 'Call not found' });
    }
    if (error?.code === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.status(500).json({ error: 'Failed to fetch gift history' });
  }
});

router.post('/send', authenticate, giftSendLimiter, async (req, res) => {
  try {
    const callId = String(req.body?.callId || req.body?.call_id || '').trim();
    const giftId = String(req.body?.giftId || req.body?.gift_id || '').trim();
    const clientRequestId = String(
      req.body?.clientRequestId || req.body?.client_request_id || '',
    ).trim();

    if (!callId) {
      return res.status(400).json({ error: 'callId is required' });
    }
    if (!giftId) {
      return res.status(400).json({ error: 'giftId is required' });
    }
    if (!clientRequestId || clientRequestId.length < 8) {
      return res.status(400).json({
        error: 'clientRequestId is required and must be at least 8 characters',
      });
    }
    if (clientRequestId.length > 120) {
      return res.status(400).json({
        error: 'clientRequestId is too long',
      });
    }

    const result = await CallGift.sendGift({
      senderId: req.userId,
      callId,
      giftId,
      clientRequestId,
    });

    const io = req.app.get('io');
    if (io && result?.giftEvent && !result.duplicate) {
      io.to(`user_${result.giftEvent.listenerUserId}`).emit(
        'call:gift_received',
        result.giftEvent,
      );
    }

    res.status(result.duplicate ? 200 : 201).json({
      message: result.duplicate
        ? 'Gift request already processed'
        : 'Gift sent successfully',
      duplicate: result.duplicate === true,
      giftEvent: result.giftEvent,
      wallet: {
        balance: result.senderBalance,
      },
    });
  } catch (error) {
    console.error('Send gift error:', error);
    if (error?.code === 'INVALID_GIFT_ID') {
      return res.status(400).json({ error: 'Invalid gift ID' });
    }
    if (error?.code === 'CALL_NOT_FOUND') {
      return res.status(404).json({ error: 'Call not found' });
    }
    if (error?.code === 'FORBIDDEN' || error?.code === 'SELF_GIFT_NOT_ALLOWED') {
      return res.status(403).json({ error: error.message || 'Forbidden' });
    }
    if (error?.code === 'CALL_NOT_ACTIVE') {
      return res.status(409).json({ error: error.message || 'Call is not active' });
    }
    if (error?.code === 'INSUFFICIENT_BALANCE') {
      return res.status(402).json({
        error: 'Insufficient balance',
        code: 'INSUFFICIENT_BALANCE',
      });
    }
    if (error?.code === 'LISTENER_NOT_FOUND') {
      return res.status(404).json({ error: 'Listener not found' });
    }
    res.status(500).json({ error: 'Failed to send gift' });
  }
});

export default router;
