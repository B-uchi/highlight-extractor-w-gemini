import { NextResponse } from "next/server";

import { createServerClient } from "@/lib/supabase";
import { deleteFromR2 } from "@/lib/storage";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await context.params;
    const db = createServerClient();

    const { data: job } = await db.from("jobs").select("*").eq("id", jobId).single();

    if (!job) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }

    if (!["error", "cancelled"].includes(job.status)) {
      return NextResponse.json({ error: "Job cannot be retried." }, { status: 409 });
    }

    // Block retry when any other job is currently active (one-at-a-time constraint).
    const ACTIVE_STATUSES = [
      "pending",
      "extracting_target",
      "analyzing",
      "extracting_clips",
      "stitching",
      "cancelling",
    ];
    const { count: activeCount } = await db
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .in("status", ACTIVE_STATUSES);

    if ((activeCount ?? 0) > 0) {
      return NextResponse.json(
        { error: "Another job is currently processing. Wait for it to finish, then retry." },
        { status: 409 },
      );
    }

    // Fetch existing clips for cleanup
    const { data: clips } = await db
      .from("clips")
      .select("r2_clip_key, r2_follow_up_clip_key")
      .eq("job_id", jobId);

    // Delete old R2 clips and compilation (best-effort)
    const r2Keys = [
      ...(clips ?? []).flatMap((c) =>
        [c.r2_clip_key, c.r2_follow_up_clip_key].filter(Boolean),
      ),
      job.compilation_r2_key,
    ].filter(Boolean) as string[];

    await Promise.allSettled(r2Keys.map((k) => deleteFromR2(k)));

    // Delete old clips from DB
    await db.from("clips").delete().eq("job_id", jobId);

    // Reset the job to pending, keeping chunk_cache so already-analyzed chunks skip Gemini
    await db
      .from("jobs")
      .update({
        status: "pending",
        error_message: null,
        failed_chunks: null,
        chunks_analyzed: 0,
        chunks_total: null,
        clips_total: null,
        clips_done: 0,
        compilation_r2_key: null,
        compilation_r2_url: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    // Reset placeholder assistant message content to empty string
    await db
      .from("messages")
      .update({ content: "" })
      .eq("job_id", jobId)
      .eq("role", "assistant");

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unexpected error." },
      { status: 500 },
    );
  }
}
