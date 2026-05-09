import { JobState } from "@/lib/types";

const jobs = new Map<string, JobState>();

function nowIso(): string {
  return new Date().toISOString();
}

export function createJob(
  id: string,
  inputPath: string,
  userPrompt?: string,
  effectivePrompt?: string,
): JobState {
  const createdAt = nowIso();
  const job: JobState = {
    id,
    stage: "queued",
    progress: 0,
    message: "Job queued",
    inputPath,
    userPrompt,
    effectivePrompt,
    metrics: {
      startedAt: createdAt,
      ai: {
        openai: {
          transcriptionSeconds: 0,
        },
        gemini: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          videoSeconds: 0,
        },
        totalTokens: 0,
      },
    },
    createdAt,
    updatedAt: createdAt,
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id: string): JobState | undefined {
  return jobs.get(id);
}

export function updateJob(id: string, patch: Partial<JobState>): JobState {
  const current = jobs.get(id);
  if (!current) {
    throw new Error(`Job not found: ${id}`);
  }

  const next: JobState = {
    ...current,
    ...patch,
    updatedAt: nowIso(),
  };
  jobs.set(id, next);
  return next;
}

export function setJobError(id: string, error: unknown): JobState {
  const message = error instanceof Error ? error.message : String(error);
  return updateJob(id, {
    stage: "error",
    progress: 100,
    message: "Job failed",
    error: message,
  });
}
