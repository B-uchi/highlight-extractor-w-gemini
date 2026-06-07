import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { db } from "./db";
import { downloadFromR2, uploadFileToR2, deleteFromR2 } from "./storage";
import { preprocessVideo, getVideoDuration } from "./ffmpeg";
import { processJob } from "./jobs";
import { config } from "./config";

const PREPROCESSING_TMP = "/tmp/preprocessing";

// ── Analysis job slot guard ───────────────────────────────────────────────────

const activeAnalysisJobIds = new Set<string>();

function startAnalysisJob(jobId: string): void {
  if (activeAnalysisJobIds.size > 0) {
    console.log(`[worker] job ${jobId} queued — analysis slot occupied by ${[...activeAnalysisJobIds][0]}`);
    return; // poll fallback will pick it up when the current job finishes
  }
  activeAnalysisJobIds.add(jobId);
  void processJob(jobId).finally(() => {
    activeAnalysisJobIds.delete(jobId);
    void drainAnalysisJobs(); // kick next pending job immediately
  });
}

// ── Preprocessing job processor ───────────────────────────────────────────────

async function processPreprocessingJob(jobId: string): Promise<void> {
  const { data: job, error: claimErr } = await db
    .from("video_preprocessing_jobs")
    .update({ status: "processing", updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "pending")
    .select()
    .single();

  if (claimErr || !job) return;

  console.log(`[worker] preprocessing job ${jobId} for conversation ${job.conversation_id}`);

  const tmpDir = path.join(PREPROCESSING_TMP, jobId);
  const rawPath = path.join(tmpDir, "raw");
  const processedPath = path.join(tmpDir, "processed.mp4");

  async function setStep(step: "downloading" | "transcoding" | "uploading" | "done") {
    await db
      .from("video_preprocessing_jobs")
      .update({ step, updated_at: new Date().toISOString() })
      .eq("id", jobId);
  }

  try {
    await mkdir(tmpDir, { recursive: true });

    console.log(`[worker] downloading raw video: ${job.r2_raw_key}`);
    await setStep("downloading");
    await downloadFromR2(job.r2_raw_key, rawPath);

    console.log("[worker] transcoding...");
    await setStep("transcoding");
    await preprocessVideo(rawPath, processedPath);
    await rm(rawPath, { force: true });

    const durationSecs = await getVideoDuration(processedPath);
    console.log(`[worker] duration: ${durationSecs}s`);

    const r2Key = `videos/${job.conversation_id}/${Date.now()}.mp4`;
    console.log(`[worker] uploading processed video: ${r2Key}`);
    await setStep("uploading");
    await uploadFileToR2(processedPath, r2Key);

    const title = job.original_filename.replace(/\.[^/.]+$/, "");

    await db.from("conversations").update({
      r2_video_key: r2Key,
      video_filename: job.original_filename,
      video_duration_secs: Math.round(durationSecs),
      status: "active",
      title,
      preprocessing_error: null,
      updated_at: new Date().toISOString(),
    }).eq("id", job.conversation_id);

    await deleteFromR2(job.r2_raw_key).catch((e: Error) =>
      console.warn(`[worker] failed to delete raw R2 key: ${e.message}`),
    );

    await setStep("done");
    await db.from("video_preprocessing_jobs").update({
      status: "done",
      updated_at: new Date().toISOString(),
    }).eq("id", jobId);

    console.log(`[worker] preprocessing job ${jobId} done`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] preprocessing job ${jobId} failed: ${message}`);

    await db.from("video_preprocessing_jobs").update({
      status: "error",
      error_message: message,
      updated_at: new Date().toISOString(),
    }).eq("id", jobId);

    await db.from("conversations").update({
      preprocessing_error: `Processing failed: ${message}`,
      updated_at: new Date().toISOString(),
    }).eq("id", job.conversation_id);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Startup drains ────────────────────────────────────────────────────────────

async function drainPreprocessing(): Promise<void> {
  const stuckBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const { data: jobs } = await db
    .from("video_preprocessing_jobs")
    .select("id, status")
    .or(`status.eq.pending,and(status.eq.processing,updated_at.lt.${stuckBefore})`)
    .limit(20);

  if (!jobs || jobs.length === 0) return;

  console.log(`[worker] draining ${jobs.length} preprocessing job(s)`);
  for (const j of jobs) {
    await db
      .from("video_preprocessing_jobs")
      .update({ status: "pending", updated_at: new Date().toISOString() })
      .eq("id", j.id)
      .eq("status", "processing");

    void processPreprocessingJob(j.id);
  }
}

async function drainAnalysisJobs(): Promise<void> {
  const stuckBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const [pendingRes, stuckRes] = await Promise.all([
    db.from("jobs").select("id").eq("status", "pending").limit(10),
    db.from("jobs")
      .select("id")
      .in("status", ["extracting_target", "analyzing", "extracting_clips", "stitching"])
      .lt("updated_at", stuckBefore)
      .limit(10),
  ]);

  const seen = new Set<string>();
  const jobs = [...(pendingRes.data ?? []), ...(stuckRes.data ?? [])].filter(
    (j) => !seen.has(j.id) && seen.add(j.id),
  );

  if (jobs.length === 0) return;

  console.log(`[worker] draining ${jobs.length} analysis job(s)`);
  for (const j of jobs) {
    // Reset stuck jobs back to pending so the atomic claim inside processJob succeeds.
    await db
      .from("jobs")
      .update({ status: "pending", updated_at: new Date().toISOString() })
      .eq("id", j.id)
      .neq("status", "pending");
    startAnalysisJob(j.id);
  }
}

// ── Realtime subscriptions ────────────────────────────────────────────────────

function subscribeToPreprocessingQueue(): void {
  db
    .channel("preprocessing-queue")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "video_preprocessing_jobs" },
      (payload) => {
        const row = payload.new as { id: string; status: string };
        if (row.status === "pending") {
          console.log(`[worker] realtime: preprocessing job ${row.id}`);
          void processPreprocessingJob(row.id);
        }
      },
    )
    .subscribe((status) => {
      console.log(`[worker] preprocessing-queue channel: ${status}`);
    });
}

function subscribeToJobQueue(): void {
  db
    .channel("job-queue")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "jobs" },
      (payload) => {
        const row = payload.new as { id: string; status: string };
        if (row.status === "pending") {
          console.log(`[worker] realtime: analysis job ${row.id}`);
          startAnalysisJob(row.id);
        }
      },
    )
    .subscribe((status) => {
      console.log(`[worker] job-queue channel: ${status}`);
    });
}

// ── Poll fallbacks ────────────────────────────────────────────────────────────

function startPollFallbacks(): void {
  setInterval(async () => {
    const { data: preprocessingJobs } = await db
      .from("video_preprocessing_jobs")
      .select("id")
      .eq("status", "pending")
      .limit(5);
    for (const j of preprocessingJobs ?? []) void processPreprocessingJob(j.id);

    const { data: analysisJobs } = await db
      .from("jobs")
      .select("id")
      .eq("status", "pending")
      .limit(3);
    for (const j of analysisJobs ?? []) startAnalysisJob(j.id);
  }, config.pollIntervalMs);
}

// ── Public start ──────────────────────────────────────────────────────────────

export async function startWorker(): Promise<void> {
  await mkdir(PREPROCESSING_TMP, { recursive: true });
  await mkdir("/tmp/jobs", { recursive: true });

  await drainPreprocessing();
  await drainAnalysisJobs();

  subscribeToPreprocessingQueue();
  subscribeToJobQueue();
  startPollFallbacks();

  console.log(`[worker] ready — polling every ${config.pollIntervalMs / 1000}s`);
}
