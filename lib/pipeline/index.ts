import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getMediaDurationSec } from "@/lib/ffmpeg";
import { getJob, setJobError, updateJob } from "@/lib/jobs";
import { chunkAudio } from "@/lib/pipeline/chunkAudio";
import { chunkVideo } from "@/lib/pipeline/chunkVideo";
import { cutClipsForHighlights } from "@/lib/pipeline/cutClips";
import { extractAudio } from "@/lib/pipeline/extractAudio";
import { transcribeChunks } from "@/lib/pipeline/transcribe";
import { rankVisualHighlights } from "@/lib/pipeline/visualHighlights";

function getJobWorkingDir(jobId: string): string {
  return path.join(process.cwd(), "tmp", jobId);
}

export async function runPipeline(jobId: string): Promise<void> {
  const job = getJob(jobId);
  if (!job) {
    throw new Error(`Cannot run pipeline. Job not found: ${jobId}`);
  }
  const startedAtMs = Date.now();

  const workingDir = getJobWorkingDir(jobId);
  await mkdir(workingDir, { recursive: true });

  try {
    const currentJob = getJob(jobId);
    const userPrompt = currentJob?.userPrompt;

    updateJob(jobId, {
      stage: "extracting_audio",
      progress: 10,
      message: "Extracting audio with FFmpeg",
    });
    const audioPath = await extractAudio(job.inputPath, workingDir);

    updateJob(jobId, {
      stage: "chunking_audio",
      progress: 25,
      message: "Splitting audio into chunks",
    });
    const chunks = await chunkAudio(audioPath, workingDir);
    if (chunks.length === 0) {
      throw new Error("No audio chunks were produced.");
    }

    updateJob(jobId, {
      stage: "transcribing",
      progress: 45,
      message: "Transcribing audio chunks with Whisper",
    });
    const transcription = await transcribeChunks(chunks);
    const transcript = transcription.transcript;

    const transcriptPath = path.join(workingDir, "transcript.json");
    await writeFile(transcriptPath, JSON.stringify(transcript, null, 2), "utf8");

    updateJob(jobId, {
      stage: "ranking",
      progress: 70,
      message: "Ranking visual highlights with Gemini",
      transcriptPath,
    });

    const videoDurationSec = await getMediaDurationSec(job.inputPath);
    const videoChunks = await chunkVideo(job.inputPath, workingDir);
    const visualRanking = await rankVisualHighlights({
      inputVideoPath: job.inputPath,
      videoChunks,
      transcriptSegments: transcript.segments,
      userPrompt,
      maxDurationSec: videoDurationSec,
    });

    const highlightsPath = path.join(workingDir, "highlights.json");
    await writeFile(highlightsPath, JSON.stringify(visualRanking.highlights, null, 2), "utf8");

    updateJob(jobId, {
      stage: "cutting",
      progress: 85,
      message: "Cutting clips with FFmpeg",
      highlightsPath,
      highlights: visualRanking.highlights,
      effectivePrompt: visualRanking.effectivePrompt,
    });

    const cutClips = await cutClipsForHighlights(job.inputPath, workingDir, visualRanking.highlights);
    const clips = cutClips.map((clip) => ({
      ...clip,
      url: `/api/clip/${jobId}/${clip.id}`,
    }));

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
  }
}
