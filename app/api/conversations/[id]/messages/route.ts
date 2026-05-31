import { NextResponse } from "next/server";

import { processJob } from "@/lib/jobs";
import { createServerClient } from "@/lib/supabase";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const db = createServerClient();

    const body = (await req.json()) as {
      prompt?: string;
      followUpSecs?: number;
      clipLimit?: number;
    };

    if (!body.prompt?.trim()) {
      return NextResponse.json({ error: "prompt is required." }, { status: 400 });
    }

    // Validate conversation is active
    const { data: conv } = await db.from("conversations").select("status").eq("id", id).single();
    if (!conv) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    if (conv.status !== "active") {
      return NextResponse.json({ error: "Upload a video first." }, { status: 400 });
    }

    // Check no job is currently running
    const { data: runningJobs } = await db
      .from("jobs")
      .select("id")
      .eq("conversation_id", id)
      .in("status", ["pending", "extracting_target", "analyzing", "extracting_clips", "stitching"])
      .limit(1);

    if (runningJobs && runningJobs.length > 0) {
      return NextResponse.json({ error: "A job is already in progress." }, { status: 409 });
    }

    // Insert user message
    const { data: userMsg } = await db
      .from("messages")
      .insert({ conversation_id: id, role: "user", content: body.prompt.trim() })
      .select()
      .single();

    if (!userMsg) throw new Error("Failed to create message.");

    // Insert job
    const { data: job } = await db
      .from("jobs")
      .insert({
        conversation_id: id,
        message_id: userMsg.id,
        mode: "action_extraction", // will be updated by pre-step
        status: "pending",
        prompt: body.prompt.trim(),
        clip_limit: body.clipLimit ?? null,
        follow_up_secs: body.followUpSecs ?? null,
        include_audio: true,
        clips_done: 0,
      })
      .select()
      .single();

    if (!job) throw new Error("Failed to create job.");

    // Link job to user message
    await db.from("messages").update({ job_id: job.id }).eq("id", userMsg.id);

    // Update conversation updated_at
    await db.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", id);

    // Kick off job asynchronously
    setImmediate(() => {
      void processJob(job.id);
    });

    return NextResponse.json({ messageId: userMsg.id, jobId: job.id }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unexpected error." }, { status: 500 });
  }
}
