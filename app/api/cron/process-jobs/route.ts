import { NextResponse } from "next/server";

import { processJob } from "@/lib/jobs";
import { createServerClient } from "@/lib/supabase";
import { appConfig } from "@/lib/config";

export const runtime = "nodejs";

export async function GET(req: Request) {
  // Verify cron secret
  const authHeader = req.headers.get("authorization");
  const cronSecret = appConfig.cron.secret;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const db = createServerClient();
    const stuckBefore = new Date(Date.now() - 60_000).toISOString();

    const { data: stuckJobs } = await db
      .from("jobs")
      .select("id")
      .eq("status", "pending")
      .lt("created_at", stuckBefore)
      .limit(5);

    if (!stuckJobs || stuckJobs.length === 0) {
      return NextResponse.json({ processed: 0 });
    }

    // Fire and forget — cron doesn't wait for completion
    for (const job of stuckJobs) {
      void processJob(job.id);
    }

    return NextResponse.json({ processed: stuckJobs.length });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unexpected error." }, { status: 500 });
  }
}
