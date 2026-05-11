CREATE TABLE IF NOT EXISTS jobs (
  id varchar(64) PRIMARY KEY,
  stage varchar(64) NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS highlights (
  id varchar(100) PRIMARY KEY,
  job_id varchar(64) NOT NULL,
  payload jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS clips (
  id varchar(100) PRIMARY KEY,
  job_id varchar(64) NOT NULL,
  path text NOT NULL,
  payload jsonb NOT NULL
);
