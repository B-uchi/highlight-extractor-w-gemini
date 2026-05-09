"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";

import { JobState } from "@/lib/types";

function formatDurationMs(durationMs?: number): string {
  if (typeof durationMs !== "number" || durationMs < 0) {
    return "—";
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [prompt, setPrompt] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  useEffect(() => {
    if (!jobId) {
      return;
    }

    let cancelled = false;

    const fetchStatus = async () => {
      const response = await fetch(`/api/status/${jobId}`, { cache: "no-store" });
      const body = await response.json();
      if (cancelled) {
        return;
      }
      if (!response.ok) {
        setError(body.error ?? "Failed to fetch job status.");
        return;
      }
      setJob(body as JobState);
      if (body.stage === "error") {
        setError(body.error ?? "Job failed.");
      }
    };

    void fetchStatus();
    const timer = window.setInterval(() => {
      void fetchStatus();
    }, 2_500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [jobId]);

  const canSubmit = useMemo(() => !isUploading && Boolean(file), [file, isUploading]);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setFile(event.target.files?.[0] ?? null);
    setError(null);
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file) {
      setError("Please choose a video file first.");
      return;
    }

    try {
      setIsUploading(true);
      setError(null);
      setJob(null);
      setJobId(null);

      const formData = new FormData();
      formData.set("video", file);
      if (prompt.trim()) {
        formData.set("prompt", prompt.trim());
      }

      const response = await fetch("/api/process", {
        method: "POST",
        body: formData,
      });
      const body = await response.json();

      if (!response.ok) {
        throw new Error(body.error ?? "Upload failed.");
      }

      setJobId(body.jobId);
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Upload request failed.";
      setError(message);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <main className="min-h-screen bg-zinc-950 px-6 py-10 text-zinc-100">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
          <h1 className="text-2xl font-semibold">Video Highlights Spike</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Upload one video and generate multi-modal, multi-highlight clips.
          </p>

          <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
            <input
              type="file"
              accept="video/*"
              onChange={onFileChange}
              className="block w-full cursor-pointer rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm"
            />
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Optional: describe what should count as a highlight moment."
              className="min-h-24 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-3 text-sm text-zinc-100 placeholder:text-zinc-500"
            />
            <button
              type="submit"
              disabled={!canSubmit}
              className="w-fit rounded-lg bg-blue-500 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isUploading ? "Uploading..." : "Upload and Process"}
            </button>
          </form>
        </section>

        {(jobId || job) && (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
            <h2 className="text-lg font-semibold">Job Status</h2>
            <p className="mt-2 text-sm text-zinc-400">Job ID: {jobId}</p>
            <p className="mt-2 text-sm">
              Stage: <span className="font-medium">{job?.stage ?? "queued"}</span>
            </p>
            <p className="mt-1 text-sm text-zinc-300">{job?.message ?? "Waiting for updates..."}</p>
            <div className="mt-3 h-2 w-full rounded-full bg-zinc-800">
              <div
                className="h-2 rounded-full bg-blue-500 transition-all"
                style={{ width: `${job?.progress ?? 0}%` }}
              />
            </div>

            {job?.metrics && (
              <div className="mt-4 grid gap-1 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-sm text-zinc-300">
                <p>
                  Time taken: <span className="font-medium text-zinc-100">{formatDurationMs(job.metrics.durationMs)}</span>
                </p>
                <p>
                  Transcription (audio seconds):{" "}
                  <span className="font-medium text-zinc-100">
                    {job.metrics.ai.openai.transcriptionSeconds.toFixed(1)}
                  </span>
                </p>
                <p>
                  Gemini (tokens):{" "}
                  <span className="font-medium text-zinc-100">
                    in {job.metrics.ai.gemini.inputTokens} / out {job.metrics.ai.gemini.outputTokens} / total{" "}
                    {job.metrics.ai.gemini.totalTokens}
                  </span>
                </p>
                <p>
                  Gemini (video seconds):{" "}
                  <span className="font-medium text-zinc-100">
                    {job.metrics.ai.gemini.videoSeconds.toFixed(1)}
                  </span>
                </p>
                <p>
                  Prompt used:{" "}
                  <span className="font-medium text-zinc-100">
                    {job.effectivePrompt
                      ? job.userPrompt
                        ? `custom - ${job.effectivePrompt}`
                        : `default - ${job.effectivePrompt}`
                      : "pending"}
                  </span>
                </p>
              </div>
            )}
          </section>
        )}

        {error && (
          <section className="rounded-2xl border border-red-900 bg-red-950/40 p-6 text-sm text-red-200">
            {error}
          </section>
        )}

        {job?.highlights && job.highlights.length > 0 && (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
            <h2 className="text-lg font-semibold">Detected Highlights ({job.highlights.length})</h2>
            <div className="mt-4 grid gap-4">
              {job.highlights.map((highlight, index) => (
                <article key={`${highlight.startSec}-${highlight.endSec}-${index}`} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
                  <h3 className="text-base font-semibold text-zinc-100">{highlight.title}</h3>
                  <p className="mt-2 text-sm text-zinc-300">{highlight.reason}</p>
                  <p className="mt-2 text-sm text-zinc-400">
                    {highlight.startSec.toFixed(2)}s - {highlight.endSec.toFixed(2)}s (score{" "}
                    {highlight.score.toFixed(0)})
                  </p>
                </article>
              ))}
            </div>
          </section>
        )}

        {job?.clips && job.clips.length > 0 && (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
            <h2 className="text-lg font-semibold">Generated Clips ({job.clips.length})</h2>
            <div className="mt-4 grid gap-6">
              {job.clips.map((clip) => (
                <article key={clip.id} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
                  <h3 className="text-base font-semibold text-zinc-100">{clip.title}</h3>
                  <p className="mt-1 text-sm text-zinc-400">
                    {clip.startSec.toFixed(2)}s - {clip.endSec.toFixed(2)}s (score {clip.score.toFixed(0)})
                  </p>
                  <video className="mt-3 w-full rounded-lg" controls src={clip.url} />
                </article>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
