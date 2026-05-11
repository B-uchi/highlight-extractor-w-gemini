import path from "node:path";

import { ffmpeg, runCommand } from "@/lib/ffmpeg";
import { GeneratedClip, Highlight } from "@/lib/types";

export async function cutSingleClip(
  inputVideoPath: string,
  outputDir: string,
  highlight: Highlight,
): Promise<string> {
  const clipPath = path.join(outputDir, "clip.mp4");

  const command = ffmpeg(inputVideoPath)
    .outputOptions([
      `-ss ${highlight.startSec}`,
      `-to ${highlight.endSec}`,
      "-c copy",
      "-movflags +faststart",
    ])
    .output(clipPath);

  await runCommand(command);
  return clipPath;
}

export async function cutClipsForHighlights(
  inputVideoPath: string,
  outputDir: string,
  highlights: Highlight[],
): Promise<GeneratedClip[]> {
  const clips: GeneratedClip[] = [];

  for (const [index, highlight] of highlights.entries()) {
    const clipId = `clip-${String(index + 1).padStart(3, "0")}`;
    const clipPath = path.join(outputDir, `${clipId}.mp4`);

    const command = ffmpeg(inputVideoPath)
      .outputOptions([
        `-ss ${highlight.startSec}`,
        `-to ${highlight.endSec}`,
        "-c copy",
        "-movflags +faststart",
      ])
      .output(clipPath);

    await runCommand(command);

    clips.push({
      id: clipId,
      path: clipPath,
      url: "",
      startSec: highlight.startSec,
      endSec: highlight.endSec,
      title: highlight.title,
      score: highlight.score,
      eventType: highlight.eventType,
      category: highlight.category,
    });
  }

  return clips;
}
