import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { ffmpeg, getMediaDurationSec, runCommand } from "@/lib/ffmpeg";

export interface VideoChunk {
  path: string;
  startSec: number;
  durationSec: number;
}

const LONG_VIDEO_THRESHOLD_SEC = 1_200;
const CHUNK_DURATION_SEC = 900;

export async function chunkVideo(inputVideoPath: string, outputDir: string): Promise<VideoChunk[]> {
  const totalDurationSec = await getMediaDurationSec(inputVideoPath);
  if (totalDurationSec <= LONG_VIDEO_THRESHOLD_SEC) {
    return [
      {
        path: inputVideoPath,
        startSec: 0,
        durationSec: totalDurationSec,
      },
    ];
  }

  const chunksDir = path.join(outputDir, "video-chunks");
  await mkdir(chunksDir, { recursive: true });

  const chunkPattern = path.join(chunksDir, "video-%03d.mp4");
  const command = ffmpeg(inputVideoPath)
    .outputOptions([
      "-f segment",
      `-segment_time ${CHUNK_DURATION_SEC}`,
      "-reset_timestamps 1",
      "-c copy",
      "-movflags +faststart",
    ])
    .output(chunkPattern);

  await runCommand(command);

  const files = (await readdir(chunksDir))
    .filter((file) => file.endsWith(".mp4"))
    .sort((a, b) => a.localeCompare(b));

  let runningStart = 0;
  const chunks: VideoChunk[] = [];
  for (const file of files) {
    const filePath = path.join(chunksDir, file);
    const durationSec = await getMediaDurationSec(filePath);
    chunks.push({
      path: filePath,
      startSec: runningStart,
      durationSec,
    });
    runningStart += durationSec;
  }

  return chunks;
}
