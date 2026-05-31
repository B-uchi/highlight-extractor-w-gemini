-- Basketball Highlight Extractor — Supabase Schema
-- Run this in your Supabase SQL editor or via supabase db push

-- Enable UUID extension
create extension if not exists "pgcrypto";

-- ── conversations ─────────────────────────────────────────────────────────────
create table if not exists conversations (
  id              uuid primary key default gen_random_uuid(),
  title           text not null default 'New conversation',
  status          text not null default 'awaiting_video'
    check (status in ('awaiting_video', 'active', 'archived')),
  r2_video_key    text,
  video_filename  text,
  video_duration_secs integer,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  archived_at     timestamptz
);

create index if not exists conversations_updated_at_idx on conversations (updated_at desc);
create index if not exists conversations_archived_at_idx on conversations (archived_at);

-- ── video_chunks ──────────────────────────────────────────────────────────────
-- One row per Gemini-uploaded chunk (1 row for short videos, N for long ones).
create table if not exists video_chunks (
  id                  uuid primary key default gen_random_uuid(),
  conversation_id     uuid not null references conversations (id) on delete cascade,
  chunk_index         integer not null default 0,
  start_sec           float not null default 0,
  end_sec             float not null,
  gemini_file_id      text,
  gemini_expires_at   timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (conversation_id, chunk_index)
);

create index if not exists video_chunks_conversation_id_idx on video_chunks (conversation_id);

-- ── messages ──────────────────────────────────────────────────────────────────
create table if not exists messages (
  id                  uuid primary key default gen_random_uuid(),
  conversation_id     uuid not null references conversations (id) on delete cascade,
  role                text not null check (role in ('user', 'assistant')),
  content             text not null,
  job_id              uuid,  -- FK added after jobs table
  created_at          timestamptz not null default now()
);

create index if not exists messages_conversation_id_created_at_idx on messages (conversation_id, created_at);

-- ── jobs ──────────────────────────────────────────────────────────────────────
create table if not exists jobs (
  id                  uuid primary key default gen_random_uuid(),
  conversation_id     uuid not null references conversations (id) on delete cascade,
  message_id          uuid references messages (id),
  mode                text not null default 'action_extraction'
    check (mode in ('action_extraction', 'highlight_compilation_individual', 'highlight_compilation_team')),
  status              text not null default 'pending'
    check (status in ('pending', 'extracting_target', 'analyzing', 'extracting_clips', 'stitching', 'done', 'error', 'unsupported')),
  prompt              text not null,
  extracted_target    text,
  jersey_number       text,
  jersey_color        text,
  team_name           text,
  clip_limit          integer,
  follow_up_secs      integer,
  include_audio       boolean not null default true,
  clips_total         integer,
  clips_done          integer not null default 0,
  compilation_r2_key  text,
  compilation_r2_url  text,
  error_message       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists jobs_conversation_id_idx on jobs (conversation_id);
create index if not exists jobs_status_idx on jobs (status);
create index if not exists jobs_created_at_idx on jobs (created_at);

-- Add FK from messages → jobs
alter table messages
  add constraint messages_job_id_fkey
  foreign key (job_id) references jobs (id)
  on delete set null
  not valid;

alter table messages validate constraint messages_job_id_fkey;

-- ── clips ─────────────────────────────────────────────────────────────────────
create table if not exists clips (
  id                  uuid primary key default gen_random_uuid(),
  job_id              uuid not null references jobs (id) on delete cascade,
  conversation_id     uuid not null references conversations (id) on delete cascade,
  title               text not null,
  description         text,
  start_sec           float not null,
  end_sec             float not null,
  follow_up_end_sec   float,
  rank                integer not null,
  jersey_number       text,
  jersey_color        text,
  r2_clip_key         text,
  r2_clip_url         text,
  created_at          timestamptz not null default now()
);

create index if not exists clips_job_id_rank_idx on clips (job_id, rank);
create index if not exists clips_conversation_id_idx on clips (conversation_id);

-- ── updated_at trigger ────────────────────────────────────────────────────────
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace trigger conversations_updated_at
  before update on conversations
  for each row execute function update_updated_at();

create or replace trigger video_chunks_updated_at
  before update on video_chunks
  for each row execute function update_updated_at();

create or replace trigger jobs_updated_at
  before update on jobs
  for each row execute function update_updated_at();
