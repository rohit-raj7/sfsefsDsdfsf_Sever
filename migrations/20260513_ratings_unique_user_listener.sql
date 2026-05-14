-- Enforce one rating per user per listener across all calls.
-- Keep the latest row for any duplicated (user_id, listener_id) pair.
DELETE FROM ratings older
USING ratings newer
WHERE older.user_id IS NOT NULL
  AND older.listener_id IS NOT NULL
  AND older.user_id = newer.user_id
  AND older.listener_id = newer.listener_id
  AND (
    older.created_at < newer.created_at
    OR (
      older.created_at = newer.created_at
      AND older.rating_id::text < newer.rating_id::text
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_user_listener_unique
ON ratings(user_id, listener_id)
WHERE user_id IS NOT NULL AND listener_id IS NOT NULL;
