"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X, Download, ChevronLeft, ChevronRight, Film } from "lucide-react";

import type { Clip, Job } from "@/lib/types";
import { formatDuration } from "@/lib/format";

interface ClipViewerProps {
  job: Job;
  clips: Clip[];
  onClose: () => void;
}

async function fetchFreshUrl(clipId: string): Promise<string | null> {
  const res = await fetch(`/api/clips/${clipId}/url`);
  if (!res.ok) return null;
  const data = await res.json() as { url: string };
  return data.url;
}

// ── Individual clip player ────────────────────────────────────────────────────

function IndividualViewer({ clips, jobId }: { clips: Clip[]; jobId: string }) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [loadingUrl, setLoadingUrl] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  const clip = clips[activeIdx];

  const loadClip = useCallback(async (idx: number) => {
    const c = clips[idx];
    if (!c) return;
    setVideoUrl(null);
    setLoadingUrl(true);
    try {
      const url = await fetchFreshUrl(c.id);
      setVideoUrl(url);
    } finally {
      setLoadingUrl(false);
    }
  }, [clips]);

  useEffect(() => {
    void loadClip(activeIdx);
  }, [activeIdx, loadClip]);

  useEffect(() => {
    if (videoUrl && videoRef.current) {
      videoRef.current.load();
      void videoRef.current.play().catch(() => {});
    }
  }, [videoUrl]);

  // Keyboard nav
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && activeIdx > 0) setActiveIdx((i) => i - 1);
      if (e.key === "ArrowRight" && activeIdx < clips.length - 1) setActiveIdx((i) => i + 1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeIdx, clips.length]);

  async function download() {
    const url = await fetchFreshUrl(clip.id);
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${clip.title}.mp4`;
    a.click();
  }

  const duration = formatDuration((clip.follow_up_end_sec ?? clip.end_sec) - clip.start_sec);
  const hasNext = activeIdx < clips.length - 1;
  const hasPrev = activeIdx > 0;

  return (
    <div className="flex h-full flex-col">
      {/* Video player */}
      <div className="relative bg-black shrink-0">
        {loadingUrl ? (
          <div className="flex aspect-video items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-400" />
          </div>
        ) : videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            autoPlay
            className="w-full aspect-video"
          />
        ) : (
          <div className="flex aspect-video items-center justify-center text-xs text-zinc-600">
            No video
          </div>
        )}

        {/* Prev / Next overlays */}
        {hasPrev && (
          <button
            type="button"
            onClick={() => setActiveIdx((i) => i - 1)}
            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80 transition-colors"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
        {hasNext && (
          <button
            type="button"
            onClick={() => setActiveIdx((i) => i + 1)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80 transition-colors"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Active clip metadata */}
      <div className="shrink-0 border-b border-zinc-800/60 px-4 py-3 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-zinc-100">{clip.title}</p>
            {clip.description && (
              <p className="mt-0.5 text-xs text-zinc-500 line-clamp-2">{clip.description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => void download()}
            title="Download clip"
            className="shrink-0 rounded-lg bg-zinc-800 p-1.5 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100 transition-colors"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-semibold text-blue-300">
            #{clip.rank}
          </span>
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">
            {duration}
          </span>
          {clip.jersey_number && (
            <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">
              #{clip.jersey_number}
            </span>
          )}
          {clip.jersey_color && (
            <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 capitalize">
              {clip.jersey_color}
            </span>
          )}
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-500">
            {formatDuration(clip.start_sec)} → {formatDuration(clip.end_sec)}
          </span>
        </div>
      </div>

      {/* Clip strip */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="px-4 pt-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
          {clips.length} clip{clips.length !== 1 ? "s" : ""} · use ← → to navigate
        </p>
        <ul className="px-3 pb-3 space-y-1">
          {clips.map((c, idx) => {
            const d = formatDuration((c.follow_up_end_sec ?? c.end_sec) - c.start_sec);
            const isActive = idx === activeIdx;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setActiveIdx(idx)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                    isActive
                      ? "bg-blue-500/10 ring-1 ring-blue-500/30"
                      : "hover:bg-zinc-800/60"
                  }`}
                >
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                    isActive ? "bg-blue-500 text-white" : "bg-zinc-800 text-zinc-400"
                  }`}>
                    {c.rank}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={`truncate text-xs font-medium ${isActive ? "text-zinc-100" : "text-zinc-400"}`}>
                      {c.title}
                    </p>
                    {c.description && (
                      <p className="truncate text-[10px] text-zinc-600">{c.description}</p>
                    )}
                  </div>
                  <span className="shrink-0 text-[10px] text-zinc-600">{d}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// ── Compilation player ────────────────────────────────────────────────────────

function CompilationViewer({ job, clips }: { job: Job; clips: Clip[] }) {
  const [compilationUrl, setCompilationUrl] = useState(job.compilation_r2_url ?? null);
  const [showClips, setShowClips] = useState(false);

  async function download() {
    const res = await fetch(`/api/jobs/${job.id}`);
    if (!res.ok) return;
    const data = await res.json() as { job: Job };
    const url = data.job.compilation_r2_url ?? compilationUrl;
    if (!url) return;
    setCompilationUrl(url);
    const a = document.createElement("a");
    a.href = url;
    a.download = `highlight-${job.id.slice(0, 8)}.mp4`;
    a.click();
  }

  return (
    <div className="flex h-full flex-col">
      {/* Compilation player */}
      <div className="shrink-0 bg-black">
        {compilationUrl ? (
          <video src={compilationUrl} controls autoPlay className="w-full aspect-video" />
        ) : (
          <div className="flex aspect-video items-center justify-center text-xs text-zinc-600">
            No video available
          </div>
        )}
      </div>

      {/* Meta + download */}
      <div className="shrink-0 border-b border-zinc-800/60 px-4 py-3 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-zinc-100">Highlight Reel</p>
            <p className="mt-0.5 truncate text-xs text-zinc-500">{job.extracted_target}</p>
          </div>
          <button
            type="button"
            onClick={() => void download()}
            className="shrink-0 flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">
            {clips.length} plays
          </span>
          {!job.include_audio && (
            <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">
              No audio
            </span>
          )}
        </div>
      </div>

      {/* Source clips toggle */}
      {clips.length > 0 && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <button
            type="button"
            onClick={() => setShowClips((s) => !s)}
            className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-zinc-900/40 transition-colors"
          >
            <Film className="h-3.5 w-3.5 text-zinc-600" />
            <span className="text-xs font-medium text-zinc-500">
              {showClips ? "Hide" : "Show"} source clips ({clips.length})
            </span>
          </button>

          {showClips && (
            <ul className="px-3 pb-3 space-y-1">
              {clips.map((c) => (
                <li key={c.id} className="rounded-lg bg-zinc-900 px-3 py-2 ring-1 ring-zinc-800">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-xs font-medium text-zinc-300">{c.title}</p>
                    <span className="shrink-0 text-[10px] text-zinc-600">
                      {formatDuration(c.start_sec)} → {formatDuration(c.end_sec)}
                    </span>
                  </div>
                  {c.description && (
                    <p className="mt-0.5 text-[10px] text-zinc-600 line-clamp-1">{c.description}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export function ClipViewer({ job, clips, onClose }: ClipViewerProps) {
  const isCompilation = job.mode !== "action_extraction";

  return (
    <div className="flex h-full flex-col border-l border-zinc-800/60 bg-zinc-950">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-zinc-800/60 px-4 py-2.5">
        <p className="truncate text-xs font-semibold text-zinc-200">
          {isCompilation ? "Highlight Reel" : `${clips.length} Clip${clips.length !== 1 ? "s" : ""}`}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-lg p-1 text-zinc-600 hover:text-zinc-300 transition-colors"
          title="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {isCompilation ? (
          <CompilationViewer job={job} clips={clips} />
        ) : (
          <IndividualViewer clips={clips} jobId={job.id} />
        )}
      </div>
    </div>
  );
}
