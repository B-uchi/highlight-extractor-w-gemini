import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function loadLocalEnvFile(fileName: string): void {
  const filePath = path.join(process.cwd(), fileName);
  if (!existsSync(filePath)) {
    return;
  }

  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

async function main(): Promise<void> {
  loadLocalEnvFile(".env.local");

  const [{ createPipelineWorker }, { runPipeline }] = await Promise.all([
    import("@/lib/queue"),
    import("@/lib/pipeline"),
  ]);

  const worker = createPipelineWorker(async (jobId) => {
    await runPipeline(jobId);
  });

  worker.on("completed", (job) => {
    console.log(`Worker completed job: ${job.id}`);
  });

  worker.on("failed", (job, error) => {
    console.error(`Worker failed job: ${job?.id}`, error);
  });

  console.log("Pipeline worker started.");
}

void main();
