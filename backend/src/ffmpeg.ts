import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

let _bin: string | null = null;

function getBin(): string {
  if (_bin) return _bin;

  const binaryName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates = [
    path.join(__dirname, "..", "node_modules", "ffmpeg-static", binaryName),
    path.join(process.cwd(), "node_modules", "ffmpeg-static", binaryName),
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
  ];

  for (const p of candidates) {
    if (existsSync(p)) { _bin = p; return _bin; }
  }
  throw new Error(`Cannot locate ffmpeg. Searched:\n${candidates.join("\n")}`);
}

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(getBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-3000)}`));
    });
  });
}

// -movflags +faststart intentionally omitted — see lib/ffmpeg.ts comment.
export async function preprocessVideo(inputPath: string, outputPath: string): Promise<void> {
  await run([
    "-y", "-i", inputPath,
    "-vf", "scale=-2:720",
    "-c:v", "libx264", "-preset", "fast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k",
    outputPath,
  ]);
}

export async function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(getBin(), ["-i", filePath], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("close", () => {
      const match = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
      if (!match) return reject(new Error(`Could not read duration from: ${filePath}`));
      const [, h, m, s] = match;
      resolve(Number(h) * 3600 + Number(m) * 60 + Number(s));
    });
    child.on("error", reject);
  });
}

/** Extract a time-range from a video using stream copy (no re-encode). Fast, approx keyframe cuts. */
export async function extractSegment(
  inputPath: string,
  startSec: number,
  durationSec: number,
  outputPath: string,
): Promise<void> {
  await run([
    "-y",
    "-ss", String(startSec),
    "-i", inputPath,
    "-t", String(durationSec),
    "-c", "copy",
    outputPath,
  ]);
}

/** Apply slow-motion for Gemini analysis. Audio is stripped. */
export async function slowdownVideo(
  inputPath: string,
  outputPath: string,
  factor: number,
): Promise<void> {
  await run([
    "-y", "-i", inputPath,
    "-vf", `setpts=${factor}*PTS`,
    "-c:v", "libx264", "-preset", "fast", "-crf", "23",
    "-an",
    outputPath,
  ]);
}

/** Cut a clip with frame accuracy using the 2-second pre-seek buffer trick. */
export async function cutClip(
  inputPath: string,
  startSec: number,
  endSec: number,
  outputPath: string,
): Promise<void> {
  const preBuf = Math.min(2, startSec);
  const seekTo = startSec - preBuf;
  const duration = endSec - startSec;

  await run([
    "-y",
    "-ss", String(seekTo),
    "-i", inputPath,
    "-ss", String(preBuf),
    "-t", String(duration),
    "-c:v", "libx264", "-preset", "fast", "-crf", "22",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    outputPath,
  ]);
}

/** Stitch an ordered list of clip paths into one output file using the concat demuxer. */
export async function stitchClips(
  clipPaths: string[],
  outputPath: string,
  includeAudio: boolean,
  concatListPath: string,
): Promise<void> {
  const listContent = clipPaths.map((p) => `file '${p}'`).join("\n");
  await writeFile(concatListPath, listContent, "utf8");

  const audioArgs = includeAudio
    ? ["-c:a", "aac", "-b:a", "128k"]
    : ["-an"];

  await run([
    "-y",
    "-f", "concat", "-safe", "0",
    "-i", concatListPath,
    "-c:v", "libx264", "-preset", "fast", "-crf", "22",
    ...audioArgs,
    "-movflags", "+faststart",
    outputPath,
  ]);
}
