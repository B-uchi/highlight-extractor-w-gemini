import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { db } from "./db";
import { downloadFromR2, uploadFileToR2, getPresignedUrl, safeUnlink } from "./storage";
import { cutClip, stitchClips } from "./ffmpeg";
import { analyzeChunk, ensureChunksReady, extractTarget, retryDelayMs, estimateChunkTokens, isBillingQuotaError, isStorageQuotaError } from "./gemini";
import { config } from "./config";
import type { FailedChunk, GeminiClipResult, Job } from "./types";

const TMP_ROOT = "/tmp/jobs";
const MAX_CLIP_PARALLELISM = 4;
const BOUNDARY_DEDUP_SEC = 10;
const PRE_ACTION_PAD = 2.5;
const POST_ACTION_PAD = 2.5;

const GEMINI_MAX_INPUT_TOKENS = 1_048_576; // Gemini 2.5 Pro context limit

async function setJobStatus(jobId: string, patch: Partial<Job>): Promise<void> {
  await db
    .from("jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", jobId);
}

async function setJobMessage(jobId: string, content: string): Promise<void> {
  await db
    .from("messages")
    .update({ content })
    .eq("job_id", jobId)
    .eq("role", "assistant");
}

async function getJob(jobId: string): Promise<Job | null> {
  const { data } = await db.from("jobs").select("*").eq("id", jobId).single();
  return data ?? null;
}

async function checkCancelled(jobId: string): Promise<boolean> {
  const { data } = await db.from("jobs").select("status").eq("id", jobId).single();
  return data?.status === "cancelling";
}

async function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function offsetClips(
  clips: GeminiClipResult[],
  chunkStartSec: number,
  slowdown: number,
): GeminiClipResult[] {
  return clips.map((c) => ({
    ...c,
    start_sec: c.start_sec / slowdown + chunkStartSec,
    end_sec: c.end_sec / slowdown + chunkStartSec,
  }));
}

function deduplicateNearBoundary(
  clips: GeminiClipResult[],
  boundaries: number[],
): GeminiClipResult[] {
  const used = new Set<number>();
  return clips.filter((clip, i) => {
    if (used.has(i)) return false;
    const nearBoundary = boundaries.some(
      (b) => Math.abs(clip.start_sec - b) < BOUNDARY_DEDUP_SEC || Math.abs(clip.end_sec - b) < BOUNDARY_DEDUP_SEC,
    );
    if (!nearBoundary) return true;
    for (let j = i + 1; j < clips.length; j++) {
      if (
        Math.abs(clips[j].start_sec - clip.start_sec) < BOUNDARY_DEDUP_SEC &&
        (clips[j].confidence ?? 1) > (clip.confidence ?? 1)
      ) {
        used.add(i);
        return false;
      }
    }
    return true;
  });
}

function mergeAndRank(
  chunkResults: { clips: GeminiClipResult[]; chunkIndex: number; startSec: number }[],
  jobMode: Job["mode"],
  clipLimit: number | null,
  slowdown: number,
): GeminiClipResult[] {
  const boundaries = chunkResults
    .filter((c) => c.chunkIndex > 0)
    .map((c) => c.startSec);

  let all = chunkResults.flatMap(({ clips, startSec }) => offsetClips(clips, startSec, slowdown));
  all = deduplicateNearBoundary(all, boundaries);

  if (jobMode === "action_extraction") {
    all.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
    if (clipLimit) all = all.slice(0, clipLimit);
  } else {
    all.sort((a, b) => a.start_sec - b.start_sec);
  }

  return all.map((c, i) => ({ ...c, rank: i + 1 }));
}

