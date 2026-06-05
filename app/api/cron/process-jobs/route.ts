import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Job processing has moved to the backend worker (backend/src/jobs.ts).
// The worker picks up pending jobs via Supabase Realtime and a poll fallback.
// This endpoint is kept alive so any Railway cron config pointing here doesn't 404.
export async function GET() {
  return NextResponse.json({ ok: true, note: "Job processing handled by backend worker." });
}
