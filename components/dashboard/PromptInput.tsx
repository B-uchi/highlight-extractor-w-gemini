"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Send, ChevronDown, Plus, X } from "lucide-react";

import { DEFAULT_PROCESSING_ACTIONS } from "@/lib/defaultActions";

interface PromptInputProps {
  disabled: boolean;
  disabledReason?: string;
  onSubmit: (opts: { prompt: string; followUpSecs: number | null; clipLimit: number | null }) => void;
}

const CLIP_LIMIT_OPTIONS = [
  { label: "All clips", value: null },
  { label: "5 clips", value: 5 },
  { label: "10 clips", value: 10 },
  { label: "15 clips", value: 15 },
  { label: "20 clips", value: 20 },
];

// Matches [Word] or [Multiple Words] — unfilled template placeholders
const PLACEHOLDER_RE = /\[([A-Za-z][A-Za-z\s]*)\]/g;

export function PromptInput({ disabled, disabledReason, onSubmit }: PromptInputProps) {
  const [prompt, setPrompt] = useState("");
  const [followUp, setFollowUp] = useState(false);
  const [followUpSecs, setFollowUpSecs] = useState(3);
  const [clipLimit, setClipLimit] = useState<number | null>(null);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const presetsRef = useRef<HTMLDivElement>(null);

  // Unique unfilled placeholders in current textarea value
  const unfilled = useMemo(
    () => [...new Set([...prompt.matchAll(PLACEHOLDER_RE)].map((m) => m[0]))],
    [prompt],
  );

  // Close popover on outside click
  useEffect(() => {
    if (!presetsOpen) return;
    function onDown(e: MouseEvent) {
      if (presetsRef.current && !presetsRef.current.contains(e.target as Node)) {
        setPresetsOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [presetsOpen]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    const trimmed = prompt.trim();
    if (!trimmed || disabled) return;
    onSubmit({ prompt: trimmed, followUpSecs: followUp ? followUpSecs : null, clipLimit });
    setPrompt("");
  }

  function applyPreset(template: string) {
    setPrompt(template);
    setPresetsOpen(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  return (
    <div className="border-t border-zinc-800/60 bg-zinc-950 px-4 py-3">
      <div className="relative mx-auto max-w-2xl space-y-2">

        {/* Preset popover */}
        {presetsOpen && (
          <div
            ref={presetsRef}
            className="absolute bottom-full left-0 right-0 z-10 mb-2 rounded-xl border border-zinc-700 bg-zinc-900 shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
              <span className="text-xs font-medium text-zinc-400">Prompt presets</span>
              <button
                type="button"
                onClick={() => setPresetsOpen(false)}
                className="text-zinc-600 hover:text-zinc-400 transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <ul className="py-1">
              {DEFAULT_PROCESSING_ACTIONS.map((action) => (
                <li key={action.id}>
                  <button
                    type="button"
                    onClick={() => applyPreset(action.promptTemplate)}
                    className="w-full px-3 py-2.5 text-left transition-colors hover:bg-zinc-800/60"
                  >
                    <p className="text-sm text-zinc-200">{action.title}</p>
                    <p className="mt-0.5 text-xs text-zinc-500">{action.description}</p>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Textarea */}
        <div className={`relative rounded-xl ring-1 transition-colors ${disabled ? "ring-zinc-800 bg-zinc-900/40" : "ring-zinc-700 bg-zinc-900 focus-within:ring-blue-500/50"}`}>
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder={disabledReason ?? "Ask for highlights — e.g. \"show me all dunks\" or \"highlight reel for #23\""}
            rows={2}
            className="w-full resize-none rounded-xl bg-transparent px-4 py-3 pr-12 text-sm text-zinc-100 placeholder-zinc-600 outline-none disabled:cursor-not-allowed"
          />
          <button
            type="button"
            onClick={submit}
            disabled={disabled || !prompt.trim()}
            className="absolute bottom-2.5 right-2.5 flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500 text-white transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-30"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Unfilled placeholder chips */}
        {unfilled.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-zinc-600">Fill in:</span>
            {unfilled.map((token) => (
              <span
                key={token}
                className="rounded-md bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-400 ring-1 ring-amber-500/30"
              >
                {token}
              </span>
            ))}
          </div>
        )}

        {/* Options row */}
        {!disabled && (
          <div className="flex flex-wrap items-center gap-3">
            {/* Preset toggle */}
            <button
              type="button"
              onClick={() => setPresetsOpen(!presetsOpen)}
              className={`flex items-center gap-1 text-xs transition-colors ${presetsOpen ? "text-blue-400" : "text-zinc-500 hover:text-zinc-300"}`}
            >
              <Plus className="h-3 w-3" />
              Preset
            </button>

            {/* Follow-up toggle */}
            <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-500">
              <input
                type="checkbox"
                checked={followUp}
                onChange={(e) => setFollowUp(e.target.checked)}
                className="accent-blue-500"
              />
              Include follow-up
              {followUp && (
                <>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={followUpSecs}
                    onChange={(e) => setFollowUpSecs(Math.max(1, Math.min(30, Number(e.target.value))))}
                    className="w-10 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-center text-xs text-zinc-300 outline-none focus:ring-1 focus:ring-blue-500/50"
                  />
                  <span>sec</span>
                </>
              )}
            </label>

            {/* Clip limit */}
            <div className="relative flex items-center gap-1.5">
              <label className="text-xs text-zinc-500">Clips:</label>
              <div className="relative">
                <select
                  value={clipLimit ?? "null"}
                  onChange={(e) => setClipLimit(e.target.value === "null" ? null : Number(e.target.value))}
                  className="appearance-none rounded border border-zinc-700 bg-zinc-900 py-0.5 pl-2 pr-6 text-xs text-zinc-300 outline-none focus:ring-1 focus:ring-blue-500/50"
                >
                  {CLIP_LIMIT_OPTIONS.map((opt) => (
                    <option key={String(opt.value)} value={opt.value ?? "null"}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-1.5 top-1 h-3 w-3 text-zinc-600" />
              </div>
            </div>

            <p className="ml-auto text-[10px] text-zinc-700">Enter to send · Shift+Enter for newline</p>
          </div>
        )}
      </div>
    </div>
  );
}
