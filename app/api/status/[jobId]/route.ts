import { NextResponse } from "next/server";

import { isDatabaseEnabled } from "@/lib/db";
import { getJob, hydrateJobFromStore } from "@/lib/jobs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  const job = isDatabaseEnabled()
    ? (await hydrateJobFromStore(jobId)) ?? getJob(jobId)
    : getJob(jobId) ?? (await hydrateJobFromStore(jobId));

  if (!job) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }

  return NextResponse.json(job);
}
