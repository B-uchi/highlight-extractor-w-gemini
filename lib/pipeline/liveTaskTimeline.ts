import type { AgentTaskRecord, AgentTaskStatus, JobState } from "@/lib/types";

/** Build timeline rows purely from pipeline state while this job streams over SSE */
export function derivePipelineTasksFromJob(job: JobState): AgentTaskRecord[] {
  const jid = job.id;
  const stage = job.stage;
  const atFail = stage === "error" ? job.failedAtStage : undefined;

  let uploadStatus: AgentTaskStatus = "done";
  let uploadProg = 100;
  let uploadDetail: string | null = "Uploaded and queued for pipeline";

  let transcribeStatus: AgentTaskStatus = "pending";
  let transcribeProg = 0;
  let transcribeDetail: string | null = "Waiting for worker…";

  let rankStatus: AgentTaskStatus = "pending";
  let rankProg = 0;
  let rankDetail: string | null = "Starts after Whisper returns";

  let cutStatus: AgentTaskStatus = "pending";
  let cutProg = 0;
  let cutDetail: string | null = "Starts after ranking";

  if (stage === "queued") {
    transcribeDetail = "Waiting for worker…";
  } else if (stage === "extracting_audio" || stage === "chunking_audio" || stage === "transcribing") {
    transcribeStatus = "running";
    transcribeProg = Math.max(job.progress, 15);
    transcribeDetail =
      stage === "transcribing"
        ? `${job.message} — Whisper runs in the BullMQ worker; long uploads can take many minutes; watch stdout for “[pipeline …] Whisper chunk”.`
        : job.message || "Preparing audio for Whisper…";
  } else if (stage === "ranking") {
    transcribeStatus = "done";
    transcribeProg = 100;
    transcribeDetail = "Transcription finished";
    rankStatus = "running";
    rankProg = Math.max(job.progress, 65);
    rankDetail =
      job.message ??
      "Ranking with Gemini — token counts appear after ranking completes; open Pipeline log for per-chunk progress.";
  } else if (stage === "cutting") {
    transcribeStatus = "done";
    transcribeProg = 100;
    transcribeDetail = "Transcription finished";
    rankStatus = "done";
    rankProg = 100;
    rankDetail = "Highlight ranking complete";
    cutStatus = "running";
    cutProg = Math.max(job.progress, 85);
    cutDetail = job.message || "Cutting clips with FFmpeg…";
  } else if (stage === "done") {
    transcribeStatus = rankStatus = cutStatus = "done";
    transcribeProg = rankProg = cutProg = 100;
    transcribeDetail = "Transcription finished";
    rankDetail = "Highlight ranking complete";
    cutDetail = "All clips exported";
  } else if (stage === "error") {
    const failed = atFail ?? "queued";

    if (failed === "queued") {
      uploadStatus = "error";
      uploadProg = job.progress;
      uploadDetail = job.error ?? job.message;
      transcribeStatus = "pending";
      transcribeDetail = "Did not start";
      rankDetail = cutDetail = "Upstream failure";
    } else if (failed === "extracting_audio" || failed === "chunking_audio" || failed === "transcribing") {
      transcribeStatus = "error";
      transcribeProg = Math.max(job.progress, 25);
      transcribeDetail = job.error ?? job.message;
      rankDetail = cutDetail = "Blocked by transcription failure";
    } else if (failed === "ranking") {
      transcribeStatus = "done";
      transcribeProg = 100;
      transcribeDetail = "Transcription finished";
      rankStatus = "error";
      rankProg = job.progress;
      rankDetail = job.error ?? job.message;
      cutDetail = "Blocked by ranking failure";
    } else if (failed === "cutting") {
      transcribeStatus = "done";
      transcribeProg = 100;
      transcribeDetail = "Transcription finished";
      rankStatus = "done";
      rankProg = 100;
      rankDetail = "Highlight ranking finished before cut failed";
      cutStatus = "error";
      cutProg = job.progress;
      cutDetail = job.error ?? job.message;
    } else {
      transcribeStatus = "done";
      transcribeProg = 100;
      transcribeDetail = "Transcription finished";
      rankStatus = "done";
      rankProg = 100;
      rankDetail = "Ranking finished";
      cutStatus = "error";
      cutProg = job.progress;
      cutDetail = job.error ?? job.message;
    }
  }

  return [
    {
      id: `${jid}-upload`,
      conversationId: job.conversationId ?? "",
      jobId: jid,
      type: "upload",
      label: "Receive video",
      status: uploadStatus,
      progress: uploadProg,
      detail: uploadDetail,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    },
    {
      id: `${jid}-transcribe`,
      conversationId: job.conversationId ?? "",
      jobId: jid,
      type: "transcribe",
      label: "Transcribe audio",
      status: transcribeStatus,
      progress: transcribeProg,
      detail: transcribeDetail,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    },
    {
      id: `${jid}-rank`,
      conversationId: job.conversationId ?? "",
      jobId: jid,
      type: "rank",
      label: "Find highlights",
      status: rankStatus,
      progress: rankProg,
      detail: rankDetail,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    },
    {
      id: `${jid}-cut`,
      conversationId: job.conversationId ?? "",
      jobId: jid,
      type: "cut",
      label: "Cut clips",
      status: cutStatus,
      progress: cutProg,
      detail: cutDetail,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    },
  ];
}
