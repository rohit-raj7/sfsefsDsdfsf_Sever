import express from 'express';
import { authenticate } from '../middleware/auth.js';
import AppRating from '../models/AppRating.js';

const router = express.Router();

// POST /api/app-ratings
// Submit app experience rating and optional feedback
router.post('/', authenticate, async (req, res) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'User authentication required' });
    }

    const ratingValue = Number(req.body?.rating);
    const feedbackRaw = req.body?.feedback;

    if (!Number.isFinite(ratingValue) || ratingValue < 1 || ratingValue > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' });
    }

    let feedback = null;
    if (typeof feedbackRaw === 'string') {
      const trimmed = feedbackRaw.trim();
      if (trimmed.length > 1000) {
        return res
          .status(400)
          .json({ error: 'Feedback must be 1000 characters or less' });
      }
      feedback = trimmed.length > 0 ? trimmed : null;
    }

    const result = await AppRating.submitOrUpdateForUser({
      user_id: req.userId,
      rating: Number(ratingValue.toFixed(1)),
      feedback,
      source: 'mobile',
    });

    if (!result.rating) {
      return res
        .status(500)
        .json({ error: 'Failed to save rating. Please try again.' });
    }

    const isCreated = result.action === 'created';

    return res.status(isCreated ? 201 : 200).json({
      status: result.action,
      message: isCreated
        ? 'Rating submitted successfully.'
        : 'Rating updated successfully.',
      rating: result.rating,
    });
  } catch (error) {
    console.error('Create/update app rating error:', error);
    return res.status(500).json({ error: 'Failed to save app rating' });
  }
});

export default router;
