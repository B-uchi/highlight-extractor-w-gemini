import {
  normalizeProcessingPresetsState,
} from "@/lib/defaultActions";
import { parsePlayerFocusSpec } from "@/lib/playerFocus";
import type { PlayerFocusSpec, ProcessingPresetsState } from "@/lib/types";

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

export function parseConversationTargetingBlob(raw: unknown): {
  playerFocus: PlayerFocusSpec | null;
  processingPresets: ProcessingPresetsState | null;
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

  return { playerFocus, processingPresets };
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
  patch: { playerFocus?: PlayerFocusSpec | null; processingPresets?: ProcessingPresetsState | null },
): Record<string, unknown> | null {
  const parsed = parseConversationTargetingBlob(currentBlob);
  const nextFocus = patch.playerFocus !== undefined ? patch.playerFocus : parsed.playerFocus;
  const nextPresets = patch.processingPresets !== undefined ? patch.processingPresets : parsed.processingPresets;
  return serializeConversationTargetingBlob(nextFocus, nextPresets ?? null);
}
