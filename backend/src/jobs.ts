import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { db } from "./db";
import { downloadFromR2, uploadFileToR2, getPresignedUrl, safeUnlink, objectExists } from "./storage";
import { cutClip, stitchClips, extractSegmentAccurate } from "./ffmpeg";
import { analyzeChunk, ensureChunksReady, extractTarget, verifyClip, retryDelayMs, estimateChunkTokens, isBillingQuotaError, isHardBillingError, isStorageQuotaError } from "./gemini";
import { proposeClipsBatch } from "./modal";
import { config } from "./config";
import type { FailedChunk, GeminiClipResult, Job, JobMode } from "./types";

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

// ── Shared tail: cut → stitch → finalize ───────────────────────────────────────
// Used by both the Gemini path and the proposer-verifier path. `sourcePath` must
// already be downloaded. `finalNoteSuffix` appends a per-path note to the message.
async function finalizeClips(
  jobId: string,
  job: Job,
  mode: JobMode,
  mergedClips: GeminiClipResult[],
  sourcePath: string,
  tmpJobDir: string,
  finalNoteSuffix: string,
): Promise<void> {
  await setJobStatus(jobId, {
    status: "extracting_clips",
    clips_total: mergedClips.length,
    clips_done: 0,
  });

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
          job.conversation_id,
          clip as GeminiClipResult & { rank: number },
          sourcePath,
          job.follow_up_secs,
          idx,
          mode !== "action_extraction",
        );
        // Audit: candidate_t is the SAME absolute time the verifier checked (cross-reference
        // against [PV-VERIFY] t=). cut is the padded window actually written to the file.
        console.log(
          `[PV-FINAL] rank=${clip.rank} candidate_t=${clip.start_sec.toFixed(1)}-${clip.end_sec.toFixed(1)}s ` +
          `cut=${uploaded.start_sec.toFixed(1)}-${uploaded.end_sec.toFixed(1)}s ` +
          `title="${(clip.title ?? "").replace(/"/g, "'")}" key=${uploaded.r2_clip_key}`,
        );
        clipRows.push({
          id: uploaded.id,
          job_id: jobId,
          conversation_id: job.conversation_id,
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
          highlight_start_sec: null,
        });
        await setJobStatus(jobId, { clips_done: clipRows.length });
      }),
    );
  }

  clipRows.sort((a, b) => a.rank - b.rank);

  if (mode !== "action_extraction") {
    let offset = 0;
    for (const row of clipRows) {
      row.highlight_start_sec = offset;
      offset += (row.follow_up_end_sec ?? row.end_sec) - row.start_sec;
    }
  }

  await db.from("clips").insert(clipRows);

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

  const isCompilation = mode !== "action_extraction";
  const assistantContent = isCompilation
    ? `Highlight compiled — ${clipRows.length} play${clipRows.length !== 1 ? "s" : ""} for: ${job.extracted_target}`
    : `Found ${clipRows.length} clip${clipRows.length !== 1 ? "s" : ""} for: ${job.extracted_target}`;

  await setJobMessage(jobId, assistantContent + finalNoteSuffix);
  await setJobStatus(jobId, { status: "done" });
  console.log(`[jobs] ${jobId} done — ${clipRows.length} clip(s)`);
}

// ── Proposer-verifier path (Qwen proposes → Gemini verifies) ───────────────────
type Verdict = { confirmed: boolean; confidence: number; reason: string };

