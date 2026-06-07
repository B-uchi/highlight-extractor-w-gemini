import { NextResponse } from "next/server";

import { createServerClient } from "@/lib/supabase";
import { getPresignedUrl } from "@/lib/storage";

export const runtime = "nodejs";

const CANCELLABLE_STATUSES = ["pending", "extracting_target", "analyzing"];
const TERMINAL_STATUSES = ["done", "error", "unsupported", "cancelled"];

export async function GET(
  _req: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await context.params;
    const db = createServerClient();

    const [jobRes, clipsRes] = await Promise.all([
      db.from("jobs").select("*").eq("id", jobId).single(),
      db.from("clips").select("*").eq("job_id", jobId).order("rank"),
    ]);

    if (!jobRes.data) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }

    const job = jobRes.data;

    // Refresh compilation URL if expired
    if (job.compilation_r2_key && job.status === "done") {
      try {
        job.compilation_r2_url = await getPresignedUrl(job.compilation_r2_key);
      } catch {
        // Keep existing URL if refresh fails
      }
    }

    return NextResponse.json({ job, clips: clipsRes.data ?? [] });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unexpected error." }, { status: 500 });
  }
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await context.params;
    const body = await req.json();

    if (body?.action !== "cancel") {
      return NextResponse.json({ error: "Invalid action." }, { status: 400 });
    }

    const db = createServerClient();
    const { data: job } = await db.from("jobs").select("*").eq("id", jobId).single();

    if (!job) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }

    if (TERMINAL_STATUSES.includes(job.status) || job.status === "cancelling") {
      return NextResponse.json({ error: "Job is not cancellable at this stage." }, { status: 409 });
    }

    if (!CANCELLABLE_STATUSES.includes(job.status)) {
      return NextResponse.json({ error: "Job is not cancellable at this stage." }, { status: 409 });
    }

    await db.from("jobs").update({
      status: "cancelling",
      updated_at: new Date().toISOString(),
    }).eq("id", jobId);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unexpected error." }, { status: 500 });
  }
}
