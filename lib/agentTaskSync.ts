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

  const detail = job.stage === "error" && job.error ? `${job.message}: ${job.error}` : job.message;

  const upsert = async (params: {
    id: string;
    type: "upload" | "transcribe" | "rank" | "cut";
    status: "pending" | "running" | "done" | "error";
    progress: number;
    label: string;
  }) => {
    await upsertAgentTask({
      id: params.id,
      conversationId,
      jobId,
      type: params.type,
      status: params.status,
      progress: params.progress,
      label: params.label,
      detail,
    }).catch((error) => {
      console.warn("[agentTaskSync] upsert failed", error);
    });
  };

  // Upload is immediate once the multipart lands — keep as done for visibility.
  await upsert({
    id: `${jobId}-upload`,
    type: "upload",
    status: job.stage === "error" ? "error" : "done",
    progress: job.stage === "error" ? 100 : 100,
    label: "Receive video",
  });

  const stage = job.stage as JobStage;

  if (stage === "queued") {
    await upsert({
      id: `${jobId}-transcribe`,
      type: "transcribe",
      status: "pending",
      progress: 0,
      label: "Transcribe audio",
    });
    await upsert({
      id: `${jobId}-rank`,
      type: "rank",
      status: "pending",
      progress: 0,
      label: "Find highlights",
    });
    await upsert({
      id: `${jobId}-cut`,
      type: "cut",
      status: "pending",
      progress: 0,
      label: "Cut clips",
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
    });
    await upsert({
      id: `${jobId}-rank`,
      type: "rank",
      status: "pending",
      progress: 0,
      label: "Find highlights",
    });
    await upsert({
      id: `${jobId}-cut`,
      type: "cut",
      status: "pending",
      progress: 0,
      label: "Cut clips",
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
    });
    await upsert({
      id: `${jobId}-rank`,
      type: "rank",
      status: "running",
      progress: job.progress,
      label: "Find highlights",
    });
    await upsert({
      id: `${jobId}-cut`,
      type: "cut",
      status: "pending",
      progress: 0,
      label: "Cut clips",
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
    });
    await upsert({
      id: `${jobId}-rank`,
      type: "rank",
      status: "done",
      progress: 100,
      label: "Find highlights",
    });
    await upsert({
      id: `${jobId}-cut`,
      type: "cut",
      status: "running",
      progress: job.progress,
      label: "Cut clips",
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
    });
    await upsert({
      id: `${jobId}-rank`,
      type: "rank",
      status: "done",
      progress: 100,
      label: "Find highlights",
    });
    await upsert({
      id: `${jobId}-cut`,
      type: "cut",
      status: "done",
      progress: 100,
      label: "Cut clips",
    });
    return;
  }

  if (stage === "error") {
    const at = job.failedAtStage ?? "queued";

    if (at === "extracting_audio" || at === "chunking_audio" || at === "transcribing" || at === "queued") {
      await upsert({
        id: `${jobId}-transcribe`,
        type: "transcribe",
        status: "error",
        progress: job.progress,
        label: "Transcribe audio",
      });
      await upsert({
        id: `${jobId}-rank`,
        type: "rank",
        status: "pending",
        progress: 0,
        label: "Find highlights",
      });
      await upsert({
        id: `${jobId}-cut`,
        type: "cut",
        status: "pending",
        progress: 0,
        label: "Cut clips",
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
      });
      await upsert({
        id: `${jobId}-rank`,
        type: "rank",
        status: "error",
        progress: job.progress,
        label: "Find highlights",
      });
      await upsert({
        id: `${jobId}-cut`,
        type: "cut",
        status: "pending",
        progress: 0,
        label: "Cut clips",
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
      });
      await upsert({
        id: `${jobId}-rank`,
        type: "rank",
        status: "done",
        progress: 100,
        label: "Find highlights",
      });
      await upsert({
        id: `${jobId}-cut`,
        type: "cut",
        status: "error",
        progress: job.progress,
        label: "Cut clips",
      });
    }
  }
}
