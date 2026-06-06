-- Real-time chunk analysis progress tracking
alter table jobs
  add column if not exists chunks_analyzed int not null default 0,
  add column if not exists chunks_total int;

-- Per-job cache of successful chunk analysis results.
-- Keyed by chunk index (as text, JSON object keys are strings).
-- Scoped to the job so different prompts never reuse each other's results.
-- On retry the worker reads this and skips chunks that already succeeded.
alter table jobs
  add column if not exists chunk_cache jsonb not null default '{}';
