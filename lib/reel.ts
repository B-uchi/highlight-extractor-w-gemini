import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { isDatabaseEnabled } from "@/lib/db";
import { runFfmpegArgs } from "@/lib/ffmpeg";
import { getJob, hydrateJobFromStore } from "@/lib/jobs";
import { downloadClipToFile, isObjectStorageEnabled } from "@/lib/storage";
import type { GeneratedClip, JobState } from "@/lib/types";

const COPY_TIMEOUT_MS = Number(process.env.REEL_CONCAT_COPY_TIMEOUT_MS ?? 120_000);
const ENCODE_TIMEOUT_MS = Number(process.env.REEL_CONCAT_ENCODE_TIMEOUT_MS ?? 1_800_000);

function concatListLine(filePath: string): string {
  return `file '${filePath.replaceAll("'", "'\\''")}'`;
}

async function resolveJob(jobId: string): Promise<JobState | undefined> {
  if (isDatabaseEnabled()) {
    return (await hydrateJobFromStore(jobId)) ?? getJob(jobId);
  }
  return getJob(jobId) ?? (await hydrateJobFromStore(jobId));
}

/**
 * Concatenates selected clips into `tmp/{jobId}/reel.mp4` and returns the output path.
 */
export async function buildReelFile(jobId: string, clipIds?: string[]): Promise<{
  outputPath: string;
  selectedClips: GeneratedClip[];
}> {
  const job = await resolveJob(jobId);
  if (!job?.clips?.length) {
    throw new Error("No clips available for this job.");
  }

  const selected = clipIds?.length
    ? job.clips.filter((clip) => clipIds.includes(clip.id))
    : job.clips;
  if (!selected.length) {
    throw new Error("No matching clips selected.");
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
        throw new Error(`Clip file missing on disk: ${clip.id}`);
      }
      const localPath = path.join(stagingDir, `${clip.id}.mp4`);
      await downloadClipToFile(jobId, clip.id, localPath);
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

  return { outputPath, selectedClips: selected };
}
