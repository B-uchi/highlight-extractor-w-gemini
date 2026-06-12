-- Proposer-verifier pipeline: add 'proposing' and 'verifying' job statuses.
-- Run after add_cancellation.sql.

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
    'pending', 'extracting_target', 'analyzing', 'proposing', 'verifying',
    'extracting_clips', 'stitching', 'done', 'error', 'unsupported',
    'cancelling', 'cancelled'
  )
);
