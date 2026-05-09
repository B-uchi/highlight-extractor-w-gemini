import path from "node:path";

import { ffmpeg, runCommand } from "@/lib/ffmpeg";

export async function extractAudio(inputPath: string, outputDir: string): Promise<string> {
  const audioPath = path.join(outputDir, "audio.mp3");

  const command = ffmpeg(inputPath)
    .noVideo()
    .audioChannels(1)
    .audioFrequency(16_000)
    .audioBitrate("64k")
    .format("mp3")
    .output(audioPath);

  await runCommand(command);
  return audioPath;
}
