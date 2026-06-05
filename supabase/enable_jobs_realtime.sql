-- Enable Realtime on the jobs table so the backend worker receives INSERT events
-- and the frontend receives UPDATE events (job status progress).
-- Run this in the Supabase SQL editor.

alter table jobs replica identity full;
