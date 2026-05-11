-- ============================================
-- Migration: Add is_busy column to listeners table
-- Date: 2026-02-10
-- Purpose: Track whether a listener is currently in an active call
-- ============================================

ALTER TABLE listeners ADD COLUMN IF NOT EXISTS is_busy BOOLEAN DEFAULT FALSE;

-- Index for quick busy-status lookups when listing listeners
CREATE INDEX IF NOT EXISTS idx_listeners_is_busy ON listeners(is_busy) WHERE is_busy = TRUE;
