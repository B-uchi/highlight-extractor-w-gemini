"use client";

import { useRef, useState } from "react";
import { Upload, CheckCircle, AlertCircle, Loader2 } from "lucide-react";

import type { UploadProgressEvent } from "@/lib/types";

interface UploadZoneProps {
  conversationId: string;
  onComplete: () => void;
}

type Step =
  | { key: "idle" }
  | { key: "uploading"; current: string; events: UploadProgressEvent[] }
  | { key: "done" }
  | { key: "error"; message: string };

function stepLabel(event: UploadProgressEvent): string {
  if (event.step === "preprocessing") return event.message;
  if (event.step === "uploading_r2") return event.message;
  if (event.step === "uploading_gemini") {
    return event.totalChunks && event.totalChunks > 1
      ? `Preparing for analysis (${event.chunk ?? 0}/${event.totalChunks} chunks)...`
      : "Preparing for analysis...";
  }
  if (event.step === "done") return "Ready";
  return event.message;
}

// PUT a file straight to R2 via a presigned URL, reporting upload progress.
// Uses XHR because fetch() has no upload-progress events.
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

  // Processing holds the connection open while chunks upload to Gemini, which can
  // outlast a browser/proxy timeout. If the stream dies before "done", fall back
  // to polling status — the server sets it "active" once the video is stored.
  async function confirmReadyViaStatus(): Promise<boolean> {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const res = await fetch(`/api/conversations/${conversationId}`, { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as { conversation?: { status?: string } };
          if (data.conversation?.status === "active") return true;
        }
      } catch {
        // transient — retry
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    return false;
  }

  function finish() {
    setStep({ key: "done" });
    setTimeout(() => onComplete(), 800);
  }

  function pushEvent(current: string, event?: UploadProgressEvent) {
    setStep((prev) => {
      const prevEvents = prev.key === "uploading" ? prev.events : [];
      return { key: "uploading", current, events: event ? [...prevEvents, event] : prevEvents };
    });
  }

  async function upload(file: File) {
    if (file.size === 0) {
      setStep({ key: "error", message: "Selected file is empty." });
      return;
    }

    setStep({ key: "uploading", current: "Preparing upload...", events: [] });

    try {
      // 1) Ask the server for a presigned PUT URL
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

      // 2) Upload the raw file directly to R2 (bypasses the API body limit)
      pushEvent("Uploading video... 0%");
      await putToR2(uploadUrl, file, (pct) => pushEvent(`Uploading video... ${pct}%`));
      pushEvent("Processing video...", { step: "preprocessing", message: "Video uploaded" });

      // 3) Trigger server-side processing and stream progress
      let sawDone = false;
      let sawError = false;

      const res = await fetch(`/api/conversations/${conversationId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, filename: file.name }),
      });

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body.");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as UploadProgressEvent;
            if (event.step === "heartbeat") continue;
            if (event.step === "error") {
              sawError = true;
              setStep({ key: "error", message: event.error ?? event.message });
              return;
            }
            if (event.step === "done") {
              sawDone = true;
              finish();
              return;
            }
            pushEvent(stepLabel(event), event);
          } catch {
            // ignore parse errors on partial lines
          }
        }
      }

      // Stream ended without an explicit done/error — verify via status.
      if (!sawDone && !sawError) {
        if (await confirmReadyViaStatus()) finish();
        else setStep({ key: "error", message: "Processing did not complete. Please try again." });
      }
    } catch (err) {
      // The connection may have dropped only after the server finished — check status first.
      if (await confirmReadyViaStatus()) {
        finish();
        return;
      }
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

  const events = step.key === "uploading" ? step.events : [];
  const current = step.key === "uploading" ? step.current : "";

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
            <div className="w-full space-y-2">
              <p className="text-sm font-medium text-zinc-100">
                {current || "Processing..."}
              </p>
              <div className="space-y-1">
                {events.map((ev, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs text-zinc-500">
                    <span className="text-green-400">✓</span>
                    <span>{stepLabel(ev)}</span>
                  </div>
                ))}
              </div>
            </div>
            <p className="text-xs text-zinc-600">This may take a few minutes for large files</p>
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
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-600 transition-colors"
            >
              Try again
            </button>
          </>
        )}
      </div>
    </div>
  );
}
