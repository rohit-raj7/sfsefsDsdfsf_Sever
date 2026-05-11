import express from 'express';
const router = express.Router();
import { authenticate } from '../middleware/auth.js';
import Rating from '../models/Rating.js';
import Listener from '../models/Listener.js';
import Call from '../models/Call.js';

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

    const alreadyRated = await Rating.isCallRated(callId);
    if (alreadyRated) {
      return res.status(400).json({ error: 'Call already rated' });
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
    console.error('Rating submit error:', error);
    res.status(500).json({ error: 'Failed to submit rating' });
  }
});

export default router;
