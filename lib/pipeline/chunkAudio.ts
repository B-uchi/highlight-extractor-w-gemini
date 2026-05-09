import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import { ffmpeg, getMediaDurationSec, runCommand } from "@/lib/ffmpeg";

export interface AudioChunk {
  path: string;
  startSec: number;
  durationSec: number;
}

export async function chunkAudio(
  audioPath: string,
  outputDir: string,
  segmentDurationSec = 600,
): Promise<AudioChunk[]> {
  const chunksDir = path.join(outputDir, "chunks");
  await mkdir(chunksDir, { recursive: true });

  const chunkPattern = path.join(chunksDir, "chunk-%03d.mp3");
  const command = ffmpeg(audioPath)
    .outputOptions([
      "-f segment",
      `-segment_time ${segmentDurationSec}`,
      "-reset_timestamps 1",
      "-c copy",
    ])
    .output(chunkPattern);

  await runCommand(command);

  const files = (await readdir(chunksDir))
    .filter((file) => file.endsWith(".mp3"))
    .sort((a, b) => a.localeCompare(b));

  let runningStart = 0;
  const chunks: AudioChunk[] = [];

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
