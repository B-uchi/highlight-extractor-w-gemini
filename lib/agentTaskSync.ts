import { isDatabaseEnabled } from "@/lib/db";
import { upsertAgentTask } from "@/lib/conversations";
import type { JobStage, JobState } from "@/lib/types";

/**
 * Keeps agent_tasks rows in sync with pipeline JobStage for dashboard task timeline.
 */
export async function syncAgentTasksFromJobState(job: JobState): Promise<void> {
  if (!job.conversationId || !isDatabaseEnabled()) {
    return;
  }

  const conversationId = job.conversationId;
  const jobId = job.id;
  const stage = job.stage as JobStage;

  const errorLine = stage === "error" && job.error ? `${job.message}: ${job.error}` : job.message;

  const transcribePrepDetail = (): string =>
    stage === "extracting_audio"
      ? "Extracting audio with FFmpeg"
      : stage === "chunking_audio"
        ? "Splitting audio into chunks"
        : stage === "transcribing"
          ? "Calling OpenAI Whisper (long uploads can take many minutes)."
          : "Preparing transcription";

  const upsert = async (params: {
    id: string;
    type: "upload" | "transcribe" | "rank" | "cut";
    status: "pending" | "running" | "done" | "error";
    progress: number;
    label: string;
    detail: string | null;
  }) => {
    await upsertAgentTask({
      id: params.id,
      conversationId,
      jobId,
      type: params.type,
      status: params.status,
      progress: params.progress,
      label: params.label,
      detail: params.detail,
    }).catch((error) => {
      console.warn("[agentTaskSync] upsert failed", error);
    });
  };

  // Upload row
  await upsert({
    id: `${jobId}-upload`,
    type: "upload",
    status: stage === "error" && (job.failedAtStage ?? "") === "queued" ? "error" : "done",
    progress: 100,
    label: "Receive video",
    detail: stage === "error" && (job.failedAtStage ?? "") === "queued" ? errorLine : "Uploaded and queued for pipeline",
  });

  if (stage === "queued") {
    await upsert({
      id: `${jobId}-transcribe`,
      type: "transcribe",
      status: "pending",
      progress: 0,
      label: "Transcribe audio",
      detail: "Waiting for pipeline…",
    });
    await upsert({
      id: `${jobId}-rank`,
      type: "rank",
      status: "pending",
      progress: 0,
      label: "Find highlights",
      detail: "Starts after Whisper",
    });
    await upsert({
      id: `${jobId}-cut`,
      type: "cut",
      status: "pending",
      progress: 0,
      label: "Cut clips",
      detail: "Starts after ranking",
    });
    return;
  }

  if (stage === "extracting_audio" || stage === "chunking_audio" || stage === "transcribing") {
    await upsert({
      id: `${jobId}-transcribe`,
      type: "transcribe",
      status: "running",
      progress: job.progress,
      label: "Transcribe audio",
      detail: transcribePrepDetail(),
    });
    await upsert({
      id: `${jobId}-rank`,
      type: "rank",
      status: "pending",
      progress: 0,
      label: "Find highlights",
      detail: "Starts after Whisper",
    });
    await upsert({
      id: `${jobId}-cut`,
      type: "cut",
      status: "pending",
      progress: 0,
      label: "Cut clips",
      detail: "Starts after ranking",
    });
    return;
  }

  if (stage === "ranking") {
    await upsert({
      id: `${jobId}-transcribe`,
      type: "transcribe",
      status: "done",
      progress: 100,
      label: "Transcribe audio",
      detail: "Transcription finished",
    });
    await upsert({
      id: `${jobId}-rank`,
      type: "rank",
      status: "running",
      progress: job.progress,
      label: "Find highlights",
      detail: job.message,
    });
    await upsert({
      id: `${jobId}-cut`,
      type: "cut",
      status: "pending",
      progress: 0,
      label: "Cut clips",
      detail: "Starts after ranking",
    });
    return;
  }

  if (stage === "cutting") {
    await upsert({
      id: `${jobId}-transcribe`,
      type: "transcribe",
      status: "done",
      progress: 100,
      label: "Transcribe audio",
      detail: "Transcription finished",
    });
    await upsert({
      id: `${jobId}-rank`,
      type: "rank",
      status: "done",
      progress: 100,
      label: "Find highlights",
      detail: "Highlight ranking complete",
    });
    await upsert({
      id: `${jobId}-cut`,
      type: "cut",
      status: "running",
      progress: job.progress,
      label: "Cut clips",
      detail: job.message,
    });
    return;
  }

  if (stage === "done") {
    await upsert({
      id: `${jobId}-transcribe`,
      type: "transcribe",
      status: "done",
      progress: 100,
      label: "Transcribe audio",
      detail: "Transcription finished",
    });
    await upsert({
      id: `${jobId}-rank`,
      type: "rank",
      status: "done",
      progress: 100,
      label: "Find highlights",
      detail: "Highlight ranking complete",
    });
    await upsert({
      id: `${jobId}-cut`,
      type: "cut",
      status: "done",
      progress: 100,
      label: "Cut clips",
      detail: "Clips exported",
    });
    return;
  }

  if (stage === "error") {
    const at = job.failedAtStage ?? "queued";

    if (at === "queued") {
      await upsert({
        id: `${jobId}-transcribe`,
        type: "transcribe",
        status: "pending",
        progress: 0,
        label: "Transcribe audio",
        detail: "Pipeline failed before preprocessing",
      });
      await upsert({
        id: `${jobId}-rank`,
        type: "rank",
        status: "pending",
        progress: 0,
        label: "Find highlights",
        detail: "Did not run",
      });
      await upsert({
        id: `${jobId}-cut`,
        type: "cut",
        status: "pending",
        progress: 0,
        label: "Cut clips",
        detail: "Did not run",
      });
      return;
    }

    if (at === "extracting_audio" || at === "chunking_audio" || at === "transcribing") {
      await upsert({
        id: `${jobId}-transcribe`,
        type: "transcribe",
        status: "error",
        progress: job.progress,
        label: "Transcribe audio",
        detail: errorLine,
      });
      await upsert({
        id: `${jobId}-rank`,
        type: "rank",
        status: "pending",
        progress: 0,
        label: "Find highlights",
        detail: "Blocked by transcription error",
      });
      await upsert({
        id: `${jobId}-cut`,
        type: "cut",
        status: "pending",
        progress: 0,
        label: "Cut clips",
        detail: "Blocked by transcription error",
      });
      return;
    }

    if (at === "ranking") {
      await upsert({
        id: `${jobId}-transcribe`,
        type: "transcribe",
        status: "done",
        progress: 100,
        label: "Transcribe audio",
        detail: "Transcription finished",
      });
      await upsert({
        id: `${jobId}-rank`,
        type: "rank",
        status: "error",
        progress: job.progress,
        label: "Find highlights",
        detail: errorLine,
      });
      await upsert({
        id: `${jobId}-cut`,
        type: "cut",
        status: "pending",
        progress: 0,
        label: "Cut clips",
        detail: "Blocked by ranking error",
      });
      return;
    }

    if (at === "cutting") {
      await upsert({
        id: `${jobId}-transcribe`,
        type: "transcribe",
        status: "done",
        progress: 100,
        label: "Transcribe audio",
        detail: "Transcription finished",
      });
      await upsert({
        id: `${jobId}-rank`,
        type: "rank",
        status: "done",
        progress: 100,
        label: "Find highlights",
        detail: "Highlight ranking complete",
      });
      await upsert({
        id: `${jobId}-cut`,
        type: "cut",
        status: "error",
        progress: job.progress,
        label: "Cut clips",
        detail: errorLine,
      });
    }
  }
}
