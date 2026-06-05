"use client";

import { useEffect, useRef, useState } from "react";
import { Upload, CheckCircle, AlertCircle, Loader2, Check } from "lucide-react";

import { getBrowserClient } from "@/lib/supabase";
import type { Conversation } from "@/lib/types";

// The `step` values the backend worker stamps on the job row as each stage begins.
// Order here determines the visual sequence.
type JobStep = "downloading" | "transcoding" | "uploading" | "done" | null;

const STEPS: { key: NonNullable<Exclude<JobStep, "done">>; label: string }[] = [
  { key: "downloading", label: "Processing" },
  { key: "transcoding", label: "Transcoding" },
  { key: "uploading",   label: "Saving processed video" },
];

interface UploadZoneProps {
  conversationId: string;
  onComplete: () => void;
}

type Step =
  | { key: "idle" }
  | { key: "uploading"; current: string; pct: number }
  | { key: "processing"; jobId: string; jobStep: JobStep }
  | { key: "done" }
  | { key: "error"; message: string };

function putToR2(url: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error during upload."));
    xhr.send(file);
  });
}

export function UploadZone({ conversationId, onComplete }: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>({ key: "idle" });
  const [dragOver, setDragOver] = useState(false);
  const channelRef = useRef<ReturnType<ReturnType<typeof getBrowserClient>["channel"]> | null>(null);

  useEffect(() => {
    return () => { channelRef.current?.unsubscribe(); };
  }, []);

  function finish() {
    channelRef.current?.unsubscribe();
    channelRef.current = null;
    setStep({ key: "done" });
    setTimeout(() => onComplete(), 800);
  }

  function showError(message: string) {
    channelRef.current?.unsubscribe();
    channelRef.current = null;
    setStep({ key: "error", message });
  }

  // Subscribe to two rows:
  // 1. The preprocessing job — for step-by-step progress display.
  // 2. The conversation — for final completion (status='active') and errors.
  function subscribeToJob(jobId: string) {
    const supabase = getBrowserClient();

    const channel = supabase
      .channel(`preprocessing-${jobId}`)
      // Job row: update the active step as the worker stamps each stage.
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "video_preprocessing_jobs",
          filter: `id=eq.${jobId}`,
        },
        (payload) => {
          const row = payload.new as { step: JobStep; status: string; error_message: string | null };
          if (row.status === "error") {
            showError(row.error_message ?? "Processing failed.");
            return;
          }
          setStep((prev) =>
            prev.key === "processing" ? { ...prev, jobStep: row.step } : prev,
          );
        },
      )
      // Conversation row: final activation fires here.
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "conversations",
          filter: `id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as Partial<Conversation>;
          if (row.status === "active") finish();
          else if (row.preprocessing_error) showError(row.preprocessing_error);
        },
      )
      .subscribe(async (status) => {
        if (status !== "SUBSCRIBED") return;
        // Race-check: worker may have already finished before the subscription landed.
        const { data: conv } = await supabase
          .from("conversations")
          .select("status, preprocessing_error")
          .eq("id", conversationId)
          .single<{ status: string; preprocessing_error: string | null }>();
        if (conv?.status === "active") { finish(); return; }
        if (conv?.preprocessing_error) { showError(conv.preprocessing_error); return; }

        // Also sync current job step if the worker already advanced past null.
        const { data: job } = await supabase
          .from("video_preprocessing_jobs")
          .select("step, status, error_message")
          .eq("id", jobId)
          .single<{ step: JobStep; status: string; error_message: string | null }>();
        if (!job) return;
        if (job.status === "error") { showError(job.error_message ?? "Processing failed."); return; }
        setStep((prev) =>
          prev.key === "processing" ? { ...prev, jobStep: job.step } : prev,
        );
      });

    channelRef.current = channel;
  }

  async function upload(file: File) {
    if (file.size === 0) {
      setStep({ key: "error", message: "Selected file is empty." });
      return;
    }

    setStep({ key: "uploading", current: "Preparing upload...", pct: 0 });

    try {
      const urlRes = await fetch(`/api/conversations/${conversationId}/upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name }),
      });
      if (!urlRes.ok) {
        const { error } = (await urlRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(error ?? "Could not start upload.");
      }
      const { uploadUrl, key } = (await urlRes.json()) as { uploadUrl: string; key: string };

      await putToR2(uploadUrl, file, (pct) =>
        setStep({ key: "uploading", current: `Uploading video... ${pct}%`, pct }),
      );

      const completeRes = await fetch(`/api/conversations/${conversationId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, filename: file.name }),
      });
      if (!completeRes.ok) {
        const { error } = (await completeRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(error ?? "Failed to queue video processing.");
      }
      const { jobId } = (await completeRes.json()) as { jobId: string };

      setStep({ key: "processing", jobId, jobStep: null });
      subscribeToJob(jobId);
    } catch (err) {
      setStep({ key: "error", message: err instanceof Error ? err.message : "Upload failed." });
    }
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void upload(file);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void upload(file);
  }

  return (
    <div className="flex h-full flex-col items-center justify-center p-8">
      <div
        className={`relative flex w-full max-w-md flex-col items-center gap-6 rounded-2xl border-2 border-dashed px-8 py-12 text-center transition-colors ${
          dragOver
            ? "border-blue-400 bg-blue-950/20"
            : step.key === "error"
              ? "border-red-700 bg-red-950/10"
              : step.key === "done"
                ? "border-green-600 bg-green-950/10"
                : "border-zinc-700 bg-zinc-900/50 hover:border-zinc-600"
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {step.key === "idle" && (
          <>
            <div className="rounded-2xl bg-blue-500/10 p-4">
              <Upload className="h-8 w-8 text-blue-400" />
            </div>
            <div>
              <p className="text-base font-semibold text-zinc-100">Upload a game video</p>
              <p className="mt-1 text-sm text-zinc-500">
                Drag & drop or click to select — MP4, MOV, AVI supported
              </p>
              <p className="mt-1 text-xs text-zinc-600">
                Video will be transcoded to 720p for analysis
              </p>
            </div>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="rounded-lg bg-blue-500 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-400 transition-colors"
            >
              Select video
            </button>
            <input
              ref={inputRef}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={onFileInput}
            />
          </>
        )}

        {step.key === "uploading" && (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-blue-400" />
            <div className="w-full space-y-1">
              <p className="text-sm font-medium text-zinc-100">{step.current}</p>
              {step.pct > 0 && step.pct < 100 && (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-blue-500 transition-all duration-300"
                    style={{ width: `${step.pct}%` }}
                  />
                </div>
              )}
            </div>
          </>
        )}

        {step.key === "processing" && (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-blue-400" />
            <div className="w-full space-y-2.5">
              {STEPS.map(({ key: stepKey, label }) => {
                const stepIdx = STEPS.findIndex((s) => s.key === step.jobStep);
                const thisIdx = STEPS.findIndex((s) => s.key === stepKey);
                const isDone = stepIdx > thisIdx || step.jobStep === "done";
                const isActive = step.jobStep === stepKey;
                return (
                  <div
                    key={stepKey}
                    className={`flex items-center gap-2.5 text-xs transition-colors ${
                      isDone ? "text-green-400" : isActive ? "text-zinc-200" : "text-zinc-700"
                    }`}
                  >
                    {isDone ? (
                      <Check className="h-3.5 w-3.5 shrink-0" />
                    ) : isActive ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                    ) : (
                      <div className="h-3.5 w-3.5 shrink-0 rounded-full border border-zinc-800" />
                    )}
                    {label}
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-zinc-700">
              You&apos;ll be taken to the chat automatically when ready
            </p>
          </>
        )}

        {step.key === "done" && (
          <>
            <CheckCircle className="h-8 w-8 text-green-400" />
            <p className="text-sm font-medium text-zinc-100">Video ready — starting chat...</p>
          </>
        )}

        {step.key === "error" && (
          <>
            <AlertCircle className="h-8 w-8 text-red-400" />
            <div>
              <p className="text-sm font-medium text-red-300">Upload failed</p>
              <p className="mt-1 text-xs text-zinc-500">{step.message}</p>
            </div>
            <button
              type="button"
              onClick={() => setStep({ key: "idle" })}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-xs text-zinc-400 hover:border-zinc-600 hover:text-zinc-300 transition-colors"
            >
              Try again
            </button>
          </>
        )}
      </div>
    </div>
  );
}
