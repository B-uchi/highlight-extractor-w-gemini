"use client";

import { useEffect, useRef, useState } from "react";
import { Upload, CheckCircle, AlertCircle, Loader2 } from "lucide-react";

import { getBrowserClient } from "@/lib/supabase";
import type { Conversation } from "@/lib/types";

interface UploadZoneProps {
  conversationId: string;
  onComplete: () => void;
}

type Step =
  | { key: "idle" }
  | { key: "uploading"; current: string; pct: number }
  | { key: "processing" }
  | { key: "done" }
  | { key: "error"; message: string };

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
  // Hold the Realtime channel so we can unsubscribe on unmount / completion.
  const channelRef = useRef<ReturnType<ReturnType<typeof getBrowserClient>["channel"]> | null>(null);

  // Clean up Realtime subscription when component unmounts.
  useEffect(() => {
    return () => {
      channelRef.current?.unsubscribe();
    };
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

  // Subscribe to the conversation row. Resolves immediately if already active,
  // otherwise waits for the backend worker to set status='active'.
  function subscribeToConversation() {
    const supabase = getBrowserClient();

    const channel = supabase
      .channel(`conv-preprocessing-${conversationId}`)
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
          if (row.status === "active") {
            finish();
          } else if (row.preprocessing_error) {
            showError(row.preprocessing_error);
          }
        },
      )
      .subscribe(async (status) => {
        if (status !== "SUBSCRIBED") return;
        // Check current DB state — the worker may have already finished before
        // the subscription was established.
        const { data } = await supabase
          .from("conversations")
          .select("status, preprocessing_error")
          .eq("id", conversationId)
          .single<{ status: string; preprocessing_error: string | null }>();
        if (!data) return;
        if (data.status === "active") finish();
        else if (data.preprocessing_error) showError(data.preprocessing_error);
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
      // 1) Get a presigned PUT URL
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

      // 2) Upload directly to R2
      await putToR2(uploadUrl, file, (pct) =>
        setStep({ key: "uploading", current: `Uploading video... ${pct}%`, pct }),
      );

      // 3) Enqueue preprocessing — returns 202 immediately
      const completeRes = await fetch(`/api/conversations/${conversationId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, filename: file.name }),
      });
      if (!completeRes.ok) {
        const { error } = (await completeRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(error ?? "Failed to queue video processing.");
      }

      // 4) Subscribe to Realtime and wait for backend to finish
      setStep({ key: "processing" });
      subscribeToConversation();
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

        {(step.key === "uploading" || step.key === "processing") && (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-blue-400" />
            <div className="w-full space-y-1">
              <p className="text-sm font-medium text-zinc-100">
                {step.key === "uploading" ? step.current : "Processing video..."}
              </p>
              {step.key === "uploading" && step.pct > 0 && step.pct < 100 && (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-blue-500 transition-all duration-300"
                    style={{ width: `${step.pct}%` }}
                  />
                </div>
              )}
              {step.key === "processing" && (
                <p className="text-xs text-zinc-600">
                  Transcoding in the background — you&apos;ll be taken to the chat automatically
                </p>
              )}
            </div>
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
