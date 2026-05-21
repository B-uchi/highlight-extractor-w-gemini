"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Send } from "lucide-react";

import { parseSseStream } from "@/lib/client/sse";
import { DEFAULT_PROCESSING_ACTIONS } from "@/lib/defaultActions";
import { formatDurationMs } from "@/lib/format";
import type {
  AgentTaskRecord,
  ChatMessageRecord,
  ConversationRecord,
  GeneratedClip,
  Highlight,
  JobState,
  ProcessingPresetsState,
} from "@/lib/types";

function stageLabel(stage: string): string {
  switch (stage) {
    case "queued":
      return "Queued";
    case "extracting_audio":
      return "Extracting audio";
    case "chunking_audio":
      return "Chunking audio";
    case "transcribing":
      return "Transcribing";
    case "ranking":
      return "Finding highlights";
    case "cutting":
      return "Cutting clips";
    case "done":
      return "Done";
    case "error":
      return "Error";
    default:
      return stage;
  }
}

export function ConversationWorkspace({ conversationId }: { conversationId: string }) {
  const [conversation, setConversation] = useState<ConversationRecord | null>(null);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [agentTasks, setAgentTasks] = useState<AgentTaskRecord[]>([]);
  const [job, setJob] = useState<JobState | null>(null);

  const [input, setInput] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [streamingAssistant, setStreamingAssistant] = useState("");

  const [uploadBusy, setUploadBusy] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);

  const [presetSelectedIds, setPresetSelectedIds] = useState<string[]>([]);
  const [teamHighlightTemplate, setTeamHighlightTemplate] = useState("");
  const [individualPlayerNameTemplate, setIndividualPlayerNameTemplate] = useState("");
  const [individualJerseyTemplate, setIndividualJerseyTemplate] = useState("");
  const [presetsBusy, setPresetsBusy] = useState(false);

  const [eventFilter, setEventFilter] = useState("all");
  const [minScoreFilter, setMinScoreFilter] = useState(0);
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [reelBlobUrl, setReelBlobUrl] = useState<string | null>(null);
  const [isBuildingReel, setIsBuildingReel] = useState(false);

  const loadConversation = useCallback(async () => {
    const res = await fetch(`/api/conversations/${conversationId}`);
    const payload = (await res.json()) as {
      conversation?: ConversationRecord;
      messages?: ChatMessageRecord[];
      agentTasks?: AgentTaskRecord[];
      job?: JobState | null;
      error?: string;
    };
    if (!res.ok) {
      setPageError(payload.error ?? "Could not load conversation.");
      return;
    }
    setPageError(null);
    setConversation(payload.conversation ?? null);
    setMessages(payload.messages ?? []);
    setAgentTasks(payload.agentTasks ?? []);
    setJob(payload.job ?? null);

    const savedPresets = payload.conversation?.processingPresets;
    setPresetSelectedIds(savedPresets?.selectedIds ?? []);
    const placeholders = savedPresets?.placeholders ?? {};
    setTeamHighlightTemplate(
      typeof placeholders.teamHighlightName === "string" ? placeholders.teamHighlightName : "",
    );
    setIndividualPlayerNameTemplate(
      typeof placeholders.primaryPlayerName === "string" ? placeholders.primaryPlayerName : "",
    );
    setIndividualJerseyTemplate(
      typeof placeholders.primaryJerseyNumber === "string" ? placeholders.primaryJerseyNumber : "",
    );
  }, [conversationId]);

  useEffect(() => {
    queueMicrotask(() => {
      void loadConversation();
    });
  }, [loadConversation]);

  useEffect(() => {
    const jid = conversation?.activeJobId;
    if (!jid) {
      return;
    }

    const stream = new EventSource(`/api/status/${jid}/stream`);
    stream.onmessage = (event) => {
      const payload = JSON.parse(event.data) as JobState;
      setJob(payload);
    };
    stream.onerror = () => {
      stream.close();
    };

    return () => {
      stream.close();
    };
  }, [conversation?.activeJobId]);

  const uniqueEventTypes = useMemo(() => {
    const types = new Set<string>();
    (job?.highlights ?? []).forEach((h) => {
      if (h.eventType) {
        types.add(h.eventType);
      }
    });
    (job?.clips ?? []).forEach((c) => {
      if (c.eventType) {
        types.add(c.eventType);
      }
    });
    return Array.from(types).sort();
  }, [job?.clips, job?.highlights]);

  const filteredHighlights: Highlight[] = useMemo(() => {
    const highlights = job?.highlights ?? [];
    return highlights.filter((h) => {
      if (h.score < minScoreFilter) {
        return false;
      }
      if (eventFilter !== "all") {
        const et = (h.eventType ?? "").toLowerCase();
        if (!et.includes(eventFilter.toLowerCase())) {
          return false;
        }
      }
      return true;
    });
  }, [eventFilter, job?.highlights, minScoreFilter]);

  const filteredClips: GeneratedClip[] = useMemo(() => {
    const clips = job?.clips ?? [];
    return clips.filter((c) => {
      if (c.score < minScoreFilter) {
        return false;
      }
      if (eventFilter !== "all") {
        const et = (c.eventType ?? "").toLowerCase();
        if (!et.includes(eventFilter.toLowerCase())) {
          return false;
        }
      }
      return true;
    });
  }, [eventFilter, job?.clips, minScoreFilter]);

  const presetPayloadForPersist = useCallback((): ProcessingPresetsState | null => {
    const team = teamHighlightTemplate.trim();
    const player = individualPlayerNameTemplate.trim();
    const jersey = individualJerseyTemplate.trim();
    const placeholders =
      team || player || jersey
        ? {
            ...(team ? { teamHighlightName: team } : {}),
            ...(player ? { primaryPlayerName: player } : {}),
            ...(jersey ? { primaryJerseyNumber: jersey } : {}),
          }
        : undefined;

    const body: ProcessingPresetsState = {
      selectedIds: presetSelectedIds,
      ...(placeholders ? { placeholders } : {}),
    };

    return presetSelectedIds.length > 0 || Boolean(placeholders) ? body : null;
  }, [
    presetSelectedIds,
    teamHighlightTemplate,
    individualPlayerNameTemplate,
    individualJerseyTemplate,
  ]);

  const showTeamPresetFields = presetSelectedIds.includes("team_highlight");
  const showIndividualPresetFields = presetSelectedIds.includes("individual_player_highlight");

  const persistProcessingPresets = async (presetBody: ProcessingPresetsState | null) => {
    setPresetsBusy(true);
    setChatError(null);
    try {
      const res = await fetch(`/api/conversations/${conversationId}/targeting`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ processingPresets: presetBody }),
      });
      const payload = (await res.json()) as { error?: string };
      if (!res.ok) {
        setChatError(payload.error ?? "Could not save presets.");
        return;
      }
      await loadConversation();
    } finally {
      setPresetsBusy(false);
    }
  };

  const onTogglePreset = (presetId: string) => {
    setPresetSelectedIds((prev) =>
      prev.includes(presetId) ? prev.filter((id) => id !== presetId) : [...prev, presetId],
    );
  };

  const onPresetsSave = async () => {
    await persistProcessingPresets(presetPayloadForPersist());
  };

  const onPresetSelectAll = () => {
    setPresetSelectedIds(DEFAULT_PROCESSING_ACTIONS.map((a) => a.id));
  };

  const onPresetClearChecks = async () => {
    setPresetSelectedIds([]);
    setTeamHighlightTemplate("");
    setIndividualPlayerNameTemplate("");
    setIndividualJerseyTemplate("");
    await persistProcessingPresets(null);
  };

  const onUploadVideo = async (file: File | null) => {
    if (!file) {
      return;
    }
    setUploadBusy(true);
    setChatError(null);
    try {
      const formData = new FormData();
      formData.set("video", file);
      const res = await fetch(`/api/conversations/${conversationId}/upload`, {
        method: "POST",
        body: formData,
      });
      const payload = (await res.json()) as { error?: string };
      if (!res.ok) {
        setChatError(payload.error ?? "Upload failed.");
        return;
      }
      await loadConversation();
    } finally {
      setUploadBusy(false);
    }
  };

  const onSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isSending) {
      return;
    }

    setChatError(null);
    setIsSending(true);
    setStreamingAssistant("");

    const optimisticUser: ChatMessageRecord = {
      id: `local-${Date.now()}`,
      conversationId,
      role: "user",
      content: trimmed,
      metadata: null,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUser]);
    setInput("");

    let assistantText = "";

    try {
      const res = await fetch(`/api/conversations/${conversationId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: trimmed }),
      });

      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Chat failed (${res.status})`);
      }

      await parseSseStream(res, (eventName, data) => {
        if (eventName === "message_delta") {
          const chunk = data as { text?: string };
          assistantText += chunk.text ?? "";
          setStreamingAssistant(assistantText);
        }
      });

      await loadConversation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setChatError(message);
    } finally {
      setStreamingAssistant("");
      setIsSending(false);
    }
  };

  const onBuildReel = async () => {
    const jobId = conversation?.activeJobId;
    if (!jobId || selectedClipIds.length === 0) {
      return;
    }

    setIsBuildingReel(true);
    setReelBlobUrl(null);
    try {
      const res = await fetch(`/api/reel/${jobId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clipIds: selectedClipIds }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Reel build failed");
      }
      const blob = await res.blob();
      setReelBlobUrl(URL.createObjectURL(blob));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setChatError(message);
    } finally {
      setIsBuildingReel(false);
    }
  };

  const onToggleClip = (clipId: string) => {
    setSelectedClipIds((prev) => (prev.includes(clipId) ? prev.filter((id) => id !== clipId) : [...prev, clipId]));
  };

  if (pageError) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center">
          <p className="text-lg font-semibold text-zinc-100">Could not open conversation</p>
          <p className="mt-2 text-sm text-zinc-400">{pageError}</p>
          <Link className="mt-6 inline-block text-sm text-blue-400 underline" href="/dashboard">
            Back
          </Link>
        </div>
      </div>
    );
  }

  const previewJobId = conversation?.activeJobId;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-0 lg:grid-cols-12">
      <section className="flex min-h-0 flex-col border-zinc-800 lg:col-span-5 lg:border-r">
        <div className="border-b border-zinc-800 px-4 py-3">
          <p className="text-sm font-semibold text-zinc-100">{conversation?.title ?? "Conversation"}</p>
          <p className="mt-1 text-xs text-zinc-500">Chat with the agent, upload a video, and run processing.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-900">
              <input
                type="file"
                accept="video/*"
                className="hidden"
                disabled={uploadBusy}
                onChange={(e) => void onUploadVideo(e.target.files?.[0] ?? null)}
              />
              {uploadBusy ? "Uploading…" : "Upload video"}
            </label>
            {conversation?.pendingInputPath && (
              <span className="text-xs text-emerald-300">Video ready — ask the agent to start processing.</span>
            )}
          </div>
          <details className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-300">
            <summary className="cursor-pointer select-none font-medium text-zinc-200">Processing presets</summary>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
              Checked items prepend boilerplate hint text to the Gemini highlight ranking step (via{" "}
              <code className="text-zinc-400">userPrompt</code>). Use <strong>Save presets</strong> to persist choices
              on this conversation. For player or team specifics, describe them in chat (the agent merges them into{" "}
              <code className="text-zinc-400">start_processing</code>).
              See <span className="text-zinc-400">docs/DEFAULT_PROCESSING_PRESETS.md</span>.
            </p>
            <div className="mt-3 max-h-48 overflow-y-auto space-y-2 pr-1">
              {DEFAULT_PROCESSING_ACTIONS.map((preset) => (
                <label key={preset.id} className="flex cursor-pointer items-start gap-2 rounded-md border border-zinc-900/80 p-2 hover:bg-zinc-900/60">
                  <input
                    type="checkbox"
                    checked={presetSelectedIds.includes(preset.id)}
                    onChange={() => onTogglePreset(preset.id)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium text-zinc-200">{preset.title}</span>
                    <span className="mt-1 block text-[11px] text-zinc-500">{preset.description}</span>
                  </span>
                </label>
              ))}
            </div>
            {(showTeamPresetFields || showIndividualPresetFields) && (
              <div className="mt-3 grid gap-2 rounded-md border border-zinc-900/80 bg-black/40 p-2">
                {showTeamPresetFields && (
                  <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                    Team highlight label (fills <code>[Team Highlight Name]</code>)
                    <input
                      type="text"
                      value={teamHighlightTemplate}
                      onChange={(e) => setTeamHighlightTemplate(e.target.value)}
                      className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-zinc-200"
                      placeholder="e.g. Triple Threat Athletics"
                    />
                  </label>
                )}
                {showIndividualPresetFields && (
                  <>
                    <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                      Player name (<code>[Player Name]</code>)
                      <input
                        type="text"
                        value={individualPlayerNameTemplate}
                        onChange={(e) => setIndividualPlayerNameTemplate(e.target.value)}
                        className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-zinc-200"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-[11px] text-zinc-400">
                      Jersey (<code>[Jersey Number]</code>)
                      <input
                        type="text"
                        value={individualJerseyTemplate}
                        onChange={(e) => setIndividualJerseyTemplate(e.target.value)}
                        className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-zinc-200"
                      />
                    </label>
                  </>
                )}
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={presetsBusy}
                onClick={() => void onPresetsSave()}
                className="rounded-lg bg-blue-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-800 disabled:opacity-50"
              >
                {presetsBusy ? "Saving…" : "Save presets"}
              </button>
              <button
                type="button"
                disabled={presetsBusy}
                onClick={() => onPresetSelectAll()}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
              >
                Select all
              </button>
              <button
                type="button"
                disabled={presetsBusy}
                onClick={() => void onPresetClearChecks()}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
              >
                Clear presets
              </button>
            </div>
          </details>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="space-y-4">
            {messages.length === 0 && (
              <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-400">
                <p className="font-medium text-zinc-200">Get started</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  <li>Upload a video with the button above.</li>
                  <li>Optionally toggle <strong>Processing presets</strong> (team/player templates, disclaimers).</li>
                  <li>
                    Mention any player or team focus in chat if you want extra steering (for example jerseys, roster).
                  </li>
                  <li>
                    Ask the agent to start processing (for example: &quot;Find the funniest moments&quot;).
                  </li>
                  <li>Watch progress in the workspace, then refine or build a reel.</li>
                </ul>
              </div>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                className={m.role === "user" ? "ml-8 rounded-2xl bg-zinc-900 p-3 text-sm" : "mr-8 rounded-2xl bg-zinc-950 p-3 text-sm"}
              >
                <p className="whitespace-pre-wrap text-zinc-100">{m.content}</p>
              </div>
            ))}

            {isSending && (
              <div className="mr-8 rounded-2xl bg-zinc-950 p-3 text-sm text-zinc-200">
                <div className="flex items-center gap-2 text-zinc-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Thinking…
                </div>
                {streamingAssistant ? (
                  <p className="mt-3 whitespace-pre-wrap text-zinc-100">{streamingAssistant}</p>
                ) : null}
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-zinc-800 p-3">
          {chatError && (
            <div className="mb-2 rounded-lg border border-red-900 bg-red-950/40 p-2 text-xs text-red-200">
              {chatError}
            </div>
          )}
          <div className="flex gap-2">
            <textarea
              className="min-h-[44px] flex-1 resize-none rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-zinc-600"
              placeholder="Ask for highlights, refinements, explanations, or reels…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void onSend();
                }
              }}
            />
            <button
              type="button"
              onClick={() => void onSend()}
              disabled={isSending}
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              <Send className="h-4 w-4" />
              Send
            </button>
          </div>
        </div>
      </section>

      <section className="flex min-h-0 flex-col overflow-y-auto lg:col-span-7">
        <div className="border-b border-zinc-800 px-4 py-3">
          <p className="text-sm font-semibold">Workspace</p>
          <p className="mt-1 text-xs text-zinc-500">
            Live job updates stream here. Preview the source video when a job is active.
          </p>
        </div>

        <div className="space-y-4 px-4 py-4">
          {previewJobId && (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-sm font-semibold">Source video</p>
              <video className="mt-3 w-full rounded-xl" controls src={`/api/input/${previewJobId}`} />
            </div>
          )}

          {job && (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold">Pipeline</p>
                  <p className="mt-1 text-xs text-zinc-400">
                    Job <span className="font-mono text-zinc-200">{job.id}</span>
                  </p>
                </div>
                <span className="rounded-full border border-zinc-800 bg-zinc-950 px-2 py-1 text-xs text-zinc-300">
                  {stageLabel(job.stage)}
                </span>
              </div>

              <p className="mt-2 text-sm text-zinc-300">{job.message}</p>
              <div className="mt-3 h-2 w-full rounded-full bg-zinc-800">
                <div className="h-2 rounded-full bg-blue-500 transition-all" style={{ width: `${job.progress}%` }} />
              </div>

              {job.metrics && (
                <div className="mt-4 grid gap-1 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-sm text-zinc-300">
                  <p>
                    Time taken:{" "}
                    <span className="font-medium text-zinc-100">{formatDurationMs(job.metrics.durationMs)}</span>
                  </p>
                  <p>
                    Gemini tokens:{" "}
                    <span className="font-medium text-zinc-100">
                      in {job.metrics.ai.gemini.inputTokens} / out {job.metrics.ai.gemini.outputTokens} / total{" "}
                      {job.metrics.ai.gemini.totalTokens}
                    </span>
                  </p>
                  <p>
                    Category: <span className="font-medium text-zinc-100">{job.category ?? "—"}</span>
                  </p>
                </div>
              )}

              {job.stage === "error" && job.error && (
                <p className="mt-3 text-sm text-red-300">Error: {job.error}</p>
              )}
            </div>
          )}

          {agentTasks.length > 0 && (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-sm font-semibold">Agent tasks</p>
              <ul className="mt-3 space-y-2">
                {agentTasks.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-start justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2"
                  >
                    <div>
                      <p className="text-sm font-medium text-zinc-100">{t.label}</p>
                      <p className="text-xs text-zinc-500">{t.type}</p>
                      {t.detail && <p className="mt-1 text-xs text-zinc-400">{t.detail}</p>}
                    </div>
                    <div className="text-right">
                      <p className="text-xs uppercase text-zinc-400">{t.status}</p>
                      <div className="mt-1 h-1.5 w-24 rounded-full bg-zinc-800">
                        <div
                          className="h-1.5 rounded-full bg-emerald-500"
                          style={{ width: `${Math.max(0, Math.min(100, t.progress))}%` }}
                        />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(job?.highlights?.length ?? 0) > 0 && (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-sm font-semibold">Filters</p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm">
                  Event type
                  <select
                    className="rounded-lg border border-zinc-700 bg-zinc-950 p-2"
                    value={eventFilter}
                    onChange={(e) => setEventFilter(e.target.value)}
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
                    onChange={(e) => setMinScoreFilter(Number(e.target.value))}
                  />
                </label>
              </div>
            </div>
          )}

          {filteredHighlights.length > 0 && (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-sm font-semibold">Detected highlights ({filteredHighlights.length})</p>
              <div className="mt-4 grid gap-4">
                {filteredHighlights.map((highlight, index) => (
                  <article
                    key={`${highlight.startSec}-${highlight.endSec}-${index}`}
                    className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4"
                  >
                    <h3 className="text-base font-semibold text-zinc-100">{highlight.title}</h3>
                    <p className="mt-2 text-sm text-zinc-300">{highlight.reason}</p>
                    <p className="mt-2 text-sm text-zinc-400">
                      {highlight.startSec.toFixed(2)}s - {highlight.endSec.toFixed(2)}s (score{" "}
                      {highlight.score.toFixed(0)})
                    </p>
                    {(highlight.playerJersey || highlight.playerName || highlight.teamTag || highlight.visibilityNote) && (
                      <p className="mt-1 text-xs text-zinc-500">
                        {[highlight.playerName, highlight.playerJersey ? `#${highlight.playerJersey}` : null, highlight.teamTag, highlight.visibilityNote]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}
                  </article>
                ))}
              </div>
            </div>
          )}

          {filteredClips.length > 0 && (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4">
              <p className="text-sm font-semibold">Generated clips ({filteredClips.length})</p>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
                <button
                  type="button"
                  className="rounded-lg border border-zinc-700 px-3 py-1"
                  onClick={() => setSelectedClipIds(filteredClips.map((c) => c.id))}
                >
                  Select all (filtered)
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-zinc-700 px-3 py-1 disabled:opacity-60"
                  onClick={() => void onBuildReel()}
                  disabled={isBuildingReel || selectedClipIds.length === 0}
                >
                  {isBuildingReel ? "Building reel…" : "Build reel"}
                </button>
                <span className="text-zinc-400">{selectedClipIds.length} selected</span>
                {reelBlobUrl && (
                  <a className="text-blue-400 underline" href={reelBlobUrl} download={`${previewJobId}-reel.mp4`}>
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
                        Include
                      </label>
                    </div>
                    <p className="mt-1 text-sm text-zinc-400">
                      {clip.startSec.toFixed(2)}s - {clip.endSec.toFixed(2)}s (score {clip.score.toFixed(0)})
                    </p>
                    <video className="mt-3 w-full rounded-lg" controls src={clip.url} />
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
