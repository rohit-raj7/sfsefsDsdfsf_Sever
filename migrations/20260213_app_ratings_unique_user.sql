-- Enforce one app rating per user and support updates
ALTER TABLE app_ratings
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Keep latest rating per user before adding unique index
DELETE FROM app_ratings older
USING app_ratings newer
WHERE older.user_id IS NOT NULL
  AND older.user_id = newer.user_id
  AND (
    older.created_at < newer.created_at
    OR (
      older.created_at = newer.created_at
      AND older.app_rating_id::text < newer.app_rating_id::text
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_app_ratings_user_unique
ON app_ratings(user_id)
WHERE user_id IS NOT NULL;
