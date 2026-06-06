import { NextResponse } from "next/server";

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

    const { data: conv } = await db.from("conversations").select("status").eq("id", id).single();
    if (!conv) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    if (conv.status !== "active") {
      return NextResponse.json({ error: "Upload a video first." }, { status: 400 });
    }

    const { data: runningJobs } = await db
      .from("jobs")
      .select("id")
      .eq("conversation_id", id)
      .in("status", ["pending", "extracting_target", "analyzing", "extracting_clips", "stitching"])
      .limit(1);

    if (runningJobs && runningJobs.length > 0) {
      return NextResponse.json({ error: "A job is already in progress." }, { status: 409 });
    }

    const { data: userMsg } = await db
      .from("messages")
      .insert({ conversation_id: id, role: "user", content: body.prompt.trim() })
      .select()
      .single();

    if (!userMsg) throw new Error("Failed to create message.");

    const { data: job } = await db
      .from("jobs")
      .insert({
        conversation_id: id,
        message_id: userMsg.id,
        mode: "action_extraction",
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

    // Placeholder assistant message created now so JobStatusCard survives a page refresh.
    // The worker updates its content (and only its content) when the job finishes.
    await db.from("messages").insert({
      conversation_id: id,
      role: "assistant",
      content: "",
      job_id: job.id,
    });

    await db.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", id);

    // Backend worker picks this up via Supabase Realtime on the jobs table.
    return NextResponse.json({ messageId: userMsg.id, jobId: job.id }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unexpected error." },
      { status: 500 },
    );
  }
}
