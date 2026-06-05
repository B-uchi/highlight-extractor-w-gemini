import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

function run(args: string[], timeoutMs = 30 * 60 * 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(getBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`FFmpeg timed out`)); }, timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
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
