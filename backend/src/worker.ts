import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { db } from "./db";
import { downloadFromR2, uploadFileToR2, deleteFromR2 } from "./storage";
import { preprocessVideo, getVideoDuration } from "./ffmpeg";
import { config } from "./config";

const TMP_ROOT = "/tmp/preprocessing";

// ── Job processor ─────────────────────────────────────────────────────────────

async function processJob(jobId: string): Promise<void> {
  // Mark as processing (atomic — prevents double-pickup)
  const { data: job, error: claimErr } = await db
    .from("video_preprocessing_jobs")
    .update({ status: "processing", updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "pending")
    .select()
    .single();

  if (claimErr || !job) {
    // Another worker instance claimed it first — nothing to do.
    return;
  }

  console.log(`[worker] processing job ${jobId} for conversation ${job.conversation_id}`);

  const tmpDir = path.join(TMP_ROOT, jobId);
  const rawPath = path.join(tmpDir, "raw");
  const processedPath = path.join(tmpDir, "processed.mp4");

  // Convenience: stamp current step on the job row so the frontend can track real progress.
  async function setStep(step: "downloading" | "transcoding" | "uploading" | "done") {
    await db
      .from("video_preprocessing_jobs")
      .update({ step, updated_at: new Date().toISOString() })
      .eq("id", jobId);
  }

  try {
    await mkdir(tmpDir, { recursive: true });

    console.log(`[worker] downloading raw video from R2: ${job.r2_raw_key}`);
    await setStep("downloading");
    await downloadFromR2(job.r2_raw_key, rawPath);

    console.log("[worker] transcoding...");
    await setStep("transcoding");
    await preprocessVideo(rawPath, processedPath);
    await rm(rawPath, { force: true });

    const durationSecs = await getVideoDuration(processedPath);
    console.log(`[worker] duration: ${durationSecs}s`);

    const r2Key = `videos/${job.conversation_id}/${Date.now()}.mp4`;
    console.log(`[worker] uploading processed video to R2: ${r2Key}`);
    await setStep("uploading");
    await uploadFileToR2(processedPath, r2Key);

    const title = job.original_filename.replace(/\.[^/.]+$/, "");

    // Mark conversation active — frontend Realtime listener triggers off this.
    await db.from("conversations").update({
      r2_video_key: r2Key,
      video_filename: job.original_filename,
      video_duration_secs: Math.round(durationSecs),
      status: "active",
      title,
      preprocessing_error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", job.conversation_id);

    // Clean up raw upload from R2 (best-effort)
    await deleteFromR2(job.r2_raw_key).catch((e: Error) =>
      console.warn(`[worker] failed to delete raw R2 key: ${e.message}`),
    );

    await setStep("done");
    await db.from("video_preprocessing_jobs").update({
      status: "done",
      updated_at: new Date().toISOString(),
    }).eq("id", jobId);

    console.log(`[worker] job ${jobId} done`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] job ${jobId} failed: ${message}`);

    await db.from("video_preprocessing_jobs").update({
      status: "error",
      error_message: message,
      updated_at: new Date().toISOString(),
    }).eq("id", jobId);

    // Surface the error to the frontend via the conversation row.
    await db.from("conversations").update({
      preprocessing_error: `Processing failed: ${message}`,
      updated_at: new Date().toISOString(),
    }).eq("id", job.conversation_id);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Startup drain ─────────────────────────────────────────────────────────────
// Pick up any pending jobs that arrived before this process started, or
// jobs that were left in 'processing' state by a crashed previous instance.

async function drainPending(): Promise<void> {
  const stuckBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const { data: jobs } = await db
    .from("video_preprocessing_jobs")
    .select("id")
    .or(`status.eq.pending,and(status.eq.processing,updated_at.lt.${stuckBefore})`)
    .limit(20);

  if (!jobs || jobs.length === 0) return;

  console.log(`[worker] draining ${jobs.length} pending/stuck job(s)`);
  for (const j of jobs) {
    // Reset stuck 'processing' jobs back to pending so the claim check inside
    // processJob can succeed.
    await db
      .from("video_preprocessing_jobs")
      .update({ status: "pending", updated_at: new Date().toISOString() })
      .eq("id", j.id)
      .eq("status", "processing");

    void processJob(j.id);
  }
}

// ── Realtime subscription ─────────────────────────────────────────────────────

function subscribeToQueue(): void {
  db
    .channel("preprocessing-queue")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "video_preprocessing_jobs" },
      (payload) => {
        const row = payload.new as { id: string; status: string };
        if (row.status === "pending") {
          console.log(`[worker] realtime: new job ${row.id}`);
          void processJob(row.id);
        }
      },
    )
    .subscribe((status) => {
      console.log(`[worker] realtime channel: ${status}`);
    });
}

// ── Poll fallback ─────────────────────────────────────────────────────────────
// Catches anything Realtime missed (reconnects, brief disconnects, etc.)

function startPollFallback(): void {
  setInterval(async () => {
    const { data: jobs } = await db
      .from("video_preprocessing_jobs")
      .select("id")
      .eq("status", "pending")
      .limit(5);

    for (const j of jobs ?? []) {
      void processJob(j.id);
    }
  }, config.pollIntervalMs);
}

// ── Public start ──────────────────────────────────────────────────────────────

export async function startWorker(): Promise<void> {
  await mkdir(TMP_ROOT, { recursive: true });
  await drainPending();
  subscribeToQueue();
  startPollFallback();
  console.log(`[worker] ready — polling every ${config.pollIntervalMs / 1000}s`);
}
