import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { getCategoryPack } from "@/lib/categories/packs";
import { appConfig } from "@/lib/config";
import { detectScenes } from "@/lib/cv/client";
import { getMediaDurationSec } from "@/lib/ffmpeg";
import { appendPipelineLog, getJob, hydrateJobFromStore, setJobError, updateJob } from "@/lib/jobs";
import { runningJobsGauge, stageCounter } from "@/lib/observability";
import { chunkAudio } from "@/lib/pipeline/chunkAudio";
import { chunkVideo } from "@/lib/pipeline/chunkVideo";
import { cutClipsForHighlights } from "@/lib/pipeline/cutClips";
import { extractAudio } from "@/lib/pipeline/extractAudio";
import { createVisionProxyVideo } from "@/lib/pipeline/proxy";
import { applySceneAwareClipBoundaries } from "@/lib/pipeline/sceneBoundaries";
import { transcribeChunks } from "@/lib/pipeline/transcribe";
import { rankVisualHighlights } from "@/lib/pipeline/visualHighlights";
import { readJsonCache, sha256File, writeJsonCache } from "@/lib/cache";
import { describeGenericFetchTransportHint } from "@/lib/networkErrors";
import { resolvedMaxFinalHighlightsForJob } from "@/lib/highlightCap";
import { isObjectStorageEnabled, promoteCutClipsToDurable, uploadClipToStorage } from "@/lib/storage";

function getJobWorkingDir(jobId: string): string {
  return path.join(process.cwd(), "tmp", jobId);
}

