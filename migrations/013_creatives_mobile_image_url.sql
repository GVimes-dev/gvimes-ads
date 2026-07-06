-- Migration 013: Add mobile_image_url to creatives
-- Stores an alternate, smaller graphic URL optimised for mobile viewports.
-- Nullable — existing creatives fall back to image_url when null.

ALTER TABLE creatives
  ADD COLUMN IF NOT EXISTS mobile_image_url TEXT;
