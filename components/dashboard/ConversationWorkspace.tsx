"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { UploadZone } from "@/components/dashboard/UploadZone";
import { JobStatusCard } from "@/components/dashboard/JobStatusCard";
import { ClipViewer } from "@/components/dashboard/ClipViewer";
import { PromptInput } from "@/components/dashboard/PromptInput";
import type { Clip, Conversation, Job, MessageWithClips } from "@/lib/types";
import { relativeTime } from "@/lib/format";

// ── Message rendering ─────────────────────────────────────────────────────────

function UserBubble({ content, time }: { content: string; time: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[70%] space-y-1">
        <div className="rounded-2xl rounded-br-sm bg-blue-500/15 px-4 py-2.5 ring-1 ring-blue-500/20">
          <p className="text-sm text-zinc-100 whitespace-pre-wrap">{content}</p>
        </div>
        <p className="text-right text-[10px] text-zinc-600">{time}</p>
      </div>
    </div>
  );
}

function AssistantBubble({ content, time }: { content: string; time: string }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[70%] space-y-1">
        <div className="rounded-2xl rounded-bl-sm bg-zinc-900 px-4 py-2.5 ring-1 ring-zinc-800">
          <p className="text-sm text-zinc-300 whitespace-pre-wrap">{content}</p>
        </div>
        <p className="text-[10px] text-zinc-600">{time}</p>
      </div>
    </div>
  );
}

function ClipResultCard({
  message,
  clips,
  job,
  onOpen,
}: {
  message: MessageWithClips;
  clips: Clip[];
  job: Job;
  onOpen: () => void;
}) {
  const isCompilation = job.mode !== "action_extraction";
  const label = isCompilation
    ? `Agent done: Highlight reel ready — ${clips.length} play${clips.length !== 1 ? "s" : ""}`
    : `Agent done: ${clips.length} clip${clips.length !== 1 ? "s" : ""} found`;

  return (
    <div className="flex justify-start">
      <div className="max-w-[70%] space-y-1">
        <button
          type="button"
          onClick={onOpen}
          className="group w-full rounded-2xl rounded-bl-sm bg-zinc-900 px-4 py-3 text-left ring-1 ring-zinc-800 hover:ring-blue-500/40 transition-all"
        >
          <p className="text-sm font-medium text-zinc-100 group-hover:text-blue-300 transition-colors">
            {label}
          </p>
          <p className="mt-0.5 text-[11px] text-zinc-500">{job.extracted_target}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {clips.slice(0, 4).map((c) => (
              <span
                key={c.id}
                className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 truncate max-w-30"
              >
                {c.title}
              </span>
            ))}
            {clips.length > 4 && (
              <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-500">
                +{clips.length - 4} more
              </span>
            )}
          </div>
          <p className="mt-2 text-[10px] text-blue-500/60 group-hover:text-blue-400 transition-colors">
            Click to view →
          </p>
        </button>
        <p className="text-[10px] text-zinc-600">{relativeTime(message.created_at)}</p>
      </div>
    </div>
  );
}

// ── Message row ───────────────────────────────────────────────────────────────

function MessageRow({
  message,
  onJobSettled,
  onOpenClips,
}: {
  message: MessageWithClips;
  onJobSettled: (jobId: string, job: Job, clips: Clip[]) => void;
  onOpenClips: (job: Job, clips: Clip[]) => void;
}) {
  const time = relativeTime(message.created_at);

  if (message.role === "user") {
    return <UserBubble content={message.content} time={time} />;
  }

  // Assistant: check if this is a result message (has a job with clips)
  if (message.job_id && message.job) {
    const job = message.job;
    const clips = message.clips ?? [];

    if (job.status === "done" && clips.length > 0) {
      return (
        <ClipResultCard
          message={message}
          clips={clips}
          job={job}
          onOpen={() => onOpenClips(job, clips)}
        />
      );
    }

    // Job is running or just finished with no clips
    if (!["done", "error", "unsupported"].includes(job.status)) {
      return (
        <div className="flex justify-start">
          <div className="w-full max-w-[70%]">
            <JobStatusCard
              jobId={message.job_id}
              onSettled={(j, c) => onJobSettled(message.job_id!, j, c)}
            />
          </div>
        </div>
      );
    }
  }

  return <AssistantBubble content={message.content} time={time} />;
}