async function extractAndUploadClip(
  jobId: string,
  conversationId: string,
  clip: GeminiClipResult & { rank: number },
  sourcePath: string,
  followUpSecs: number | null,
  clipIndex: number,
  isHighlightMode: boolean,
): Promise<{
  id: string;
  r2_clip_key: string;
  r2_clip_url: string;
  r2_follow_up_clip_key: string | null;
  r2_follow_up_clip_url: string | null;
  start_sec: number;
  end_sec: number;
  follow_up_end_sec: number | null;
}> {
  const clipId = randomUUID();
  const tmpOutMain = path.join(TMP_ROOT, jobId, `clip_${clipIndex}.mp4`);

  const cutStart = Math.max(0, clip.start_sec - PRE_ACTION_PAD);
  const naturalEnd = clip.end_sec + POST_ACTION_PAD;
  const followUpEndSec = followUpSecs ? naturalEnd + followUpSecs : null;

  // Highlight mode: merge follow-up into the main clip so there's one file per play.
  // Individual mode: action clip ends at naturalEnd; follow-up is a separate file.
  const clipEnd = isHighlightMode && followUpEndSec ? followUpEndSec : naturalEnd;

  await cutClip(sourcePath, cutStart, clipEnd, tmpOutMain);

  const r2Key = `clips/${conversationId}/${jobId}/${clip.rank}-${clipId}.mp4`;
  await uploadFileToR2(tmpOutMain, r2Key);
  await safeUnlink(tmpOutMain);
  const url = await getPresignedUrl(r2Key);

  let r2FollowUpKey: string | null = null;
  let r2FollowUpUrl: string | null = null;

  if (!isHighlightMode && followUpSecs && followUpEndSec) {
    const tmpOutFollowUp = path.join(TMP_ROOT, jobId, `clip_${clipIndex}_followup.mp4`);
    await cutClip(sourcePath, naturalEnd, followUpEndSec, tmpOutFollowUp);
    r2FollowUpKey = `clips/${conversationId}/${jobId}/${clip.rank}-${clipId}-followup.mp4`;
    await uploadFileToR2(tmpOutFollowUp, r2FollowUpKey);
    await safeUnlink(tmpOutFollowUp);
    r2FollowUpUrl = await getPresignedUrl(r2FollowUpKey);
  }

  return {
    id: clipId,
    r2_clip_key: r2Key,
    r2_clip_url: url,
    r2_follow_up_clip_key: r2FollowUpKey,
    r2_follow_up_clip_url: r2FollowUpUrl,
    start_sec: cutStart,
    // Highlight mode with follow-up: end_sec absorbs the follow-up (no separate file).
    end_sec: clipEnd,
    follow_up_end_sec: isHighlightMode ? null : followUpEndSec,
  };
}

function formatTimeRange(chunks: FailedChunk[]): string {
  const toHMS = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
  };
  const earliest = Math.min(...chunks.map((c) => c.startSec));
  const latest = Math.max(...chunks.map((c) => c.endSec));
  return `${toHMS(earliest)}–${toHMS(latest)}`;
}