export async function runPipeline(jobId: string): Promise<void> {
  const job = getJob(jobId) ?? (await hydrateJobFromStore(jobId));
  if (!job) {
    throw new Error(`Cannot run pipeline. Job not found: ${jobId}`);
  }
  const startedAtMs = Date.now();
  runningJobsGauge.inc();

  const workingDir = getJobWorkingDir(jobId);
  await mkdir(workingDir, { recursive: true });

  console.info(`[pipeline ${jobId}] started`);
  appendPipelineLog(jobId, {
    level: "info",
    stage: "pipeline",
    message: "Pipeline started",
    detail: job.inputPath,
  });

  try {
    const currentJob = getJob(jobId) ?? (await hydrateJobFromStore(jobId));
    if (!currentJob) {
      throw new Error(`Job lost from memory: ${jobId}`);
    }
    const userPrompt = currentJob.userPrompt;
    const maxH = resolvedMaxFinalHighlightsForJob(currentJob);

    const overrideCategory = (currentJob.category ?? "auto").toString();
    const cacheDigestBase = createHash("sha256")
      .update(
        `${overrideCategory}::${userPrompt ?? "__default__"}::${JSON.stringify(currentJob.playerFocus ?? null)}::${JSON.stringify(currentJob.processingPresets ?? null)}::maxH:${maxH}`,
      )
      .digest("hex")
      .slice(0, 16);

    updateJob(jobId, {
      stage: "extracting_audio",
      progress: 10,
      message: appConfig.pipeline.skipTranscription
        ? "Preparing video (transcription skipped)"
        : "Extracting audio with FFmpeg",
    });
    stageCounter.add(1, { stage: "extracting_audio" });

    const inputHash = await sha256File(job.inputPath);
    updateJob(jobId, { inputHash });
    appendPipelineLog(jobId, {
      level: "info",
      stage: "ingest",
      message: "Computed input SHA-256",
      detail: inputHash.slice(0, 16),
    });

    const cachePromptKey = `highlights-${cacheDigestBase}`;
    const [videoDurationSec, videoChunks] = await Promise.all([
      getMediaDurationSec(job.inputPath),
      chunkVideo(job.inputPath, workingDir),
    ]);
    appendPipelineLog(jobId, {
      level: "info",
      stage: "chunk_video",
      message: "Video chunked for vision",
      detail: `${videoChunks.length} chunks, ${videoDurationSec.toFixed(1)}s`,
    });

    let transcriptionSeconds = 0;
    let transcript: { fullText: string; segments: Array<{ start: number; end: number; text: string }> } = {
      fullText: "",
      segments: [],
    };

    if (!appConfig.pipeline.skipTranscription) {
      const audioPath = await extractAudio(job.inputPath, workingDir);
      appendPipelineLog(jobId, {
        level: "info",
        stage: "extract_audio",
        message: "Extracted audio track",
        detail: audioPath,
      });

      updateJob(jobId, {
        stage: "chunking_audio",
        progress: 25,
        message: "Splitting audio into chunks",
      });
      stageCounter.add(1, { stage: "chunking_audio" });
      const chunks = await chunkAudio(audioPath, workingDir, appConfig.pipeline.audioChunkDurationSec);
      if (chunks.length === 0) {
        throw new Error("No audio chunks were produced.");
      }
      appendPipelineLog(jobId, {
        level: "info",
        stage: "chunk_audio",
        message: "Audio split for Whisper",
        detail: `${chunks.length} chunks`,
      });

      updateJob(jobId, {
        stage: "transcribing",
        progress: 45,
        message: "Transcribing audio chunks with Whisper",
      });
      stageCounter.add(1, { stage: "transcribing" });
      const cachedTranscript = await readJsonCache<{
        fullText: string;
        segments: Array<{ start: number; end: number; text: string }>;
      }>(inputHash, "transcript");

      const transcription = cachedTranscript
        ? {
            transcript: cachedTranscript,
            usage: { transcriptionSeconds: 0 },
          }
        : await transcribeChunks(chunks, jobId);
      transcript = transcription.transcript;
      transcriptionSeconds = transcription.usage.transcriptionSeconds;
      if (!cachedTranscript) {
        await writeJsonCache(inputHash, "transcript", transcript);
      }
      appendPipelineLog(jobId, {
        level: "info",
        stage: "transcribe",
        message: cachedTranscript ? "Loaded cached transcript" : "Whisper transcription complete",
        detail: `${transcript.segments.length} segments`,
      });
    } else {
      appendPipelineLog(jobId, {
        level: "info",
        stage: "transcribe",
        message: "Skipped OpenAI Whisper",
        detail: "SKIP_TRANSCRIPTION=true (visual-first ranking)",
      });
      updateJob(jobId, {
        stage: "transcribing",
        progress: 45,
        message: "Transcription skipped — video-only hints",
      });
      stageCounter.add(1, { stage: "transcribing" });
    }

    const transcriptPath = path.join(workingDir, "transcript.json");
    await writeFile(transcriptPath, JSON.stringify(transcript, null, 2), "utf8");

    appendPipelineLog(jobId, {
      level: "info",
      stage: "vision_proxy",
      message: "Building vision proxy / preview transcode",
    });
    const previewVideoPath = await createVisionProxyVideo(job.inputPath, workingDir);
    appendPipelineLog(jobId, {
      level: "info",
      stage: "vision_proxy",
      message: "Vision proxy ready",
      detail: previewVideoPath,
    });

    updateJob(jobId, {
      stage: "ranking",
      progress: 70,
      message:
        "Ranking with Gemini (large chunks often take several minutes each; Pipeline log advances per chunk)",
      transcriptPath,
    });
    stageCounter.add(1, { stage: "ranking" });

    type RankingCachePayload = {
      highlights: Awaited<ReturnType<typeof rankVisualHighlights>>["highlights"];
      effectivePrompt: string;
      category: Awaited<ReturnType<typeof rankVisualHighlights>>["category"];
    };

    const rankingCacheKey =
      appConfig.pipeline.skipTranscription ? `${cachePromptKey}-notx` : cachePromptKey;
    const cachedRanking = await readJsonCache<RankingCachePayload>(inputHash, rankingCacheKey);

    let visualRanking = cachedRanking
      ? {
          highlights: cachedRanking.highlights,
          effectivePrompt: cachedRanking.effectivePrompt,
          category: cachedRanking.category,
          candidates: [],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            videoSeconds: videoDurationSec,
          },
        }
      : await rankVisualHighlights({
          inputVideoPath: job.inputPath,
          videoChunks,
          transcriptSegments: transcript.segments,
          userPrompt,
          previewVideoPath,
          initialCategory: currentJob.category,
          maxDurationSec: videoDurationSec,
          playerFocus: currentJob.playerFocus,
          maxFinalHighlights: maxH,
          jobId,
        });

    if (!cachedRanking) {
      const payload: RankingCachePayload = {
        highlights: visualRanking.highlights,
        effectivePrompt: visualRanking.effectivePrompt,
        category: visualRanking.category,
      };
      await writeJsonCache(inputHash, rankingCacheKey, payload);
    }
    appendPipelineLog(jobId, {
      level: "info",
      stage: "rank",
      message: cachedRanking ? "Loaded cached ranking" : "Gemini highlight ranking complete",
      detail: `${visualRanking.highlights.length} highlights`,
    });

    appendPipelineLog(jobId, { level: "info", stage: "cv", message: "Detecting scene boundaries" });
    const categoryPack = getCategoryPack(visualRanking.category);
    const sceneBoundaries = await detectScenes(job.inputPath);
    appendPipelineLog(jobId, {
      level: "info",
      stage: "cv",
      message: "Scene detection complete",
      detail: `${sceneBoundaries.length} boundaries`,
    });

    visualRanking = {
      ...visualRanking,
      highlights: applySceneAwareClipBoundaries(visualRanking.highlights, sceneBoundaries, {
        prePadSec: categoryPack.prePadSec,
        postPadSec: categoryPack.postPadSec,
        maxDurationSec: videoDurationSec,
      }),
    };

    const highlightsPath = path.join(workingDir, "highlights.json");
    await writeFile(highlightsPath, JSON.stringify(visualRanking.highlights, null, 2), "utf8");
    const candidatesPath = path.join(workingDir, "candidates.json");
    await writeFile(candidatesPath, JSON.stringify(visualRanking.candidates, null, 2), "utf8");

    updateJob(jobId, {
      stage: "cutting",
      progress: 85,
      message: "Cutting clips with FFmpeg",
      highlightsPath,
      candidatesPath,
      highlights: visualRanking.highlights,
      effectivePrompt: visualRanking.effectivePrompt,
      category: visualRanking.category,
    });
    stageCounter.add(1, { stage: "cutting" });

    const cutClips = await cutClipsForHighlights(job.inputPath, workingDir, visualRanking.highlights);
    appendPipelineLog(jobId, {
      level: "info",
      stage: "cut",
      message: "FFmpeg cut pass complete",
      detail: `${cutClips.length} files in tmp`,
    });

    const promoted = await promoteCutClipsToDurable(jobId, cutClips);
    appendPipelineLog(jobId, {
      level: "info",
      stage: "storage",
      message: "Copied clips to durable media dir",
      detail: appConfig.storage.dataDir,
    });

    const clips = await Promise.all(
      promoted.map(async (clip) => {
        const uploaded = await uploadClipToStorage(jobId, clip.id, clip.path);
        return {
          ...clip,
          url: uploaded.url,
          ...(uploaded.storageClipKey ? { storageClipKey: uploaded.storageClipKey } : {}),
        };
      }),
    );
    appendPipelineLog(jobId, {
      level: "info",
      stage: "storage",
      message: isObjectStorageEnabled() ? "Uploaded clips to object storage" : "Clips served via /api/clip",
    });

    if (visualRanking.usage.totalTokens > appConfig.pipeline.budgetMaxTotalTokens) {
      throw new Error(
        `Job exceeded token budget: ${visualRanking.usage.totalTokens} > ${appConfig.pipeline.budgetMaxTotalTokens}`,
      );
    }

    updateJob(jobId, {
      stage: "done",
      progress: 100,
      message: "Highlight clips generated",
      clips,
      metrics: {
        ...getJob(jobId)!.metrics,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        ai: {
          openai: {
            transcriptionSeconds: transcriptionSeconds,
          },
          gemini: {
            inputTokens: visualRanking.usage.inputTokens,
            outputTokens: visualRanking.usage.outputTokens,
            totalTokens: visualRanking.usage.totalTokens,
            videoSeconds: visualRanking.usage.videoSeconds,
          },
          totalTokens: visualRanking.usage.totalTokens,
        },
        costUsdEstimate: Number((visualRanking.usage.totalTokens * 0.000002).toFixed(4)),
      },
    });
    appendPipelineLog(jobId, {
      level: "info",
      stage: "pipeline",
      message: "Pipeline finished",
      detail: `${clips.length} clips`,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    appendPipelineLog(jobId, { level: "error", stage: "pipeline", message: "Pipeline failed", detail: msg });
    updateJob(jobId, {
      metrics: {
        ...getJob(jobId)!.metrics,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
      },
    });
    const hint = describeGenericFetchTransportHint(error);
    const persistedError =
      hint && error instanceof Error ? new Error(`${error.message} ${hint}`, { cause: error }) : error;
    setJobError(jobId, persistedError);
    throw error;
  } finally {
    runningJobsGauge.dec();
  }
}
