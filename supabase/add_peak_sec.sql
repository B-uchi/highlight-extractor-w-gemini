-- Migration: add peak_sec to clips table
-- Run in Supabase SQL editor if your clips table already exists.
alter table clips add column if not exists peak_sec float;
