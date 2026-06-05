-- Video preprocessing queue — jobs created by Next.js, consumed by the Express worker.
-- Run this in the Supabase SQL editor.

create table if not exists video_preprocessing_jobs (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid not null references conversations (id) on delete cascade,
  r2_raw_key        text not null,
  original_filename text not null default 'video.mp4',
  status            text not null default 'pending'
    check (status in ('pending', 'processing', 'done', 'error')),
  error_message     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists video_preprocessing_jobs_status_idx
  on video_preprocessing_jobs (status)
  where status in ('pending', 'processing');

create index if not exists video_preprocessing_jobs_conversation_id_idx
  on video_preprocessing_jobs (conversation_id);

-- Allow the worker to receive Realtime events for new pending jobs.
alter table video_preprocessing_jobs replica identity full;

-- Store a preprocessing error on the conversation so the frontend can show it.
alter table conversations add column if not exists preprocessing_error text;

create or replace trigger video_preprocessing_jobs_updated_at
  before update on video_preprocessing_jobs
  for each row execute function update_updated_at();
