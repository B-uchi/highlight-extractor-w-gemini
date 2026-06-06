import { NextResponse } from "next/server";

import { createServerClient } from "@/lib/supabase";

export const runtime = "nodejs";

// Step 2 of the direct-upload flow: the browser has already PUT the raw video to R2.
// Enqueue a preprocessing job and return 202 immediately. The Express worker
// (backend/) picks it up via Supabase Realtime, processes the video, and marks
// the conversation active. The frontend listens via Supabase Realtime.
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const db = createServerClient();

  const { data: conv } = await db
    .from("conversations")
    .select("status")
    .eq("id", id)
    .single();

  if (!conv) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }
  if (conv.status !== "awaiting_video") {
    return NextResponse.json(
      { error: "Video already processed for this conversation." },
      { status: 409 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    key?: string;
    filename?: string;
  };
  if (!body.key) {
    return NextResponse.json({ error: "Missing upload key." }, { status: 400 });
  }

  // Clear any error from a previous failed attempt before the frontend subscribes.
  await db.from("conversations").update({ preprocessing_error: null }).eq("id", id);

  const { data: job, error } = await db
    .from("video_preprocessing_jobs")
    .insert({
      conversation_id: id,
      r2_raw_key: body.key,
      original_filename: body.filename ?? "video.mp4",
    })
    .select("id")
    .single();

  if (error || !job) {
    return NextResponse.json({ error: "Failed to queue preprocessing." }, { status: 500 });
  }

  return NextResponse.json({ jobId: job.id }, { status: 202 });
}
