import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getCategoryPack } from "@/lib/categories/packs";
import { appConfig } from "@/lib/config";
import { detectScenes } from "@/lib/cv/client";
import { getMediaDurationSec } from "@/lib/ffmpeg";
import { getJob, hydrateJobFromStore, setJobError, updateJob } from "@/lib/jobs";
import { chunkVideo } from "@/lib/pipeline/chunkVideo";
import { cutClipsForHighlights } from "@/lib/pipeline/cutClips";
import { createVisionProxyVideo } from "@/lib/pipeline/proxy";
import { applySceneAwareClipBoundaries } from "@/lib/pipeline/sceneBoundaries";
import { rankVisualHighlights } from "@/lib/pipeline/visualHighlights";
import { uploadClipToStorage } from "@/lib/storage";
import { isDatabaseEnabled } from "@/lib/db";
import { upsertAgentTask } from "@/lib/conversations";
import type { JobState, TranscriptResult } from "@/lib/types";

function getWorkingDir(jobId: string): string {
  return path.join(process.cwd(), "tmp", jobId);
}

/**
 * Re-runs visual ranking + clip cutting using the existing transcript on disk.
 */
export async function runRefineHighlights(jobId: string, newUserPrompt: string): Promise<void> {
  const job = getJob(jobId) ?? (await hydrateJobFromStore(jobId));
  if (!job) {
    throw new Error(`Job not found: ${jobId}`);
  }
  if (!job.transcriptPath) {
    throw new Error("Cannot refine highlights: transcript is missing. Run the full pipeline first.");
  }

  const transcriptJson = await readFile(job.transcriptPath, "utf8");
  const transcript = JSON.parse(transcriptJson) as TranscriptResult;
  const workingDir = getWorkingDir(jobId);
  const startedAtMs = Date.now();

  try {
    if (job.conversationId && isDatabaseEnabled()) {
      await upsertAgentTask({
        id: `${jobId}-refine`,
        conversationId: job.conversationId,
        jobId,
        type: "refine",
        status: "running",
        progress: 10,
        label: "Refine highlights",
        detail: newUserPrompt,
      });
    }

    updateJob(jobId, {
      userPrompt: newUserPrompt,
      stage: "ranking",
      progress: 70,
      message: "Re-ranking highlights",
    });

    const videoDurationSec = await getMediaDurationSec(job.inputPath);
    const videoChunks = await chunkVideo(job.inputPath, workingDir);
    const previewVideoPath = await createVisionProxyVideo(job.inputPath, workingDir);

    const visualRanking = await rankVisualHighlights({
      inputVideoPath: job.inputPath,
      videoChunks,
      transcriptSegments: transcript.segments,
      userPrompt: newUserPrompt,
      previewVideoPath,
      initialCategory: job.category,
      maxDurationSec: videoDurationSec,
      playerFocus: job.playerFocus,
    });

    if (visualRanking.usage.totalTokens > appConfig.pipeline.budgetMaxTotalTokens) {
      throw new Error(
        `Job exceeded token budget: ${visualRanking.usage.totalTokens} > ${appConfig.pipeline.budgetMaxTotalTokens}`,
      );
    }

    const categoryPack = getCategoryPack(visualRanking.category);
    const sceneBoundaries = await detectScenes(job.inputPath);
    const adjusted = applySceneAwareClipBoundaries(visualRanking.highlights, sceneBoundaries, {
      prePadSec: categoryPack.prePadSec,
      postPadSec: categoryPack.postPadSec,
      maxDurationSec: videoDurationSec,
    });

    const highlightsPath = path.join(workingDir, "highlights.json");
    const candidatesPath = path.join(workingDir, "candidates.json");
    await writeFile(highlightsPath, JSON.stringify(adjusted, null, 2), "utf8");
    await writeFile(candidatesPath, JSON.stringify(visualRanking.candidates, null, 2), "utf8");

    updateJob(jobId, {
      stage: "cutting",
      progress: 85,
      message: "Re-cutting clips",
      highlightsPath,
      candidatesPath,
      highlights: adjusted,
      effectivePrompt: visualRanking.effectivePrompt,
      category: visualRanking.category,
    });

    const cutClips = await cutClipsForHighlights(job.inputPath, workingDir, adjusted);
    const clips = await Promise.all(
      cutClips.map(async (clip) => ({
        ...clip,
        url: await uploadClipToStorage(jobId, clip.id, clip.path),
      })),
    );

    const prev = getJob(jobId) ?? (await hydrateJobFromStore(jobId));
    const baseMetrics = prev?.metrics ?? job.metrics;

    if (job.conversationId && isDatabaseEnabled()) {
      await upsertAgentTask({
        id: `${jobId}-refine`,
        conversationId: job.conversationId,
        jobId,
        type: "refine",
        status: "done",
        progress: 100,
        label: "Refine highlights",
        detail: "Updated clips ready",
      });
    }

    updateJob(jobId, {
      stage: "done",
      progress: 100,
      message: "Highlight clips updated",
      clips,
      metrics: {
        ...baseMetrics,
        finishedAt: new Date().toISOString(),
        durationMs: (baseMetrics.durationMs ?? 0) + (Date.now() - startedAtMs),
        ai: {
          openai: baseMetrics.ai.openai,
          gemini: {
            inputTokens:
              baseMetrics.ai.gemini.inputTokens + (visualRanking.usage.inputTokens ?? 0),
            outputTokens:
              baseMetrics.ai.gemini.outputTokens + (visualRanking.usage.outputTokens ?? 0),
            totalTokens:
              baseMetrics.ai.gemini.totalTokens + (visualRanking.usage.totalTokens ?? 0),
            videoSeconds:
              baseMetrics.ai.gemini.videoSeconds + (visualRanking.usage.videoSeconds ?? 0),
          },
          totalTokens: baseMetrics.ai.totalTokens + visualRanking.usage.totalTokens,
        },
        costUsdEstimate: Number(
          ((baseMetrics.ai.totalTokens + visualRanking.usage.totalTokens) * 0.000002).toFixed(4),
        ),
      },
    });
  } catch (error) {
    setJobError(jobId, error);
    throw error;
  }
}

/** Compact snapshot for the LLM (tool context). */
export function summarizeJobForAgent(job: JobState): Record<string, unknown> {
  return {
    id: job.id,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    error: job.error,
    category: job.category,
    highlightCount: job.highlights?.length ?? 0,
    clipCount: job.clips?.length ?? 0,
    clipIds: job.clips?.map((c) => ({ id: c.id, title: c.title, score: c.score })) ?? [],
    userPrompt: job.userPrompt,
    playerFocus: job.playerFocus,
    processingPresets: job.processingPresets ?? null,
  };
}
