import { eq } from "drizzle-orm";

import { getDb, isDatabaseEnabled } from "@/lib/db";
import { jobsTable } from "@/lib/dbSchema";
import { normalizeProcessingPresetsState } from "@/lib/defaultActions";
import { emitJobUpdate } from "@/lib/events";
import type { JobState, PlayerFocusSpec, ProcessingPresetsState } from "@/lib/types";

const jobs = new Map<string, JobState>();
const pendingPersistence = new Map<string, Promise<void>>();

function nowIso(): string {
  return new Date().toISOString();
}

export function createJob(
  id: string,
  inputPath: string,
  userPrompt?: string,
  effectivePrompt?: string,
  category?: string,
  conversationId?: string,
  playerFocus?: PlayerFocusSpec,
  processingPresets?: ProcessingPresetsState | null,
): JobState {
  const createdAt = nowIso();
  const presets = normalizeProcessingPresetsState(processingPresets ?? null);
  const job: JobState = {
    id,
    stage: "queued",
    progress: 0,
    message: "Job queued",
    inputPath,
    userPrompt,
    effectivePrompt,
    category,
    conversationId,
    playerFocus,
    ...(presets ? { processingPresets: presets } : {}),
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
  emitJobUpdate(job);
  trackPersistence(id, persistJob(job));
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
  emitJobUpdate(next);
  void import("@/lib/agentTaskSync")
    .then(({ syncAgentTasksFromJobState }) => syncAgentTasksFromJobState(next))
    .catch(() => undefined);
  trackPersistence(id, persistJob(next));
  return next;
}

export function setJobError(id: string, error: unknown): JobState {
  const message = error instanceof Error ? error.message : String(error);
  const current = jobs.get(id);
  const failedAtStage = current?.stage && current.stage !== "error" ? current.stage : undefined;
  return updateJob(id, {
    stage: "error",
    progress: 100,
    message: "Job failed",
    error: message,
    failedAtStage,
  });
}

async function persistJob(job: JobState): Promise<void> {
  if (!isDatabaseEnabled()) {
    return;
  }

  const db = getDb();
  const createdAt = new Date(job.createdAt);
  const updatedAt = new Date(job.updatedAt);

  await db
    .insert(jobsTable)
    .values({
      id: job.id,
      stage: job.stage,
      payload: job as unknown as Record<string, unknown>,
      createdAt,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: jobsTable.id,
      set: {
        stage: job.stage,
        payload: job as unknown as Record<string, unknown>,
        updatedAt,
      },
    });
}

function trackPersistence(id: string, promise: Promise<void>): void {
  pendingPersistence.set(id, promise);
  void promise.finally(() => {
    const current = pendingPersistence.get(id);
    if (current === promise) {
      pendingPersistence.delete(id);
    }
  });
}

export async function waitForJobPersistence(id: string): Promise<void> {
  const pending = pendingPersistence.get(id);
  if (pending) {
    await pending;
  }
}

export async function hydrateJobFromStore(id: string): Promise<JobState | undefined> {
  if (!isDatabaseEnabled()) {
    return jobs.get(id);
  }
  const db = getDb();
  const result = await db.select().from(jobsTable).where(eq(jobsTable.id, id)).limit(1);
  const row = result[0];
  if (!row) {
    return undefined;
  }
  const job = row.payload as JobState;
  jobs.set(id, job);
  return job;
}
