import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { getCategoryPack } from "@/lib/categories/packs";
import { appConfig } from "@/lib/config";
import { detectScenes } from "@/lib/cv/client";
import { getMediaDurationSec } from "@/lib/ffmpeg";
import { getJob, hydrateJobFromStore, setJobError, updateJob } from "@/lib/jobs";
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
import { uploadClipToStorage } from "@/lib/storage";

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

  try {
    const currentJob = getJob(jobId) ?? (await hydrateJobFromStore(jobId));
    const userPrompt = currentJob?.userPrompt;

    updateJob(jobId, {
      stage: "extracting_audio",
      progress: 10,
      message: "Extracting audio with FFmpeg",
    });
    stageCounter.add(1, { stage: "extracting_audio" });

    const inputHash = await sha256File(job.inputPath);
    updateJob(jobId, { inputHash });
    const overrideCategory = (currentJob?.category ?? "auto").toString();
    const cacheDigest = createHash("sha256")
      .update(
        `${overrideCategory}::${userPrompt ?? "__default__"}::${JSON.stringify(currentJob?.playerFocus ?? null)}::${JSON.stringify(currentJob?.processingPresets ?? null)}`,
      )
      .digest("hex")
      .slice(0, 16);
    const cachePromptKey = `highlights-${cacheDigest}`;

    const [videoDurationSec, videoChunks, audioPath] = await Promise.all([
      getMediaDurationSec(job.inputPath),
      chunkVideo(job.inputPath, workingDir),
      extractAudio(job.inputPath, workingDir),
    ]);

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

    updateJob(jobId, {
      stage: "transcribing",
      progress: 45,
      message: "Transcribing audio chunks with Whisper",
    });
    stageCounter.add(1, { stage: "transcribing" });
    const cachedTranscript = await readJsonCache<{ fullText: string; segments: Array<{ start: number; end: number; text: string }> }>(
      inputHash,
      "transcript",
    );
    const transcription = cachedTranscript
      ? {
          transcript: cachedTranscript,
          usage: { transcriptionSeconds: 0 },
        }
      : await transcribeChunks(chunks);
    const transcript = transcription.transcript;
    if (!cachedTranscript) {
      await writeJsonCache(inputHash, "transcript", transcript);
    }

    const transcriptPath = path.join(workingDir, "transcript.json");
    await writeFile(transcriptPath, JSON.stringify(transcript, null, 2), "utf8");
    const previewVideoPath = await createVisionProxyVideo(job.inputPath, workingDir);

    updateJob(jobId, {
      stage: "ranking",
      progress: 70,
      message: "Ranking visual highlights with Gemini",
      transcriptPath,
    });
    stageCounter.add(1, { stage: "ranking" });

    type RankingCachePayload = {
      highlights: Awaited<ReturnType<typeof rankVisualHighlights>>["highlights"];
      effectivePrompt: string;
      category: Awaited<ReturnType<typeof rankVisualHighlights>>["category"];
    };

    const cachedRanking = await readJsonCache<RankingCachePayload>(inputHash, cachePromptKey);
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
          initialCategory: currentJob?.category,
          maxDurationSec: videoDurationSec,
          playerFocus: currentJob?.playerFocus,
        });

    if (!cachedRanking) {
      const payload: RankingCachePayload = {
        highlights: visualRanking.highlights,
        effectivePrompt: visualRanking.effectivePrompt,
        category: visualRanking.category,
      };
      await writeJsonCache(inputHash, cachePromptKey, payload);
    }

    const categoryPack = getCategoryPack(visualRanking.category);
    const sceneBoundaries = await detectScenes(job.inputPath);
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
    const clips = await Promise.all(
      cutClips.map(async (clip) => ({
        ...clip,
        url: await uploadClipToStorage(jobId, clip.id, clip.path),
      })),
    );

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
            transcriptionSeconds: transcription.usage.transcriptionSeconds,
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
  } catch (error) {
    updateJob(jobId, {
      metrics: {
        ...getJob(jobId)!.metrics,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
      },
    });
    setJobError(jobId, error);
    throw error;
  } finally {
    runningJobsGauge.dec();
  }
}
