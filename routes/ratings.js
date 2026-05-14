import express from 'express';
const router = express.Router();
import { authenticate } from '../middleware/auth.js';
import Rating from '../models/Rating.js';
import Listener from '../models/Listener.js';
import Call from '../models/Call.js';

const DUPLICATE_CALL_RATING_CODE = 'CALL_ALREADY_RATED';
const DUPLICATE_LISTENER_RATING_CODE = 'LISTENER_ALREADY_RATED';
const RATINGS_CALL_UNIQUE_INDEX = 'idx_ratings_call_id';
const RATINGS_USER_LISTENER_UNIQUE_INDEX = 'idx_ratings_user_listener_unique';

// POST /api/ratings/submit
router.post('/submit', authenticate, async (req, res) => {
  try {
    const { callId, rating } = req.body;

    if (!callId) {
      return res.status(400).json({ error: 'callId is required' });
    }

    const ratingValue = Number(rating);
    if (!Number.isFinite(ratingValue) || ratingValue < 1 || ratingValue > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    const call = await Call.findById(callId);
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    if (call.caller_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (call.status !== 'completed') {
      return res.status(400).json({ error: 'Can only rate completed calls' });
    }

    const callAlreadyRated = await Rating.isCallRated(callId);
    if (callAlreadyRated) {
      return res.status(409).json({
        error: 'Call already rated',
        code: DUPLICATE_CALL_RATING_CODE
      });
    }

    const listenerAlreadyRated = await Rating.hasUserRatedListener(req.userId, call.listener_id);
    if (listenerAlreadyRated) {
      return res.status(409).json({
        error: 'You have already rated this listener',
        code: DUPLICATE_LISTENER_RATING_CODE
      });
    }

    const ratingRecord = await Rating.create({
      call_id: callId,
      listener_id: call.listener_id,
      user_id: req.userId,
      rating: Number(ratingValue.toFixed(1))
    });

    const averageData = await Rating.getListenerAverageRating(call.listener_id);
    const averageRating = Number(parseFloat(averageData.average_rating || 0).toFixed(1));
    const totalRatings = Number(averageData.total_ratings || 0);

    await Listener.updateRatingStats(call.listener_id, averageRating, totalRatings);

    res.status(201).json({
      message: 'Rating submitted successfully',
      rating: ratingRecord,
      average_rating: averageRating,
      total_ratings: totalRatings
    });
  } catch (error) {
    if (error?.code === '23505') {
      if (error.constraint === RATINGS_CALL_UNIQUE_INDEX) {
        return res.status(409).json({
          error: 'Call already rated',
          code: DUPLICATE_CALL_RATING_CODE
        });
      }
      if (error.constraint === RATINGS_USER_LISTENER_UNIQUE_INDEX) {
        return res.status(409).json({
          error: 'You have already rated this listener',
          code: DUPLICATE_LISTENER_RATING_CODE
        });
      }
    }
    console.error('Rating submit error:', error);
    res.status(500).json({ error: 'Failed to submit rating' });
  }
});

// GET /api/ratings/eligibility/:callId
// Check whether current user can submit rating for this call's listener.
router.get('/eligibility/:callId', authenticate, async (req, res) => {
  try {
    const { callId } = req.params;
    const call = await Call.findById(callId);
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    if (call.caller_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const callAlreadyRated = await Rating.isCallRated(callId);
    if (callAlreadyRated) {
      return res.json({
        canRate: false,
        reason: 'call_already_rated',
        code: DUPLICATE_CALL_RATING_CODE,
      });
    }

    const listenerAlreadyRated = await Rating.hasUserRatedListener(
      req.userId,
      call.listener_id,
    );
    if (listenerAlreadyRated) {
      return res.json({
        canRate: false,
        reason: 'listener_already_rated',
        code: DUPLICATE_LISTENER_RATING_CODE,
      });
    }

    return res.json({ canRate: true });
  } catch (error) {
    console.error('Rating eligibility check error:', error);
    return res.status(500).json({ error: 'Failed to check rating eligibility' });
  }
});

export default router;
