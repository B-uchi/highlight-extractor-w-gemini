import {
  normalizeProcessingPresetsState,
} from "@/lib/defaultActions";
import { parsePlayerFocusSpec } from "@/lib/playerFocus";
import type { HighlightClipLimitChoice, PlayerFocusSpec, ProcessingPresetsState } from "@/lib/types";

export function flattenPlayerFocusSpec(spec: PlayerFocusSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {
    teamAName: spec.teamAName,
    jerseyColors: spec.jerseyColors,
  };

  if (spec.identificationPrompt !== undefined && spec.identificationPrompt.trim()) {
    out.identificationPrompt = spec.identificationPrompt.trim();
  }
  if (spec.roster?.length) {
    out.roster = spec.roster;
  }
  if (spec.primaryTarget) {
    out.primaryTarget = spec.primaryTarget;
  }

  return out;
}

function parseHighlightClipLimitRaw(raw: unknown): HighlightClipLimitChoice | undefined {
  if (raw === null || raw === "null") {
    return null;
  }
  if (raw === undefined) {
    return undefined;
  }
  if (raw === "unlimited") {
    return null;
  }
  if (typeof raw === "number" && (raw === 5 || raw === 10 || raw === 15)) {
    return raw;
  }
  if (typeof raw === "string") {
    const n = Number(raw);
    if (n === 5 || n === 10 || n === 15) {
      return n;
    }
  }
  return undefined;
}

export function parseConversationTargetingBlob(raw: unknown): {
  playerFocus: PlayerFocusSpec | null;
  processingPresets: ProcessingPresetsState | null;
  highlightClipLimit?: HighlightClipLimitChoice;
} {
  if (raw == null || typeof raw !== "object") {
    return {
      playerFocus: null,
      processingPresets: null,
    };
  }

  const record = raw as Record<string, unknown>;
  let processingPresets: ProcessingPresetsState | null = null;
  const nested = record.processingPresets;
  if (nested != null && typeof nested === "object") {
    processingPresets = normalizeProcessingPresetsState(nested as ProcessingPresetsState);
  }

  const playerFocus = parsePlayerFocusSpec(raw) ?? null;

  let highlightClipLimit: HighlightClipLimitChoice | undefined;
  const limitRaw = record.highlightClipLimit;
  if ("highlightClipLimit" in record) {
    highlightClipLimit = parseHighlightClipLimitRaw(limitRaw);
  }

  const out = { playerFocus, processingPresets };
  return highlightClipLimit !== undefined ? { ...out, highlightClipLimit } : out;
}

export function serializeConversationTargetingBlob(
  playerFocus: PlayerFocusSpec | null,
  processingPresets: ProcessingPresetsState | null,
): Record<string, unknown> | null {
  const normalizedPresets = normalizeProcessingPresetsState(processingPresets);
  const doc: Record<string, unknown> = {};

  if (playerFocus) {
    Object.assign(doc, flattenPlayerFocusSpec(playerFocus));
  }
  if (normalizedPresets) {
    doc.processingPresets = normalizedPresets;
  }

  return Object.keys(doc).length > 0 ? doc : null;
}

export function mergeConversationTargetingBlob(
  currentBlob: unknown,
  patch: {
    playerFocus?: PlayerFocusSpec | null;
    processingPresets?: ProcessingPresetsState | null;
    highlightClipLimit?: HighlightClipLimitChoice | null;
  },
): Record<string, unknown> | null {
  const parsed = parseConversationTargetingBlob(currentBlob);
  const nextFocus = patch.playerFocus !== undefined ? patch.playerFocus : parsed.playerFocus;
  const nextPresets = patch.processingPresets !== undefined ? patch.processingPresets : parsed.processingPresets;
  const nextLimit =
    patch.highlightClipLimit !== undefined ? patch.highlightClipLimit : parsed.highlightClipLimit;
  const doc = serializeConversationTargetingBlob(nextFocus, nextPresets ?? null);
  if (!doc && nextLimit === undefined) {
    return null;
  }
  const base = doc ? { ...doc } : {};
  if (nextLimit !== undefined && nextLimit !== null) {
    base.highlightClipLimit = nextLimit;
  } else if (nextLimit === null) {
    base.highlightClipLimit = null;
  }
  return Object.keys(base).length > 0 ? base : null;
}
