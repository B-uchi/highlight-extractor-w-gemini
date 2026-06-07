-- Job cancellation + partial failure tracking
-- Run after add_chunk_progress.sql

-- Extend the status check constraint to include cancelling and cancelled.
-- The inline constraint in schema.sql has an auto-generated name so we find it dynamically.
do $$
declare
  conname text;
begin
  select c.conname into conname
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  where t.relname = 'jobs' and c.contype = 'c' and c.conname ilike '%status%'
  limit 1;

  if conname is not null then
    execute 'alter table jobs drop constraint ' || quote_ident(conname);
  end if;
end $$;

alter table jobs add constraint jobs_status_check check (
  status in (
    'pending', 'extracting_target', 'analyzing', 'extracting_clips',
    'stitching', 'done', 'error', 'unsupported', 'cancelling', 'cancelled'
  )
);

-- Per-chunk failure records: [{chunkIndex, startSec, endSec, error}]
alter table jobs
  add column if not exists failed_chunks jsonb;
