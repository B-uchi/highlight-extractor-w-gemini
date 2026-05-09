import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createJob, getJob } from "../lib/jobs";
import { ffmpeg, getMediaDurationSec, runCommand } from "../lib/ffmpeg";
import { runPipeline } from "../lib/pipeline";

interface TestCase {
  name: string;
  durationSec: number;
}

const cases: TestCase[] = [
  { name: "short-6min", durationSec: 360 },
  { name: "long-11min", durationSec: 660 },
];

async function generateSyntheticVideo(outputPath: string, durationSec: number): Promise<void> {
  const command = ffmpeg()
    .input("testsrc=size=1280x720:rate=30")
    .inputFormat("lavfi")
    .input("sine=frequency=1000:sample_rate=16000")
    .inputFormat("lavfi")
    .duration(durationSec)
    .videoCodec("mpeg4")
    .audioCodec("aac")
    .outputOptions(["-pix_fmt yuv420p", "-shortest"])
    .output(outputPath);

  await runCommand(command);
}

async function runCase(testCase: TestCase): Promise<void> {
  const fixtureDir = path.join(process.cwd(), "tmp", "smoke-fixtures");
  await mkdir(fixtureDir, { recursive: true });

  const inputPath = path.join(fixtureDir, `${testCase.name}.mp4`);
  await generateSyntheticVideo(inputPath, testCase.durationSec);

  const jobId = randomUUID();
  createJob(jobId, inputPath);
  await runPipeline(jobId);

  const job = getJob(jobId);
  if (!job || job.stage !== "done" || !job.highlights || !job.clips) {
    throw new Error(`Case ${testCase.name} failed: job did not complete.`);
  }
  if (job.highlights.length < 1) {
    throw new Error(`Case ${testCase.name} failed: no highlights produced.`);
  }
  if (job.clips.length !== job.highlights.length) {
    throw new Error(`Case ${testCase.name} failed: clip/highlight mismatch.`);
  }

  for (const clip of job.clips) {
    await access(clip.path);
    const clipDurationSec = await getMediaDurationSec(clip.path);
    if (clipDurationSec <= 0) {
      throw new Error(`Case ${testCase.name} failed: clip ${clip.id} has invalid duration.`);
    }
  }

  if (
    !job.highlights.some(
      (highlight) =>
        highlight.reason.toLowerCase().includes("mock") ||
        highlight.title.toLowerCase().includes("mock"),
    )
  ) {
    throw new Error(`Case ${testCase.name} failed: expected mock highlight reason.`);
  }

  console.log(
    `[ok] ${testCase.name} -> highlights=${job.highlights.length} clips=${job.clips.length} first=${job.highlights[0].title}`,
  );
}

async function main(): Promise<void> {
  if (process.env.MOCK_AI !== "true") {
    throw new Error("Set MOCK_AI=true to run smoke tests without OpenAI credentials.");
  }

  for (const testCase of cases) {
    await runCase(testCase);
  }

  console.log("[done] smoke test passed for both short and long videos.");
}

void main();
