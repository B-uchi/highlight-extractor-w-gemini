import { eq } from "drizzle-orm";

import { getDb, isDatabaseEnabled } from "@/lib/db";
import { jobsTable } from "@/lib/dbSchema";
import { normalizeProcessingPresetsState } from "@/lib/defaultActions";
import { emitJobUpdate } from "@/lib/events";
import type { JobState, PipelineLogEntry, PlayerFocusSpec, ProcessingPresetsState } from "@/lib/types";

const MAX_PIPELINE_LOGS = 500;

const jobs = new Map<string, JobState>();
/** Latest tail of chained DB writes per job (avoids out-of-order persists wiping newer state). */
const persistenceTail = new Map<string, Promise<void>>();

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

function queuePersist(job: JobState): void {
  if (!isDatabaseEnabled()) {
    return;
  }
  const id = job.id;
  const prev = persistenceTail.get(id) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(() => persistJob(job))
    .catch((error) => {
      console.error(`[jobs] persist failed for ${id}`, error);
    });

  persistenceTail.set(id, next);
  void next.finally(() => {
    if (persistenceTail.get(id) === next) {
      persistenceTail.delete(id);
    }
  });
}

function trackPersistence(job: JobState): void {
  queuePersist(job);
}

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
  /** When set with 0, no cap after ranking (subject to normalization). */
  maxHighlightsFinal?: number,
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
    ...(maxHighlightsFinal !== undefined ? { maxHighlightsFinal } : {}),
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
  trackPersistence(job);
  return job;
}

function mirrorPipelineLog(jobId: string, entry: Omit<PipelineLogEntry, "ts">): void {
  const line = `[${jobId}][${entry.stage}] ${entry.message}${entry.detail ? ` ${entry.detail}` : ""}`;
  if (entry.level === "error") {
    console.error(line);
  } else if (entry.level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
}

export function appendPipelineLog(
  jobId: string,
  entry: Omit<PipelineLogEntry, "ts">,
): JobState | undefined {
  const current = jobs.get(jobId);
  if (!current) {
    mirrorPipelineLog(jobId, entry);
    return undefined;
  }
  const prev = current.pipelineLogs ?? [];
  const nextEntry: PipelineLogEntry = {
    ts: nowIso(),
    ...entry,
  };
  mirrorPipelineLog(jobId, entry);
  return updateJob(jobId, {
    pipelineLogs: [...prev, nextEntry].slice(-MAX_PIPELINE_LOGS),
  });
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
  trackPersistence(next);
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

export async function waitForJobPersistence(id: string): Promise<void> {
  const pending = persistenceTail.get(id);
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
