import { access } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

import { getJob } from "@/lib/jobs";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string; clipId: string }> },
) {
  const { jobId, clipId } = await context.params;
  const job = getJob(jobId);
  const clip = job?.clips?.find((item) => item.id === clipId);

  if (!job || !clip?.path) {
    return NextResponse.json({ error: "Clip not available for this job." }, { status: 404 });
  }

  try {
    await access(clip.path);
  } catch {
    return NextResponse.json({ error: "Clip file not found on disk." }, { status: 404 });
  }

  const nodeStream = createReadStream(clip.path);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

  return new NextResponse(webStream, {
    headers: {
      "content-type": "video/mp4",
      "cache-control": "no-store",
      "content-disposition": `inline; filename="${clip.id}.mp4"`,
    },
  });
}
