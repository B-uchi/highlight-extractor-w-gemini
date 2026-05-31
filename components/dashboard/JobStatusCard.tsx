"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, CheckCircle, XCircle, Ban } from "lucide-react";

import type { Clip, Job } from "@/lib/types";

interface JobStatusCardProps {
  jobId: string;
  onSettled: (job: Job, clips: Clip[]) => void;
}

const TERMINAL: Job["status"][] = ["done", "error", "unsupported"];

function statusLabel(job: Job): string {
  switch (job.status) {
    case "pending": return "Queued...";
    case "extracting_target": return "Reading your prompt...";
    case "analyzing":
      return job.clips_total == null
        ? "Analyzing video..."
        : `Analyzing video (chunk by chunk)...`;
    case "extracting_clips":
      return `Cutting clips (${job.clips_done}/${job.clips_total ?? "?"})...`;
    case "stitching": return "Stitching highlight reel...";
    case "done": return `Done`;
    case "error": return "Failed";
    case "unsupported": return "Action not supported";
    default: return job.status;
  }
}

const STEPS: { status: Job["status"]; label: string }[] = [
  { status: "extracting_target", label: "Extracting action from prompt" },
  { status: "analyzing", label: "Analyzing video" },
  { status: "extracting_clips", label: "Cutting clips" },
  { status: "stitching", label: "Stitching highlight reel" },
];

function isCompilation(mode: Job["mode"]) {
  return mode === "highlight_compilation_individual" || mode === "highlight_compilation_team";
}

export function JobStatusCard({ jobId, onSettled }: JobStatusCardProps) {
  const [job, setJob] = useState<Job | null>(null);
  const settled = useRef(false);

  useEffect(() => {
    if (settled.current) return;
    let cancelled = false;

    async function poll() {
      while (!cancelled && !settled.current) {
        try {
          const res = await fetch(`/api/jobs/${jobId}`);
          if (res.ok) {
            const data = await res.json() as { job: Job; clips: Clip[] };
            setJob(data.job);
            if (TERMINAL.includes(data.job.status)) {
              settled.current = true;
              onSettled(data.job, data.clips);
              return;
            }
          }
        } catch {
          // ignore transient errors
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    void poll();
    return () => { cancelled = true; };
  }, [jobId, onSettled]);

  if (!job) {
    return (
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>Starting...</span>
      </div>
    );
  }

  const showStitch = isCompilation(job.mode);
  const steps = STEPS.filter((s) => {
    if (s.status === "stitching" && !showStitch) return false;
    return true;
  });

  const currentStepIndex = steps.findIndex((s) => s.status === job.status);
  const isDone = job.status === "done";
  const isError = job.status === "error";
  const isUnsupported = job.status === "unsupported";

  if (isError) {
    return (
      <div className="flex items-start gap-2 rounded-xl bg-red-950/30 px-3 py-2.5 ring-1 ring-red-900/40">
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
        <div>
          <p className="text-xs font-medium text-red-300">Processing failed</p>
          {job.error_message && (
            <p className="mt-0.5 text-xs text-zinc-500">{job.error_message}</p>
          )}
        </div>
      </div>
    );
  }

  if (isUnsupported) {
    return (
      <div className="flex items-start gap-2 rounded-xl bg-zinc-900 px-3 py-2.5 ring-1 ring-zinc-800">
        <Ban className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
        <p className="text-xs text-zinc-400">
          Action not supported — I can only extract video clips. Try asking for specific plays like
          dunks, blocks, assists, or player highlights.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-zinc-900/60 px-3 py-3 ring-1 ring-zinc-800/60 space-y-2">
      <div className="flex items-center gap-2">
        {isDone ? (
          <CheckCircle className="h-4 w-4 text-green-400 shrink-0" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-blue-400 shrink-0" />
        )}
        <span className="text-xs font-medium text-zinc-200">{statusLabel(job)}</span>
      </div>

      <div className="space-y-1 pl-6">
        {steps.map((step, i) => {
          const isCurrent = step.status === job.status;
          const isPast = isDone || i < currentStepIndex;
          const isFuture = !isDone && i > currentStepIndex;

          let label = step.label;
          if (step.status === "extracting_clips" && job.clips_total != null) {
            label = `${step.label} (${job.clips_done}/${job.clips_total})`;
          }

          return (
            <div key={step.status} className={`flex items-center gap-1.5 text-[11px] ${isFuture ? "text-zinc-700" : isPast ? "text-green-500" : "text-zinc-300"}`}>
              <span>{isPast ? "✓" : isCurrent ? "●" : "○"}</span>
              <span>{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
