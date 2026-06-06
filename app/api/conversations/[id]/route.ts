import { NextResponse } from "next/server";

import { createServerClient } from "@/lib/supabase";
import { deleteFromR2 } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const db = createServerClient();

    const [convRes, msgsRes] = await Promise.all([
      db.from("conversations").select("*").eq("id", id).single(),
      db.from("messages").select("*").eq("conversation_id", id).order("created_at"),
    ]);

    if (convRes.error || !convRes.data) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    }

    // Attach clips and jobs to messages
    const jobIds = [...new Set(msgsRes.data?.map((m) => m.job_id).filter(Boolean) as string[])];
    let jobs: Record<string, unknown> = {};
    let clipsMap: Record<string, unknown[]> = {};

    if (jobIds.length > 0) {
      const [jobsRes, clipsRes] = await Promise.all([
        db.from("jobs").select("*").in("id", jobIds),
        db.from("clips").select("*").in("job_id", jobIds).order("rank"),
      ]);
      jobs = Object.fromEntries((jobsRes.data ?? []).map((j) => [j.id, j]));
      for (const clip of clipsRes.data ?? []) {
        if (!clipsMap[clip.job_id]) clipsMap[clip.job_id] = [];
        clipsMap[clip.job_id].push(clip);
      }
    }

    const messages = (msgsRes.data ?? []).map((m) => ({
      ...m,
      job: m.job_id ? (jobs[m.job_id] ?? null) : null,
      clips: m.job_id ? (clipsMap[m.job_id] ?? []) : [],
    }));

    return NextResponse.json({ conversation: convRes.data, messages });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unexpected error." }, { status: 500 });
  }
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const db = createServerClient();
    const body = (await req.json()) as { title?: string; archived?: boolean };

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (typeof body.title === "string") {
      const title = body.title.trim();
      if (!title) return NextResponse.json({ error: "Title cannot be empty." }, { status: 400 });
      patch.title = title;
    }

    if (typeof body.archived === "boolean") {
      patch.archived_at = body.archived ? new Date().toISOString() : null;
      patch.status = body.archived ? "archived" : "active";
    }

    const { data, error } = await db
      .from("conversations")
      .update(patch)
      .eq("id", id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ conversation: data });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unexpected error." }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const db = createServerClient();

    // Gather all assets in parallel before touching the DB.
    const [convRes, clipsRes, chunksRes, prepJobsRes, jobsRes] = await Promise.all([
      db.from("conversations").select("r2_video_key").eq("id", id).single(),
      db.from("clips").select("r2_clip_key, r2_follow_up_clip_key").eq("conversation_id", id),
      db.from("video_chunks").select("gemini_file_id").eq("conversation_id", id).not("gemini_file_id", "is", null),
      db.from("video_preprocessing_jobs").select("r2_raw_key").eq("conversation_id", id),
      db.from("jobs").select("compilation_r2_key").eq("conversation_id", id).not("compilation_r2_key", "is", null),
    ]);

    // Collect R2 keys.
    const r2Keys: string[] = [];
    if (convRes.data?.r2_video_key) r2Keys.push(convRes.data.r2_video_key);
    for (const clip of clipsRes.data ?? []) {
      if (clip.r2_clip_key) r2Keys.push(clip.r2_clip_key);
      if (clip.r2_follow_up_clip_key) r2Keys.push(clip.r2_follow_up_clip_key);
    }
    for (const job of jobsRes.data ?? []) {
      if (job.compilation_r2_key) r2Keys.push(job.compilation_r2_key);
    }
    for (const prepJob of prepJobsRes.data ?? []) {
      if (prepJob.r2_raw_key) r2Keys.push(prepJob.r2_raw_key);
    }

    // Delete Gemini files — best-effort, they expire in 48 h anyway.
    const geminiUris = (chunksRes.data ?? []).map((c) => c.gemini_file_id).filter(Boolean) as string[];
    if (geminiUris.length > 0 && process.env.GEMINI_API_KEY) {
      try {
        const { GoogleGenAI } = await import("@google/genai");
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        await Promise.allSettled(
          geminiUris.map((uri) => {
            // URI: https://generativelanguage.googleapis.com/v1beta/files/<name>
            const match = uri.match(/\/(files\/[^/]+)$/);
            if (!match) return Promise.resolve();
            return ai.files.delete({ name: match[1] });
          }),
        );
      } catch { /* ignore — files self-expire */ }
    }

    // Delete R2 objects — best-effort per key so one missing file doesn't abort the rest.
    await Promise.allSettled(r2Keys.map((key) => deleteFromR2(key)));

    // Delete conversation row — cascades to all child tables (video_chunks, messages,
    // jobs, clips, video_preprocessing_jobs all have ON DELETE CASCADE).
    const { error } = await db.from("conversations").delete().eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unexpected error." },
      { status: 500 },
    );
  }
}
