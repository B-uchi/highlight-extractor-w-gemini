-- Per-clip position in the stitched highlight reel (seconds from start).
-- Null for action_extraction jobs and for clips created before this migration.
alter table clips
  add column if not exists highlight_start_sec float;
