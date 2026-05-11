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
  const [categoryOverride, setCategoryOverride] = useState("auto");
  const [eventFilter, setEventFilter] = useState("all");
  const [minScoreFilter, setMinScoreFilter] = useState(0);
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [reelBlobUrl, setReelBlobUrl] = useState<string | null>(null);
  const [isBuildingReel, setIsBuildingReel] = useState(false);

  useEffect(() => {
    if (!jobId) {
      return;
    }

    const stream = new EventSource(`/api/status/${jobId}/stream`);
    stream.onmessage = (event) => {
      const payload = JSON.parse(event.data) as JobState;
      setJob(payload);
      if (payload.stage === "error") {
        setError(payload.error ?? "Job failed.");
      }
    };
    stream.onerror = () => {
      stream.close();
    };

    return () => {
      stream.close();
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
      setSelectedClipIds([]);
      setReelBlobUrl(null);

      const formData = new FormData();
      formData.set("video", file);
      if (prompt.trim()) {
        formData.set("prompt", prompt.trim());
      }
      if (categoryOverride !== "auto") {
        formData.set("category", categoryOverride);
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

  const filteredHighlights = useMemo(() => {
    if (!job?.highlights) {
      return [];
    }
    return job.highlights.filter((highlight) => {
      const eventMatches = eventFilter === "all" || (highlight.eventType ?? "highlight") === eventFilter;
      const scoreMatches = highlight.score >= minScoreFilter;
      return eventMatches && scoreMatches;
    });
  }, [eventFilter, minScoreFilter, job]);

  const filteredClips = useMemo(() => {
    if (!job?.clips) {
      return [];
    }
    return job.clips.filter((clip) => {
      const eventMatches = eventFilter === "all" || (clip.eventType ?? "highlight") === eventFilter;
      return eventMatches && clip.score >= minScoreFilter;
    });
  }, [eventFilter, minScoreFilter, job]);

  const uniqueEventTypes = useMemo(() => {
    const all = new Set<string>();
    for (const highlight of job?.highlights ?? []) {
      all.add(highlight.eventType ?? "highlight");
    }
    return Array.from(all).sort();
  }, [job?.highlights]);

  const onToggleClip = (clipId: string) => {
    setSelectedClipIds((current) =>
      current.includes(clipId) ? current.filter((id) => id !== clipId) : [...current, clipId],
    );
  };


  const onBuildReel = async () => {
    if (!jobId || isBuildingReel) {
      return;
    }
    setIsBuildingReel(true);
    setError(null);
    const abortController = new AbortController();
    const clientTimeoutMs = 20 * 60 * 1000;
    const clientTimeout = setTimeout(() => abortController.abort(), clientTimeoutMs);
    try {
      const response = await fetch(`/api/reel/${jobId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clipIds: selectedClipIds }),
        signal: abortController.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: "Failed to build reel." }));
        setError(body.error ?? "Failed to build reel.");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      setReelBlobUrl((old) => {
        if (old) {
          URL.revokeObjectURL(old);
        }
        return url;
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setError(
          `Build Reel was cancelled after ${clientTimeoutMs / 60_000} minutes (browser timeout). The server may still be running FFmpeg — try fewer clips, or check terminal logs for FFmpeg errors.`,
        );
        return;
      }
      const message = err instanceof Error ? err.message : "Network error while building reel.";
      setError(`Build Reel failed: ${message}`);
    } finally {
      clearTimeout(clientTimeout);
      setIsBuildingReel(false);
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
            <select
              value={categoryOverride}
              onChange={(event) => setCategoryOverride(event.target.value)}
              className="rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm"
            >
              <option value="auto">Auto category</option>
              <option value="sports">Sports</option>
              <option value="talk_podcast">Talk / Podcast</option>
              <option value="lecture">Lecture</option>
              <option value="vlog">Vlog</option>
              <option value="gaming">Gaming</option>
              <option value="music">Music</option>
              <option value="generic">Generic</option>
            </select>
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
                  Category: <span className="font-medium text-zinc-100">{job.category ?? "pending"}</span>
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

        {(job?.highlights?.length ?? 0) > 0 && (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
            <h2 className="text-lg font-semibold">Filters</h2>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                Event type
                <select
                  className="rounded-lg border border-zinc-700 bg-zinc-950 p-2"
                  value={eventFilter}
                  onChange={(event) => setEventFilter(event.target.value)}
                >
                  <option value="all">All</option>
                  {uniqueEventTypes.map((eventType) => (
                    <option key={eventType} value={eventType}>
                      {eventType}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Min score ({minScoreFilter})
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={minScoreFilter}
                  onChange={(event) => setMinScoreFilter(Number(event.target.value))}
                />
              </label>
            </div>
          </section>
        )}

        {filteredHighlights.length > 0 && (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
            <h2 className="text-lg font-semibold">Detected Highlights ({filteredHighlights.length})</h2>
            <div className="mt-4 grid gap-4">
              {filteredHighlights.map((highlight, index) => (
                <article key={`${highlight.startSec}-${highlight.endSec}-${index}`} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
                  <h3 className="text-base font-semibold text-zinc-100">{highlight.title}</h3>
                  <p className="mt-2 text-sm text-zinc-300">{highlight.reason}</p>
                  <p className="mt-2 text-sm text-zinc-400">
                    {highlight.startSec.toFixed(2)}s - {highlight.endSec.toFixed(2)}s (score{" "}
                    {highlight.score.toFixed(0)})
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {highlight.eventType ?? "highlight"} / confidence {(highlight.confidence ?? 0).toFixed(2)}
                  </p>
                </article>
              ))}
            </div>
          </section>
        )}

        {filteredClips.length > 0 && (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6">
            <h2 className="text-lg font-semibold">Generated Clips ({filteredClips.length})</h2>
            <div className="mt-2 flex items-center gap-3 text-sm">
              <button
                type="button"
                className="rounded-lg border border-zinc-700 px-3 py-1 cursor-pointer"
                onClick={() => setSelectedClipIds(filteredClips.map((clip) => clip.id))}
              >
                Select All
              </button>
              <button
                type="button"
                className="rounded-lg border border-zinc-700 px-3 py-1 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
                onClick={onBuildReel}
                disabled={isBuildingReel || selectedClipIds.length === 0}
              >
                {isBuildingReel ? "Building reel…" : "Build Reel"}
              </button>
              <span className="text-zinc-400">{selectedClipIds.length} selected</span>
              {reelBlobUrl && (
                <a className="text-blue-400 underline" href={reelBlobUrl} download={`${jobId}-reel.mp4`}>
                  Download reel
                </a>
              )}
            </div>
            <div className="mt-4 grid gap-6">
              {filteredClips.map((clip) => (
                <article key={clip.id} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-base font-semibold text-zinc-100">{clip.title}</h3>
                    <label className="text-xs text-zinc-300">
                      <input
                        type="checkbox"
                        checked={selectedClipIds.includes(clip.id)}
                        onChange={() => onToggleClip(clip.id)}
                        className="mr-2"
                      />
                      Include in reel
                    </label>
                  </div>
                  <p className="mt-1 text-sm text-zinc-400">
                    {clip.startSec.toFixed(2)}s - {clip.endSec.toFixed(2)}s (score {clip.score.toFixed(0)})
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {clip.category ?? "generic"} / {clip.eventType ?? "highlight"}
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
