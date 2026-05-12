-- Migration: Add rejection_reason and reapply_attempts columns to listeners table
-- These support the verification rejection flow with reasons and reapply functionality

ALTER TABLE listeners 
  ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(255) DEFAULT NULL;

ALTER TABLE listeners 
  ADD COLUMN IF NOT EXISTS reapply_attempts INTEGER DEFAULT 0;

-- Update the CHECK constraint to allow 'reapplied' status
-- Drop old constraint if it exists, then add new one
ALTER TABLE listeners DROP CONSTRAINT IF EXISTS listeners_verification_status_check;
ALTER TABLE listeners ADD CONSTRAINT listeners_verification_status_check 
  CHECK (verification_status IN ('pending', 'approved', 'rejected', 'reapplied'));
