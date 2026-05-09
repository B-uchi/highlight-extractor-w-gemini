import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";

if (!ffmpegPath) {
  throw new Error("ffmpeg-static did not provide a binary path.");
}

function resolveFfmpegPath(candidatePath: string): string {
  if (existsSync(candidatePath)) {
    return candidatePath;
  }

  // Next.js can bundle with /ROOT-prefixed paths that do not exist on disk.
  if (candidatePath.startsWith("/ROOT/")) {
    const projectRelative = candidatePath.replace("/ROOT/", "");
    const remappedPath = path.join(process.cwd(), projectRelative);
    if (existsSync(remappedPath)) {
      return remappedPath;
    }
  }

  const localRequire = createRequire(import.meta.url);
  const packageJsonPath = localRequire.resolve("ffmpeg-static/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const platformBinary = path.join(packageDir, path.basename(candidatePath));

  if (existsSync(platformBinary)) {
    return platformBinary;
  }

  throw new Error(
    `Unable to locate ffmpeg binary. Tried: ${candidatePath}, ${platformBinary}`,
  );
}

const resolvedFfmpegPath = resolveFfmpegPath(ffmpegPath);
ffmpeg.setFfmpegPath(resolvedFfmpegPath);

export function runCommand(command: ffmpeg.FfmpegCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    command.on("end", () => resolve()).on("error", (error) => reject(error)).run();
  });
}

export function getMediaDurationSec(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolvedFfmpegPath, ["-i", filePath]);
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", () => {
      const match = stderr.match(/Duration:\s(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
      if (!match) {
        reject(new Error(`Unable to determine media duration: ${filePath}`));
        return;
      }

      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);

      resolve(hours * 3600 + minutes * 60 + seconds);
    });
  });
}

export { ffmpeg };
