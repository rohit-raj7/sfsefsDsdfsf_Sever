-- Add streak tracking columns for weekly bonuses
ALTER TABLE listeners
ADD COLUMN IF NOT EXISTS daily_streak_days INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_streak_date DATE;

-- Add a column to track last processed daily stats date
ALTER TABLE listeners
ADD COLUMN IF NOT EXISTS last_daily_stats_date DATE;
