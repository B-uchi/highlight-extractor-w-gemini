import { readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createJob, getJob } from "@/lib/jobs";
import { runPipeline } from "@/lib/pipeline";

interface EvalFixture {
  id: string;
  videoPath: string;
  expectedMinHighlights: number;
  category: string;
}

async function main(): Promise<void> {
  const fixturesPath = path.join(process.cwd(), "scripts", "evals", "fixtures.json");
  const raw = await readFile(fixturesPath, "utf8");
  const fixtures = JSON.parse(raw) as EvalFixture[];

  const rows: Array<Record<string, string | number>> = [];
  for (const fixture of fixtures) {
    const jobId = randomUUID();
    const inputPath = path.join(process.cwd(), fixture.videoPath);
    createJob(jobId, inputPath);
    const startMs = Date.now();
    await runPipeline(jobId);
    const elapsedMs = Date.now() - startMs;
    const job = getJob(jobId);
    const count = job?.highlights?.length ?? 0;
    rows.push({
      fixture: fixture.id,
      category: fixture.category,
      highlights: count,
      expectedMinHighlights: fixture.expectedMinHighlights,
      latencyMs: elapsedMs,
      tokens: job?.metrics.ai.totalTokens ?? 0,
    });
  }

  console.table(rows);
}

void main();
