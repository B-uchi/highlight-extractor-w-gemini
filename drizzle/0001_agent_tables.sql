CREATE TABLE IF NOT EXISTS conversations (
  id varchar(64) PRIMARY KEY,
  title text NOT NULL,
  active_job_id varchar(64),
  pending_input_path text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS conversations_updated_at_idx ON conversations (updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id varchar(64) PRIMARY KEY,
  conversation_id varchar(64) NOT NULL,
  role varchar(32) NOT NULL,
  content text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_conversation_id_created_at_idx ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id varchar(128) PRIMARY KEY,
  conversation_id varchar(64) NOT NULL,
  job_id varchar(64),
  type varchar(32) NOT NULL,
  status varchar(32) NOT NULL,
  progress integer NOT NULL DEFAULT 0,
  label text NOT NULL,
  detail text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_tasks_conversation_id_idx ON agent_tasks (conversation_id);
CREATE INDEX IF NOT EXISTS agent_tasks_job_id_idx ON agent_tasks (job_id);
