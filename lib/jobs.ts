import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { analyzeChunk, ensureChunksReady, extractTarget } from "@/lib/gemini";
import { cutClip, stitchClips } from "@/lib/ffmpeg";
import { appConfig } from "@/lib/config";
import { createServerClient } from "@/lib/supabase";
import {
  downloadFromR2,
  getPresignedUrl,
  safeUnlink,
  uploadFileToR2,
} from "@/lib/storage";
import type { GeminiClipResult, Job } from "@/lib/types";

const MAX_CLIP_PARALLELISM = 3;
const BOUNDARY_DEDUP_SEC = 10;

// ── Job status helpers ────────────────────────────────────────────────────────

async function setJobStatus(jobId: string, patch: Partial<Job>): Promise<void> {
  const db = createServerClient();
  await db
    .from("jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", jobId);
}

async function getJob(jobId: string): Promise<Job | null> {
  const db = createServerClient();
  const { data } = await db.from("jobs").select("*").eq("id", jobId).single();
  return data ?? null;
}

// ── Result merging ────────────────────────────────────────────────────────────

// Gemini returns timestamps in slowed-video time.
// Divide by slowdown factor to recover original video time, then add chunk offset.
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

// Padding applied around Gemini's start_sec/end_sec when cutting each clip.
const PRE_ACTION_PAD = 2.5;   // seconds before start_sec: captures the build-up
const POST_ACTION_PAD = 2.5;  // seconds after end_sec: captures the completion beat

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
    // Find duplicates within boundary window
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
    // Compilations: chronological order
    all.sort((a, b) => a.start_sec - b.start_sec);
  }

  // Re-assign ranks sequentially
  return all.map((c, i) => ({ ...c, rank: i + 1 }));
}

// ── Clip extraction ───────────────────────────────────────────────────────────

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
  const tmpOutMain = path.join(process.cwd(), "tmp", jobId, `clip_${clipIndex}.mp4`);
  const tmpOutFollowUp = followUpSecs ? path.join(process.cwd(), "tmp", jobId, `clip_${clipIndex}_followup.mp4`) : null;

  const cutStart = Math.max(0, clip.start_sec - PRE_ACTION_PAD);
  const naturalEnd = clip.end_sec + POST_ACTION_PAD;
  const followUpEndSec = followUpSecs ? naturalEnd + followUpSecs : null;

  // Cut main clip
  await cutClip(sourcePath, cutStart, naturalEnd, tmpOutMain);

  let r2FollowUpKey: string | null = null;
  let r2FollowUpUrl: string | null = null;

  if (followUpSecs && tmpOutFollowUp && followUpEndSec) {
    // Cut follow-up clip separately
    await cutClip(sourcePath, naturalEnd, followUpEndSec, tmpOutFollowUp);
  }

  const r2Key = `clips/${conversationId}/${jobId}/${clip.rank}-${clipId}.mp4`;
  await uploadFileToR2(tmpOutMain, r2Key);
  await safeUnlink(tmpOutMain);
  const url = await getPresignedUrl(r2Key);

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

// ── Main pipeline ─────────────────────────────────────────────────────────────

export async function processJob(jobId: string): Promise<void> {
  const db = createServerClient();
  let job = await getJob(jobId);
  if (!job) return;

  const conversationId = job.conversation_id;
  const tmpJobDir = path.join(process.cwd(), "tmp", jobId);
  await mkdir(tmpJobDir, { recursive: true });

  try {
    // ── Step 1: Extract target ──────────────────────────────────────────────
    await setJobStatus(jobId, { status: "extracting_target" });
    job = await getJob(jobId);
    if (!job) return;

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

    // Refresh job with new fields
    job = await getJob(jobId);
    if (!job) return;

    // ── Step 2: Get conversation video info ────────────────────────────────
    const { data: conv } = await db
      .from("conversations")
      .select("r2_video_key, video_duration_secs")
      .eq("id", job.conversation_id)
      .single();

    if (!conv?.r2_video_key || !conv.video_duration_secs) {
      throw new Error("Conversation has no video uploaded.");
    }

    // ── Step 3: Ensure Gemini chunks are ready ─────────────────────────────
    const chunks = await ensureChunksReady(
      job.conversation_id,
      conv.r2_video_key,
      conv.video_duration_secs,
    );

    // ── Step 4: Analyze all chunks (parallel, capped) ──────────────────────
    const parallelism = appConfig.gemini.analysisParallelism;
    const chunkResults: { clips: GeminiClipResult[]; chunkIndex: number; startSec: number }[] = [];

    for (let i = 0; i < chunks.length; i += parallelism) {
      const batch = chunks.slice(i, i + parallelism);
      const batchResults = await Promise.all(
        batch.map(async (chunk) => {
          const slowdown = appConfig.gemini.videoSlowdownFactor;
          // Pass the slowed duration so the prompt knows the valid timestamp range
          const chunkDurationSec = (chunk.endSec - chunk.startSec) * slowdown;
          const clips = await analyzeChunk(chunk.geminiFileId, job!, chunkDurationSec);
          return { clips, chunkIndex: chunk.chunkIndex, startSec: chunk.startSec };
        }),
      );
      chunkResults.push(...batchResults);
    }

    const mergedClips = mergeAndRank(chunkResults, mode, job.clip_limit, appConfig.gemini.videoSlowdownFactor);

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

    // ── Step 5: Download source video once ────────────────────────────────
    const sourcePath = path.join(tmpJobDir, "source.mp4");
    await downloadFromR2(conv.r2_video_key, sourcePath);

    // ── Step 6: Cut clips (parallel, capped at MAX_CLIP_PARALLELISM) ───────
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

    // Sort by rank before inserting
    clipRows.sort((a, b) => a.rank - b.rank);
    await db.from("clips").insert(clipRows);

    // ── Step 7: Stitch (compilation only) ─────────────────────────────────
    if (mode !== "action_extraction" && clipRows.length > 0) {
      await setJobStatus(jobId, { status: "stitching" });

      const clipPaths = clipRows
        .sort((a, b) => a.rank - b.rank)
        .map((_, idx) => path.join(tmpJobDir, `clip_${idx}.mp4`));

      // Re-cut source clips in rank order for stitching (they're already extracted above)
      // Actually the clips were already cut, but we deleted them — re-cut for stitch
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

      void clipPaths; // unused reference (clips were already extracted differently above)
    }

    // ── Step 8: Finalize ─────────────────────────────────────────────────
    // Insert the assistant message BEFORE marking the job done so the poller
    // always finds the message already in DB when it detects the terminal status.
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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

