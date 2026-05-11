-- Ensure one rating per call
CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_call_id ON ratings(call_id);
