import path from "node:path";
import { mkdir } from "node:fs/promises";

import { ffmpeg, runCommand } from "@/lib/ffmpeg";

export async function createVisionProxyVideo(inputPath: string, outputDir: string): Promise<string> {
  const inputBaseName = path.parse(inputPath).name;
  if (inputBaseName.startsWith("proxy-")) {
    return inputPath;
  }

  await mkdir(outputDir, { recursive: true });
  const proxyPath = path.join(outputDir, `proxy-${inputBaseName}-360p-1fps.mp4`);
  const command = ffmpeg(inputPath)
    .videoFilters(["fps=1", "scale=640:-2:flags=lanczos"])
    .audioCodec("aac")
    .videoCodec("libx264")
    .outputOptions(["-preset veryfast", "-crf 30", "-movflags +faststart"])
    .output(proxyPath);

  await runCommand(command);
  return proxyPath;
}