// ── Main workspace ────────────────────────────────────────────────────────────

interface WorkspaceData {
  conversation: Conversation;
  messages: MessageWithClips[];
}

const VIEWER_MIN_WIDTH = 320;  // px — matches previous fixed w-80
const VIEWER_MAX_WIDTH = 580;  // px — generous but won't crush the chat area
const STORAGE_KEY = "hoops-ai:clip-viewer-width";

export function ConversationWorkspace({ conversationId }: { conversationId: string }) {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState(false);
  const [viewer, setViewer] = useState<{ job: Job; clips: Clip[] } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // ── Resizable clip viewer ──────────────────────────────────────────────────
  const [viewerWidth, setViewerWidth] = useState(VIEWER_MIN_WIDTH);
  const widthRef = useRef(VIEWER_MIN_WIDTH);

  // Hydrate from localStorage on mount (avoids SSR mismatch)
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const n = Number(stored);
      if (n >= VIEWER_MIN_WIDTH && n <= VIEWER_MAX_WIDTH) {
        setViewerWidth(n);
        widthRef.current = n;
      }
    }
  }, []);

  function onResizeMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMouseMove(me: MouseEvent) {
      // Dragging the left edge left → panel gets wider (subtract delta from startX)
      const delta = startX - me.clientX;
      const next = Math.min(VIEWER_MAX_WIDTH, Math.max(VIEWER_MIN_WIDTH, startWidth + delta));
      widthRef.current = next;
      setViewerWidth(next);
    }

    function onMouseUp() {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem(STORAGE_KEY, String(widthRef.current));
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/conversations/${conversationId}`);
      if (!res.ok) { setError("Conversation not found."); setLoading(false); return; }
      const json = await res.json() as WorkspaceData;
      setData(json);

      // Check if any message has a running job
      const running = json.messages.some(
        (m) => m.job && !["done", "error", "unsupported"].includes(m.job.status),
      );
      setActiveJob(running);
    } catch {
      setError("Failed to load conversation.");
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => { void load(); }, [load]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [data?.messages.length]);

  function handleJobSettled(_jobId: string, _job: Job, _clips: Clip[]) {
    // Reload from the server — the assistant message was inserted in DB before
    // the job status flipped to done, so it's guaranteed to be there now.
    setActiveJob(false);
    void load();
  }

  async function handleSubmit(opts: {
    prompt: string;
    followUpSecs: number | null;
    clipLimit: number | null;
  }) {
    if (!data) return;
    setActiveJob(true);

    const now = new Date().toISOString();
    const tmpUserId = `tmp-user-${Date.now()}`;
    const tmpAssistantId = `tmp-assistant-${Date.now()}`;

    // Optimistic user message
    const tmpUserMsg: MessageWithClips = {
      id: tmpUserId,
      conversation_id: conversationId,
      role: "user",
      content: opts.prompt,
      job_id: null,
      created_at: now,
    };

    // Optimistic assistant loading message — needed so JobStatusCard renders immediately
    const pendingJob: Job = {
      id: tmpAssistantId,
      conversation_id: conversationId,
      message_id: tmpUserId,
      mode: "action_extraction",
      status: "pending",
      prompt: opts.prompt,
      extracted_target: null,
      jersey_number: null,
      jersey_color: null,
      team_name: null,
      clip_limit: opts.clipLimit,
      follow_up_secs: opts.followUpSecs,
      include_audio: true,
      clips_total: null,
      clips_done: 0,
      chunks_analyzed: 0,
      chunks_total: null,
      compilation_r2_key: null,
      compilation_r2_url: null,
      error_message: null,
      created_at: now,
      updated_at: now,
    };
    const tmpAssistantMsg: MessageWithClips = {
      id: tmpAssistantId,
      conversation_id: conversationId,
      role: "assistant",
      content: "",
      job_id: tmpAssistantId,
      job: pendingJob,
      clips: [],
      created_at: now,
    };

    setData((prev) =>
      prev ? { ...prev, messages: [...prev.messages, tmpUserMsg, tmpAssistantMsg] } : prev,
    );

    const res = await fetch(`/api/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: opts.prompt,
        followUpSecs: opts.followUpSecs,
        clipLimit: opts.clipLimit,
      }),
    });

    const body = await res.json() as { messageId?: string; jobId?: string; error?: string };

    if (!res.ok) {
      setActiveJob(false);
      setData((prev) =>
        prev
          ? { ...prev, messages: prev.messages.filter((m) => m.id !== tmpUserId && m.id !== tmpAssistantId) }
          : prev,
      );
      return;
    }

    // Replace optimistic messages with real IDs and wire the real jobId to the assistant message
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        messages: prev.messages.map((m) => {
          if (m.id === tmpUserId) return { ...m, id: body.messageId!, job_id: body.jobId! };
          if (m.id === tmpAssistantId) {
            return {
              ...m,
              job_id: body.jobId!,
              job: { ...pendingJob, id: body.jobId!, message_id: body.messageId! },
            };
          }
          return m;
        }),
      };
    });
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-sm text-zinc-500">Loading...</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-zinc-500">{error ?? "Conversation not found."}</p>
      </div>
    );
  }

  const { conversation, messages } = data;
  const isAwaiting = conversation.status === "awaiting_video";

  return (
    <div className="flex h-full min-h-0">
      {/* Main chat area */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Conversation title bar */}
        <div className="flex items-center gap-2 border-b border-zinc-800/60 px-4 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-zinc-100">{conversation.title}</p>
            {conversation.video_duration_secs && (
              <p className="text-[10px] text-zinc-600">
                {Math.round(conversation.video_duration_secs / 60)} min · {conversation.video_filename}
              </p>
            )}
          </div>
        </div>

        {/* Chat or upload zone */}
        {isAwaiting ? (
          <UploadZone
            conversationId={conversationId}
            onComplete={() => void load()}
          />
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 space-y-4">
              {messages.length === 0 && (
                <div className="flex h-full items-center justify-center">
                  <div className="text-center space-y-2">
                    <p className="text-sm text-zinc-400">What would you like to find?</p>
                    <p className="text-xs text-zinc-600">
                      Try: &ldquo;show me all dunks&rdquo; · &ldquo;highlight reel for #23&rdquo; · &ldquo;every block in Q4&rdquo;
                    </p>
                  </div>
                </div>
              )}
              {messages.map((msg) => (
                <MessageRow
                  key={msg.id}
                  message={msg}
                  onJobSettled={handleJobSettled}
                  onOpenClips={(job, clips) => setViewer({ job, clips })}
                />
              ))}
              <div ref={bottomRef} />
            </div>

            <PromptInput
              disabled={activeJob || isAwaiting}
              disabledReason={activeJob ? "Processing..." : undefined}
              onSubmit={(opts) => void handleSubmit(opts)}
            />
          </>
        )}
      </div>

      {/* Clip viewer panel — resizable, desktop only */}
      {viewer && (
        <div
          className="relative hidden shrink-0 lg:flex lg:flex-col"
          style={{ width: `${viewerWidth}px`, minWidth: `${VIEWER_MIN_WIDTH}px`, maxWidth: `${VIEWER_MAX_WIDTH}px` }}
        >
          {/* Drag handle — sits on the left edge */}
          <div
            onMouseDown={onResizeMouseDown}
            className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize bg-transparent hover:bg-blue-500/40 transition-colors"
            title="Drag to resize"
          />
          <ClipViewer
            job={viewer.job}
            clips={viewer.clips}
            onClose={() => setViewer(null)}
          />
        </div>
      )}

      {/* Mobile clip viewer overlay */}
      {viewer && (
        <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950 lg:hidden">
          <ClipViewer
            job={viewer.job}
            clips={viewer.clips}
            onClose={() => setViewer(null)}
          />
        </div>
      )}
    </div>
  );
}
