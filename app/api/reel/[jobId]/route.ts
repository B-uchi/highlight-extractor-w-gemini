import { access, mkdir, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

import { isDatabaseEnabled } from "@/lib/db";
import { runFfmpegArgs } from "@/lib/ffmpeg";
import { getJob, hydrateJobFromStore } from "@/lib/jobs";
import { downloadClipToFile, isObjectStorageEnabled } from "@/lib/storage";

export const runtime = "nodejs";

/** Allow long local concat + re-encode on serverless hosts that honor this. */
export const maxDuration = 3_600;

const COPY_TIMEOUT_MS = Number(process.env.REEL_CONCAT_COPY_TIMEOUT_MS ?? 120_000);
const ENCODE_TIMEOUT_MS = Number(process.env.REEL_CONCAT_ENCODE_TIMEOUT_MS ?? 1_800_000);

function concatListLine(filePath: string): string {
  return `file '${filePath.replaceAll("'", "'\\''")}'`;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  try {
    const job = isDatabaseEnabled()
      ? (await hydrateJobFromStore(jobId)) ?? getJob(jobId)
      : getJob(jobId) ?? (await hydrateJobFromStore(jobId));
    if (!job?.clips?.length) {
      return NextResponse.json({ error: "No clips available for this job." }, { status: 404 });
    }

    const body = (await request.json().catch(() => ({}))) as { clipIds?: string[] };
    const selected = body.clipIds?.length
      ? job.clips.filter((clip) => body.clipIds?.includes(clip.id))
      : job.clips;
    if (!selected.length) {
      return NextResponse.json({ error: "No matching clips selected." }, { status: 400 });
    }

    const workingDir = path.join(process.cwd(), "tmp", jobId);
    const stagingDir = path.join(workingDir, "reel-staging");
    await mkdir(stagingDir, { recursive: true });

    const resolvedPaths: string[] = [];
    for (const clip of selected) {
      try {
        await access(clip.path);
        resolvedPaths.push(clip.path);
      } catch {
        if (!isObjectStorageEnabled()) {
          return NextResponse.json({ error: `Clip file missing on disk: ${clip.id}` }, { status: 404 });
        }
        const localPath = path.join(stagingDir, `${clip.id}.mp4`);
        try {
          await downloadClipToFile(jobId, clip.id, localPath);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return NextResponse.json(
            { error: `Could not load clip ${clip.id} from storage: ${message}` },
            { status: 502 },
          );
        }
        resolvedPaths.push(localPath);
      }
    }

    const listPath = path.join(workingDir, "reel-inputs.txt");
    const outputPath = path.join(workingDir, "reel.mp4");
    await writeFile(listPath, resolvedPaths.map(concatListLine).join("\n"), "utf8");

    const copyArgs = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      outputPath,
    ];

    try {
      await runFfmpegArgs(copyArgs, COPY_TIMEOUT_MS);
    } catch (copyError) {
      console.warn(`[reel ${jobId}] stream-copy concat failed, re-encoding:`, copyError);
      const encodeArgs = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-movflags",
        "+faststart",
        outputPath,
      ];
      await runFfmpegArgs(encodeArgs, ENCODE_TIMEOUT_MS);
    }

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
    console.error(`[reel ${jobId}] failed`, error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