async function runProposerVerifier(jobId: string, job: Job, tmpJobDir: string): Promise<void> {
  const mode = job.mode;
  const t0 = Date.now();

  const { data: conv } = await db
    .from("conversations")
    .select("r2_video_key, video_duration_secs")
    .eq("id", job.conversation_id)
    .single();
  if (!conv?.r2_video_key || !conv.video_duration_secs) {
    throw new Error("Conversation has no video uploaded.");
  }
  const videoSecs = conv.video_duration_secs as number;

  const sourcePath = path.join(tmpJobDir, "source.mp4");
  await downloadFromR2(conv.r2_video_key as string, sourcePath);

  // ── Stage A: propose (resumable via chunk_cache) ─────────────────────────────
  await setJobStatus(jobId, { status: "proposing" });

  const chunkSec = config.qwen.chunkSec;
  const chunkCount = Math.ceil(videoSecs / chunkSec);
  const chunks = Array.from({ length: chunkCount }, (_, i) => ({
    index: i,
    startSec: i * chunkSec,
    endSec: Math.min((i + 1) * chunkSec, videoSecs),
  }));

  // Pre-seed proposals already saved by a previous run — these skip Modal entirely.
  const proposalCache = new Map<number, GeminiClipResult[]>(
    Object.entries((job.chunk_cache ?? {}) as Record<string, GeminiClipResult[]>)
      .map(([k, v]) => [Number(k), v]),
  );
  const failed: FailedChunk[] = [];
  let analyzed = proposalCache.size;
  const parallelism = config.qwen.proposalParallelism;

  await setJobStatus(jobId, { chunks_total: chunkCount, chunks_analyzed: analyzed });

  // vLLM batching: group pending chunks into batches; ONE Modal call processes a whole
  // batch concurrently on the GPU. A CONTINUOUS WORKER POOL of `parallelism` workers keeps
  // that many batch-calls in flight at all times — the instant a container finishes a batch
  // it pulls the next group (Modal routes it straight back to the still-warm container).
  // This avoids the head-of-line blocking + idle-scaledown-then-cold-restart of fixed waves.
  type ChunkInfo = { index: number; startSec: number; endSec: number };
  const pendingChunks: ChunkInfo[] = chunks.filter((c) => !proposalCache.has(c.index));
  const batchSize = Math.max(1, config.qwen.batchSize);
  const queue: ChunkInfo[][] = [];
  for (let i = 0; i < pendingChunks.length; i += batchSize) {
    queue.push(pendingChunks.slice(i, i + batchSize));
  }

  let cancelled = false;

  const processGroup = async (group: ChunkInfo[]) => {
    try {
      // Ensure each chunk's R2 object exists (per-video cache), presign, build items.
      // Extraction is SEQUENTIAL within a batch: each chunk is a full 60s re-encode, and
      // running all `batchSize` at once (× parallelism workers) exhausts the container's
      // memory and x264 fails to open. Sequential here → at most `parallelism` encodes total.
      const items: { chunkUrl: string; chunkSec: number }[] = [];
      for (const chunk of group) {
        const dur = chunk.endSec - chunk.startSec;
        // "-acc" marks frame-accurate chunks; it also invalidates any previously cached
        // stream-copy (keyframe-drifted) chunks for this video so they are re-extracted.
        const chunkKey = `qwen-chunks/${job.conversation_id}/${chunkSec}s-acc/${chunk.index}.mp4`;
        if (!(await objectExists(chunkKey))) {
          const localChunk = path.join(tmpJobDir, `qchunk_${chunk.index}.mp4`);
          await extractSegmentAccurate(sourcePath, chunk.startSec, dur, localChunk);
          await uploadFileToR2(localChunk, chunkKey);
          await safeUnlink(localChunk);
        }
        const url = await getPresignedUrl(chunkKey, 1800);
        items.push({ chunkUrl: url, chunkSec: dur });
      }
      const lists = await proposeClipsBatch(job, items);
      group.forEach((chunk, idx) => proposalCache.set(chunk.index, lists[idx] ?? []));
    } catch (err) {
      // Whole batch failed — record each chunk so a retry resumes just these.
      const msg = (err as Error)?.message ?? String(err);
      for (const chunk of group) {
        failed.push({ chunkIndex: chunk.index, startSec: chunk.startSec, endSec: chunk.endSec, error: msg });
      }
      console.warn(`[jobs] propose batch failed (${group.length} chunks): ${msg}`);
    } finally {
      // Persist the moment THIS batch returns — fine-grained UI progress, and a crash/quota
      // past this point never re-runs Modal for these chunks.
      analyzed += group.length;
      await setJobStatus(jobId, {
        chunks_analyzed: analyzed,
        chunk_cache: Object.fromEntries(proposalCache),
        ...(failed.length ? { failed_chunks: failed } : {}),
      });
    }
  };

  // Each worker pulls groups until the queue is empty — fast containers stay fed.
  const worker = async () => {
    while (!cancelled) {
      if (await checkCancelled(jobId)) { cancelled = true; return; }
      const group = queue.shift();
      if (!group) return;
      await processGroup(group);
    }
  };

  await Promise.all(Array.from({ length: parallelism }, () => worker()));

  if (cancelled) {
    await setJobMessage(jobId, "Job was cancelled during proposal.");
    await setJobStatus(jobId, { status: "cancelled" });
    return;
  }

  if (proposalCache.size === 0) {
    throw new Error("All chunks failed to propose — nothing to verify. Retry to resume.");
  }

  // Deterministic candidate list from cached proposals (stable across retries).
  const chunkResults = chunks
    .filter((c) => proposalCache.has(c.index))
    .map((c) => ({ clips: proposalCache.get(c.index)!, chunkIndex: c.index, startSec: c.startSec }));
  const rawCandidates = mergeAndRank(chunkResults, mode, null, 1);

  // Collapse overlapping proposals BEFORE verifying — Qwen's liberal/gridded candidates
  // produce many whose padded clips cover the same moment. We only pay Gemini for distinct
  // moments. Keep the highest-confidence one in each overlapping run.
  const mergeGap = PRE_ACTION_PAD + POST_ACTION_PAD;
  const candidates: GeminiClipResult[] = [];
  for (const c of [...rawCandidates].sort((a, b) => a.start_sec - b.start_sec)) {
    const last = candidates[candidates.length - 1];
    if (last && c.start_sec - last.start_sec < mergeGap) {
      if ((c.confidence ?? 0) > (last.confidence ?? 0)) candidates[candidates.length - 1] = c;
    } else {
      candidates.push(c);
    }
  }

  const totalProposed = [...proposalCache.values()].reduce((n, v) => n + v.length, 0);
  console.log(
    `[PV-TUNE] mode=${mode} video_secs=${videoSecs} chunk_sec=${chunkSec} chunk_count=${chunkCount} ` +
    `proposer_parallelism=${parallelism} total_proposals=${totalProposed} after_merge=${rawCandidates.length} ` +
    `verify_candidates=${candidates.length} failed_chunks=${failed.length} ` +
    `modal_wall_secs=${((Date.now() - t0) / 1000).toFixed(1)}`,
  );

  if (candidates.length === 0) {
    await setJobStatus(jobId, { status: "done", clips_total: 0 });
    await setJobMessage(jobId, `No clips found for: "${job.extracted_target}". Try a different action or check that the video contains this type of play.`);
    return;
  }

  // ── Stage B: verify (resumable via pv_verdicts, partial-safe on quota) ───────
  await setJobStatus(jobId, { status: "verifying", clips_total: candidates.length });

  // Pre-seed verdicts already saved — these skip Gemini entirely on a retry.
  const verdicts = new Map<number, Verdict>(
    Object.entries((job.pv_verdicts ?? {}) as Record<string, Verdict>).map(([k, v]) => [Number(k), v]),
  );
  const vPar = config.verifier.parallelism;
  const vStart = Date.now();
  let verifyStopped = false;       // interrupted (quota / rate limit) — resumable
  let billingHit = false;
  await setJobStatus(jobId, { clips_done: verdicts.size });

  const toVerify = candidates
    .map((c, idx) => ({ c, idx }))
    .filter(({ idx }) => !verdicts.has(idx));

  for (let i = 0; i < toVerify.length && !verifyStopped; i += vPar) {
    if (await checkCancelled(jobId)) {
      await setJobStatus(jobId, { pv_verdicts: Object.fromEntries(verdicts) });
      await setJobMessage(jobId, "Job was cancelled during verification.");
      await setJobStatus(jobId, { status: "cancelled" });
      return;
    }
    const batch = toVerify.slice(i, i + vPar);
    const results = await Promise.allSettled(
      batch.map(async ({ c, idx }) => {
        const cutStart = Math.max(0, c.start_sec - config.verifier.preActionPad);
        const cutEnd = Math.min(c.end_sec + config.verifier.postActionPad, videoSecs);
        if (cutEnd <= cutStart) {
          return { idx, verdict: { confirmed: false, confidence: 0, reason: "out of bounds" } as Verdict };
        }
        const vPath = path.join(tmpJobDir, `verify_${idx}.mp4`);
        try {
          await cutClip(sourcePath, cutStart, cutEnd, vPath);
          const res = await verifyClip(vPath, job, cutEnd - cutStart);
          // Audit line: Qwen's intended play+time vs what the verifier actually sees at that
          // cut. If qwen="…" and reason="…" describe different plays, the timestamp is drifting.
          const qwenTitle = (c.title ?? "").replace(/"/g, "'");
          console.log(
            `[PV-VERIFY] idx=${idx} t=${c.start_sec.toFixed(1)}-${c.end_sec.toFixed(1)}s ` +
            `qwen="${qwenTitle}" confirmed=${res.confirmed} conf=${res.confidence.toFixed(2)} ` +
            `reason="${res.reason.replace(/"/g, "'")}"`,
          );
          return { idx, verdict: res };
        } catch (err) {
          // verifyClip only throws on TRUE hard billing — propagate that to stop the job
          // (resumable). Any other error (ffmpeg, etc.) → reject this one clip, keep going.
          if (isHardBillingError(err)) throw err;
          console.warn(`[jobs] verify clip ${idx} errored (reject): ${(err as Error)?.message}`);
          return { idx, verdict: { confirmed: false, confidence: 0, reason: "verify error" } as Verdict };
        } finally {
          await safeUnlink(vPath);
        }
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        verdicts.set(r.value.idx, r.value.verdict);
      } else {
        // The only thing verifyClip rethrows is hard account/billing — genuinely terminal.
        verifyStopped = true;
        billingHit = true;
      }
    }
    // Persist verdicts every batch — a crash/quota never re-verifies these candidates.
    await setJobStatus(jobId, { clips_done: verdicts.size, pv_verdicts: Object.fromEntries(verdicts) });
  }

  // Candidates were already overlap-deduped before verify, so a simple filter here.
  const confirmed = candidates.filter((_, idx) => verdicts.get(idx)?.confirmed);
  const unverified = candidates.length - verdicts.size;

  console.log(
    `[PV-TUNE] verified=${verdicts.size}/${candidates.length} confirmed=${confirmed.length} ` +
    `unverified=${unverified} stopped=${verifyStopped} verify_wall_secs=${((Date.now() - vStart) / 1000).toFixed(1)}`,
  );

  // Interrupted with work still pending → leave a retryable error. chunk_cache +
  // pv_verdicts are persisted, so a retry resumes WITHOUT re-running Modal or
  // re-verifying anything already checked.
  if (verifyStopped && unverified > 0) {
    const msg = billingHit
      ? `Gemini quota exhausted after verifying ${verdicts.size}/${candidates.length} candidate(s) ` +
        `(${confirmed.length} confirmed so far). Your proposals and verifications are saved — ` +
        `retry once quota resets to finish the remaining ${unverified} (this will NOT re-run Qwen).`
      : `Verification was interrupted after ${verdicts.size}/${candidates.length} candidate(s). ` +
        `Progress is saved — retry to resume the remaining ${unverified}.`;
    await setJobMessage(jobId, msg);
    await setJobStatus(jobId, { status: "error", error_message: msg });
    return;
  }

  if (confirmed.length === 0) {
    await setJobStatus(jobId, { status: "done", clips_total: 0 });
    await setJobMessage(jobId, `Candidates were proposed but none could be confirmed as "${job.extracted_target}". Try a more specific request or different footage.`);
    return;
  }

  // All verified → rank, apply clip_limit, finalize.
  let finalClips = confirmed.slice();
  if (mode === "action_extraction") {
    finalClips.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
    if (job.clip_limit) finalClips = finalClips.slice(0, job.clip_limit);
  } else {
    finalClips.sort((a, b) => a.start_sec - b.start_sec);
  }
  finalClips = finalClips.map((c, i) => ({ ...c, rank: i + 1 }));

  const note = failed.length > 0
    ? `\n\nNote: ${failed.length} chunk(s) failed to propose — ${formatTimeRange(failed)} of the video was skipped.`
    : "";

  await finalizeClips(jobId, job, mode, finalClips, sourcePath, tmpJobDir, note);
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

    // Feature flag: proposer-verifier path (Qwen proposes → Gemini verifies).
    // The Gemini-only baseline below is untouched and runs when ANALYSIS_MODE=gemini.
    if (config.analysisMode === "proposer_verifier") {
      await runProposerVerifier(jobId, job, tmpJobDir);
      return;
    }

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

    // ── Steps 5-8: download source, cut, stitch, finalize (shared helper) ─────
    const sourcePath = path.join(tmpJobDir, "source.mp4");
    await downloadFromR2(conv.r2_video_key, sourcePath);

    const failedNote = failedChunks.length > 0
      ? billingErrorMsg !== null
        ? `\n\nNote: Billing quota was exhausted — ${formatTimeRange(failedChunks)} of the video was not analyzed. Clips shown are from the portion that completed.`
        : `\n\nNote: ${failedChunks.length} chunk(s) could not be processed — ${formatTimeRange(failedChunks)} of the original video was skipped.`
      : "";

    await finalizeClips(jobId, job, mode, mergedClips, sourcePath, tmpJobDir, failedNote);
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
