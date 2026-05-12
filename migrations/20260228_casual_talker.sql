-- Add listener_type column to support Full Listener vs Casual Talker
ALTER TABLE listeners
ADD COLUMN IF NOT EXISTS listener_type VARCHAR(20) DEFAULT 'full';
-- Values: 'full' (Full Listener) or 'casual' (Casual Talker)

-- Casual Talkers earn ₹1/min (vs Full Listeners at ₹2/min)
-- Casual Talkers require only a display name + avatar to register (30-sec setup)
-- Full Listeners require: name, avatar, voice sample, specialties
