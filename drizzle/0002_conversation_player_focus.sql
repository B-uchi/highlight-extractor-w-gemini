ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS player_focus_json jsonb;
