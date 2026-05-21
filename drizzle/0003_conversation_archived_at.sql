ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS conversations_archived_at_idx ON conversations (archived_at);
