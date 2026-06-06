import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { db } from "./db";
import { downloadFromR2, uploadFileToR2, getPresignedUrl, safeUnlink } from "./storage";
import { cutClip, stitchClips } from "./ffmpeg";
import { analyzeChunk, ensureChunksReady, extractTarget } from "./gemini";
import { config } from "./config";
import type { GeminiClipResult, Job } from "./types";

const TMP_ROOT = "/tmp/jobs";
const MAX_CLIP_PARALLELISM = 4;
const BOUNDARY_DEDUP_SEC = 10;
const PRE_ACTION_PAD = 2.5;
const POST_ACTION_PAD = 2.5;

async function setJobStatus(jobId: string, patch: Partial<Job>): Promise<void> {
  await db
    .from("jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", jobId);
}

async function getJob(jobId: string): Promise<Job | null> {
  const { data } = await db.from("jobs").select("*").eq("id", jobId).single();
  return data ?? null;
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
  const tmpOutFollowUp = followUpSecs
    ? path.join(TMP_ROOT, jobId, `clip_${clipIndex}_followup.mp4`)
    : null;

  const cutStart = Math.max(0, clip.start_sec - PRE_ACTION_PAD);
  const naturalEnd = clip.end_sec + POST_ACTION_PAD;
  const followUpEndSec = followUpSecs ? naturalEnd + followUpSecs : null;

  await cutClip(sourcePath, cutStart, naturalEnd, tmpOutMain);

  if (followUpSecs && tmpOutFollowUp && followUpEndSec) {
    await cutClip(sourcePath, naturalEnd, followUpEndSec, tmpOutFollowUp);
  }

  const r2Key = `clips/${conversationId}/${jobId}/${clip.rank}-${clipId}.mp4`;
  await uploadFileToR2(tmpOutMain, r2Key);
  await safeUnlink(tmpOutMain);
  const url = await getPresignedUrl(r2Key);

  let r2FollowUpKey: string | null = null;
  let r2FollowUpUrl: string | null = null;

  if (followUpSecs && tmpOutFollowUp) {
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
    end_sec: naturalEnd,
    follow_up_end_sec: followUpEndSec,
  };
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
  const conversationId = job.conversation_id;
  const tmpJobDir = path.join(TMP_ROOT, jobId);
  await mkdir(tmpJobDir, { recursive: true });

  try {
    // ── Step 1: Validate + extract target ────────────────────────────────────
    // Already set to "extracting_target" via claim above.

    const unfilledTokens = [...job.prompt.matchAll(/\[([A-Za-z][A-Za-z\s]*)\]/g)].map((m) => m[0]);
    if (unfilledTokens.length > 0) {
      const unique = [...new Set(unfilledTokens)];
      await setJobStatus(jobId, { status: "unsupported" });
      await db.from("messages").insert({
        conversation_id: job.conversation_id,
        role: "assistant",
        content: `Please fill in the template fields before submitting: ${unique.join(", ")}`,
        job_id: jobId,
      });
      return;
    }

    const preStep = await extractTarget(job.prompt);

    if (!preStep.supported) {
      await setJobStatus(jobId, { status: "unsupported" });
      await db.from("messages").insert({
        conversation_id: job.conversation_id,
        role: "assistant",
        content: `Action not supported. I can only extract video clips — try asking for specific plays like dunks, blocks, assists, or player/team highlights.`,
        job_id: jobId,
      });
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

    // ── Step 3: Ensure Gemini chunks are ready ───────────────────────────────
    const chunks = await ensureChunksReady(
      job.conversation_id,
      conv.r2_video_key,
      conv.video_duration_secs,
    );

    // ── Step 4: Analyze all chunks (parallel, capped) ────────────────────────
    const parallelism = config.gemini.analysisParallelism;
    const chunkResults: { clips: GeminiClipResult[]; chunkIndex: number; startSec: number }[] = [];

    // Pre-seed from cache so retries skip chunks that already paid for.
    // chunk_cache is keyed by string (JSON object keys are always strings).
    const cachedResults = new Map<number, GeminiClipResult[]>(
      Object.entries((job.chunk_cache ?? {}) as Record<string, GeminiClipResult[]>)
        .map(([k, v]) => [Number(k), v]),
    );

    await setJobStatus(jobId, { chunks_total: chunks.length, chunks_analyzed: 0 });
    let chunksAnalyzed = 0;

    for (let i = 0; i < chunks.length; i += parallelism) {
      const batch = chunks.slice(i, i + parallelism);
      const batchResults = await Promise.allSettled(
        batch.map(async (chunk) => {
          const cached = cachedResults.get(chunk.chunkIndex);
          if (cached) return { clips: cached, chunkIndex: chunk.chunkIndex, startSec: chunk.startSec };

          const slowdown = config.gemini.videoSlowdownFactor;
          const chunkDurationSec = (chunk.endSec - chunk.startSec) * slowdown;
          const clips = await analyzeChunk(chunk.geminiFileId, job!, chunkDurationSec);
          return { clips, chunkIndex: chunk.chunkIndex, startSec: chunk.startSec };
        }),
      );

      let cacheUpdated = false;
      for (const result of batchResults) {
        chunksAnalyzed++;
        if (result.status === "fulfilled") {
          chunkResults.push(result.value);
          if (!cachedResults.has(result.value.chunkIndex)) {
            cachedResults.set(result.value.chunkIndex, result.value.clips);
            cacheUpdated = true;
          }
        } else {
          console.warn(
            `[jobs] chunk failed (continuing): ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          );
        }
      }

      await setJobStatus(jobId, {
        chunks_analyzed: chunksAnalyzed,
        ...(cacheUpdated ? { chunk_cache: Object.fromEntries(cachedResults) } : {}),
      });
    }

    if (chunkResults.length === 0) {
      throw new Error("All video chunks failed to analyze.");
    }

    const mergedClips = mergeAndRank(
      chunkResults,
      mode,
      job.clip_limit,
      config.gemini.videoSlowdownFactor,
    );

    if (mergedClips.length === 0) {
      await setJobStatus(jobId, { status: "done", clips_total: 0 });
      await db.from("messages").insert({
        conversation_id: job.conversation_id,
        role: "assistant",
        content: `No clips found for: "${job.extracted_target}". Try a different action or check that the video contains this type of play.`,
        job_id: jobId,
      });
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
          });
          await setJobStatus(jobId, { clips_done: clipRows.length });
        }),
      );
    }

    clipRows.sort((a, b) => a.rank - b.rank);
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

    await db.from("messages").insert({
      conversation_id: job.conversation_id,
      role: "assistant",
      content: assistantContent,
      job_id: jobId,
    });

    await setJobStatus(jobId, { status: "done" });

    console.log(`[jobs] ${jobId} done — ${clipRows.length} clip(s)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[jobs] ${jobId} failed: ${message}`);

    await db.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: `Something went wrong: ${message}`,
      job_id: jobId,
    });
    await setJobStatus(jobId, { status: "error", error_message: message });
  } finally {
    await rm(tmpJobDir, { recursive: true, force: true });
  }
}
