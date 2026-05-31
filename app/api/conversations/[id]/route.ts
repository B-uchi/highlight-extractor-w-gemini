import { NextResponse } from "next/server";

import { createServerClient } from "@/lib/supabase";

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
