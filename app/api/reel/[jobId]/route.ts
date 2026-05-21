import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

import { buildReelFile } from "@/lib/reel";

export const runtime = "nodejs";

/** Allow long local concat + re-encode on serverless hosts that honor this. */
export const maxDuration = 3_600;

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  try {
    const body = (await request.json().catch(() => ({}))) as { clipIds?: string[] };
    const { outputPath } = await buildReelFile(jobId, body.clipIds);

    const nodeStream = createReadStream(outputPath);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

    return new NextResponse(webStream, {
      headers: {
        "content-type": "video/mp4",
        "content-disposition": `attachment; filename="${jobId}-reel.mp4"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status =
      message.includes("No clips") || message.includes("not found") || message.includes("missing")
        ? 404
        : message.includes("No matching")
          ? 400
          : 500;
    console.error(`[reel ${jobId}] failed`, error);
    return NextResponse.json({ error: message }, { status });
  }
}