export async function processJob(jobId: string): Promise<void> {
  // Atomic claim: only proceed if job is still pending.
  const { data: claimedJob, error: claimErr } = await db
    .from("jobs")
    .update({ status: "extracting_target", updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "pending")
    .select()
    .single();

  if (claimErr || !claimedJob) return;

  let job: Job | null = claimedJob as Job;
  const tmpJobDir = path.join(TMP_ROOT, jobId);
  await mkdir(tmpJobDir, { recursive: true });
  let billingErrorMsg: string | null = null;

  try {
    // ── Step 1: Validate + extract target ────────────────────────────────────
    // Already set to "extracting_target" via claim above.

    const unfilledTokens = [...job.prompt.matchAll(/\[([A-Za-z][A-Za-z\s]*)\]/g)].map((m) => m[0]);
    if (unfilledTokens.length > 0) {
      const unique = [...new Set(unfilledTokens)];
      await setJobStatus(jobId, { status: "unsupported" });
      await setJobMessage(jobId, `Please fill in the template fields before submitting: ${unique.join(", ")}`);
      return;
    }

    const preStep = await extractTarget(job.prompt);

    if (!preStep.supported) {
      await setJobStatus(jobId, { status: "unsupported" });
      await setJobMessage(jobId, `Action not supported. I can only extract video clips — try asking for specific plays like dunks, blocks, assists, or player/team highlights.`);
      return;
    }

    const mode = preStep.mode as Job["mode"];
    await setJobStatus(jobId, {
      mode,
      status: "analyzing",
      extracted_target: preStep.target,
      jersey_number: preStep.jerseyNumber,
      jersey_color: preStep.jerseyColor,
      team_name: preStep.teamName,
      include_audio: preStep.includeAudio,
    });

    job = await getJob(jobId);
    if (!job) return;

    // ── Step 2: Get conversation video info ──────────────────────────────────
    const { data: conv } = await db
      .from("conversations")
      .select("r2_video_key, video_duration_secs")
      .eq("id", job.conversation_id)
      .single();

    if (!conv?.r2_video_key || !conv.video_duration_secs) {
      throw new Error("Conversation has no video uploaded.");
    }

    // Pre-flight: verify a single chunk won't exceed Gemini's per-request token limit.
    const tokensPerChunk = estimateChunkTokens(config.gemini.chunkDurationSec);
    if (tokensPerChunk > GEMINI_MAX_INPUT_TOKENS) {
      throw new Error(
        `Video chunk would exceed Gemini's ${(GEMINI_MAX_INPUT_TOKENS / 1000).toFixed(0)}K token limit ` +
        `(estimated ${Math.round(tokensPerChunk / 1000)}K). ` +
        `Reduce GEMINI_CHUNK_DURATION_SEC, GEMINI_VIDEO_SLOWDOWN, or GEMINI_ANALYSIS_FPS.`,
      );
    }

    // ── Step 3: Ensure Gemini chunks are ready ───────────────────────────────
    const chunks = await ensureChunksReady(
      job.conversation_id,
      conv.r2_video_key,
      conv.video_duration_secs,
    );

    // Cancellation check before analysis
    if (await checkCancelled(jobId)) {
      await setJobMessage(jobId, "Job was cancelled before analysis started.");
      await setJobStatus(jobId, { status: "cancelled" });
      return;
    }

    // ── Step 4: Analyze all chunks (coordinated, with 429 backoff + cancel support) ─
    const slowdown = config.gemini.videoSlowdownFactor;

    // Pre-seed from chunk_cache (previous run's successful results).
    const cachedResults = new Map<number, GeminiClipResult[]>(
      Object.entries((job.chunk_cache ?? {}) as Record<string, GeminiClipResult[]>)
        .map(([k, v]) => [Number(k), v]),
    );

    // Pre-load cached chunks into results so they appear in the final merge.
    const chunkResults: { clips: GeminiClipResult[]; chunkIndex: number; startSec: number }[] = [];
    for (const chunk of chunks) {
      const cached = cachedResults.get(chunk.chunkIndex);
      if (cached) chunkResults.push({ clips: cached, chunkIndex: chunk.chunkIndex, startSec: chunk.startSec });
    }

    const failedChunks: FailedChunk[] = [];
    let chunksAnalyzed = cachedResults.size;
    let currentParallelism = config.gemini.analysisParallelism;

    // Queue: only chunks not already cached.
    const pending = chunks.filter((c) => !cachedResults.has(c.chunkIndex));

    await setJobStatus(jobId, { chunks_total: chunks.length, chunks_analyzed: chunksAnalyzed });

    while (pending.length > 0) {
      if (await checkCancelled(jobId)) break;

      const batch = pending.splice(0, currentParallelism);
      const batchController = new AbortController();
      let retryDelay: number | null = null;

      const batchResults = await Promise.allSettled(
        batch.map(async (chunk) => {
          if (batchController.signal.aborted) throw Object.assign(new Error("batch-abort"), { batchAbort: true });
          const chunkDurationSec = (chunk.endSec - chunk.startSec) * slowdown;
          try {
            const clips = await analyzeChunk(chunk.geminiFileId, job!, chunkDurationSec, batchController.signal);
            return { clips, chunkIndex: chunk.chunkIndex, startSec: chunk.startSec };
          } catch (err) {
            // On first 429 in a batch: record delay + abort siblings.
            const delay = retryDelayMs(err);
            if (delay !== null && retryDelay === null) {
              retryDelay = delay;
              batchController.abort();
            } else if (isBillingQuotaError(err) && !batchController.signal.aborted) {
              batchController.abort(); // Cancel sibling requests — billing errors are not retryable
            }
            throw err;
          }
        }),
      );

      // triage results
      const toRetry: typeof batch = [];
      for (let bi = 0; bi < batchResults.length; bi++) {
        const result = batchResults[bi];
        const chunk = batch[bi];

        if (result.status === "fulfilled") {
          chunkResults.push(result.value);
          if (!cachedResults.has(chunk.chunkIndex)) {
            cachedResults.set(chunk.chunkIndex, result.value.clips);
          }
          chunksAnalyzed++;
        } else {
          const err = result.reason as Error & { batchAbort?: boolean };
          const isBatchAbort = err?.batchAbort === true;
          const is429 = retryDelayMs(err) !== null;

          if (isBatchAbort || is429) {
            toRetry.push(chunk); // put back for retry
          } else if ((err as NodeJS.ErrnoException)?.name === "AbortError") {
            // User-initiated cancel signal — don't record as failure
            toRetry.push(chunk);
          } else {
            const isBilling = isBillingQuotaError(err);
            failedChunks.push({
              chunkIndex: chunk.chunkIndex,
              startSec: chunk.startSec,
              endSec: chunk.endSec,
              error: isBilling ? "Billing quota exhausted" : (err?.message ?? String(err)),
            });
            chunksAnalyzed++;
            console.warn(`[jobs] chunk ${chunk.chunkIndex} permanently failed: ${err?.message}`);
            if (isBilling && billingErrorMsg === null) {
              billingErrorMsg = "Your Gemini API quota has been exhausted. Please check your billing details or wait for the quota to reset.";
            }
          }
        }
      }

      if (billingErrorMsg !== null) {
        // Hard billing limit — mark all remaining work as failed and stop processing.
        const billingNote = "Billing quota exhausted — not attempted";
        for (const c of toRetry) {
          failedChunks.push({ chunkIndex: c.chunkIndex, startSec: c.startSec, endSec: c.endSec, error: billingNote });
          chunksAnalyzed++;
        }
        for (const c of pending) {
          failedChunks.push({ chunkIndex: c.chunkIndex, startSec: c.startSec, endSec: c.endSec, error: billingNote });
          chunksAnalyzed++;
        }
        pending.length = 0;
      } else {
        // Put retry chunks back at front.
        pending.unshift(...toRetry);
      }

      if (retryDelay !== null) {
        currentParallelism = 1; // drop parallelism after 429
        console.warn(`[jobs] 429 — waiting ${retryDelay}ms, retrying with parallelism=1`);
        await sleep(retryDelay);
      }

      await setJobStatus(jobId, {
        chunks_analyzed: chunksAnalyzed,
        chunk_cache: Object.fromEntries(cachedResults),
        ...(failedChunks.length > 0 ? { failed_chunks: failedChunks } : {}),
      });
    }

    // Cancellation mid-analysis
    if (await checkCancelled(jobId)) {
      const note = chunkResults.length > 0
        ? `Job cancelled — partial results from ${chunkResults.length}/${chunks.length} chunk(s) discarded.`
        : "Job was cancelled during analysis.";
      await setJobMessage(jobId, note);
      await setJobStatus(jobId, { status: "cancelled" });
      return;
    }

    if (chunkResults.length === 0) {
      throw new Error(billingErrorMsg ?? "All video chunks failed to analyze.");
    }

    const mergedClips = mergeAndRank(
      chunkResults,
      mode,
      job.clip_limit,
      config.gemini.videoSlowdownFactor,
    );

    if (mergedClips.length === 0) {
      await setJobStatus(jobId, { status: "done", clips_total: 0 });
      await setJobMessage(jobId, `No clips found for: "${job.extracted_target}". Try a different action or check that the video contains this type of play.`);
      return;
    }

    await setJobStatus(jobId, {
      status: "extracting_clips",
      clips_total: mergedClips.length,
      clips_done: 0,
    });

    // ── Step 5: Download source video ────────────────────────────────────────
    const sourcePath = path.join(tmpJobDir, "source.mp4");
    await downloadFromR2(conv.r2_video_key, sourcePath);

    // ── Step 6: Cut clips ────────────────────────────────────────────────────
    const clipRows: {
      id: string;
      job_id: string;
      conversation_id: string;
      title: string;
      description: string | null;
      start_sec: number;
      end_sec: number;
      follow_up_end_sec: number | null;
      rank: number;
      jersey_number: string | null;
      jersey_color: string | null;
      r2_clip_key: string;
      r2_clip_url: string;
      r2_follow_up_clip_key: string | null;
      r2_follow_up_clip_url: string | null;
      highlight_start_sec: number | null;
    }[] = [];

    for (let i = 0; i < mergedClips.length; i += MAX_CLIP_PARALLELISM) {
      const batch = mergedClips.slice(i, i + MAX_CLIP_PARALLELISM);
      await Promise.all(
        batch.map(async (clip, batchIdx) => {
          const idx = i + batchIdx;
          const uploaded = await extractAndUploadClip(
            jobId,
            job!.conversation_id,
            clip,
            sourcePath,
            job!.follow_up_secs,
            idx,
            mode !== "action_extraction",
          );
          clipRows.push({
            id: uploaded.id,
            job_id: jobId,
            conversation_id: job!.conversation_id,
            title: clip.title,
            description: clip.description ?? null,
            start_sec: uploaded.start_sec,
            end_sec: uploaded.end_sec,
            follow_up_end_sec: uploaded.follow_up_end_sec,
            rank: clip.rank,
            jersey_number: clip.jerseyNumber ?? null,
            jersey_color: clip.jerseyColor ?? null,
            r2_clip_key: uploaded.r2_clip_key,
            r2_clip_url: uploaded.r2_clip_url,
            r2_follow_up_clip_key: uploaded.r2_follow_up_clip_key,
            r2_follow_up_clip_url: uploaded.r2_follow_up_clip_url,
            highlight_start_sec: null, // calculated below, before insert
          });
          await setJobStatus(jobId, { clips_done: clipRows.length });
        }),
      );
    }

    clipRows.sort((a, b) => a.rank - b.rank);

    // Pre-calculate each clip's start offset in the stitched highlight reel.
    if (mode !== "action_extraction") {
      let offset = 0;
      for (const row of clipRows) {
        row.highlight_start_sec = offset;
        offset += (row.follow_up_end_sec ?? row.end_sec) - row.start_sec;
      }
    }

    await db.from("clips").insert(clipRows);

    // ── Step 7: Stitch (compilation only) ────────────────────────────────────
    if (mode !== "action_extraction" && clipRows.length > 0) {
      await setJobStatus(jobId, { status: "stitching" });

      const stitchPaths: string[] = [];
      for (let i = 0; i < clipRows.length; i++) {
        const row = clipRows[i];
        const stitchPath = path.join(tmpJobDir, `stitch_${i}.mp4`);
        const endSec = row.follow_up_end_sec ?? row.end_sec;
        await cutClip(sourcePath, row.start_sec, endSec, stitchPath);
        stitchPaths.push(stitchPath);
      }

      const compilationPath = path.join(tmpJobDir, "highlight.mp4");
      const concatListPath = path.join(tmpJobDir, "concat.txt");
      await stitchClips(stitchPaths, compilationPath, job.include_audio, concatListPath);

      const compilationKey = `compilations/${job.conversation_id}/${jobId}/highlight.mp4`;
      await uploadFileToR2(compilationPath, compilationKey);
      const compilationUrl = await getPresignedUrl(compilationKey);

      await setJobStatus(jobId, {
        compilation_r2_key: compilationKey,
        compilation_r2_url: compilationUrl,
      });
    }

    // ── Step 8: Finalize ─────────────────────────────────────────────────────
    // Insert assistant message BEFORE marking done — frontend sees it on reload.
    const isCompilation = mode !== "action_extraction";
    const assistantContent = isCompilation
      ? `Highlight compiled — ${clipRows.length} play${clipRows.length !== 1 ? "s" : ""} for: ${job.extracted_target}`
      : `Found ${clipRows.length} clip${clipRows.length !== 1 ? "s" : ""} for: ${job.extracted_target}`;

    const failedNote = failedChunks.length > 0
      ? billingErrorMsg !== null
        ? `\n\nNote: Billing quota was exhausted — ${formatTimeRange(failedChunks)} of the video was not analyzed. Clips shown are from the portion that completed.`
        : `\n\nNote: ${failedChunks.length} chunk(s) could not be processed — ${formatTimeRange(failedChunks)} of the original video was skipped.`
      : "";
    await setJobMessage(jobId, assistantContent + failedNote);
    await setJobStatus(jobId, { status: "done" });

    console.log(`[jobs] ${jobId} done — ${clipRows.length} clip(s)`);
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    console.error(`[jobs] ${jobId} failed: ${rawMessage}`);

    let userMessage: string;
    if (billingErrorMsg !== null) {
      userMessage = billingErrorMsg;
    } else if (isStorageQuotaError(err)) {
      userMessage = "Gemini file storage is full and could not be freed. Delete some conversations to free space, then retry.";
    } else if (isBillingQuotaError(err)) {
      userMessage = "Your Gemini API quota has been exhausted. Please check your billing details or wait for the quota to reset.";
    } else {
      userMessage = `Something went wrong: ${rawMessage}`;
    }

    await setJobMessage(jobId, userMessage);
    await setJobStatus(jobId, { status: "error", error_message: userMessage });
  } finally {
    await rm(tmpJobDir, { recursive: true, force: true });
  }
}
