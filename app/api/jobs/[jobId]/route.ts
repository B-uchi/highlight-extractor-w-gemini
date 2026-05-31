import { NextResponse } from "next/server";

import { createServerClient } from "@/lib/supabase";
import { getPresignedUrl } from "@/lib/storage";

export const runtime = "nodejs";

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
