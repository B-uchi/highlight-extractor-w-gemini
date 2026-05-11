import { access } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

import { getJob } from "@/lib/jobs";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  const job = getJob(jobId);
  const firstClipPath = job?.clips?.[0]?.path;

  if (!job || !firstClipPath) {
    return NextResponse.json({ error: "Clip not available for this job." }, { status: 404 });
  }
  if (job.clips?.[0]?.url?.startsWith("http://") || job.clips?.[0]?.url?.startsWith("https://")) {
    return NextResponse.redirect(job.clips[0].url);
  }

  try {
    await access(firstClipPath);
  } catch {
    return NextResponse.json({ error: "Clip file not found on disk." }, { status: 404 });
  }

  const nodeStream = createReadStream(firstClipPath);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

  return new NextResponse(webStream, {
    headers: {
      "content-type": "video/mp4",
      "cache-control": "no-store",
      "content-disposition": `inline; filename="${jobId}.mp4"`,
    },
  });
}
