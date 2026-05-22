import type { ProcessingPresetsPlaceholders, ProcessingPresetsState } from "@/lib/types";

export const PROCESSING_ACTION_IDS = [
  "player_identification",
  "highlight_events",
  "team_highlight",
  "individual_player_highlight",
  "clip_quality_rules",
  "ranking_prompt",
  "output_prompt",
] as const;

export type ProcessingActionId = (typeof PROCESSING_ACTION_IDS)[number];

export interface DefaultProcessingActionDefinition {
  id: ProcessingActionId;
  title: string;
  description: string;
  promptTemplate: string;
}

/** Stable order for merging combined prompts regardless of checkbox click order */
const ORDER_INDEX: Record<string, number> = Object.fromEntries(PROCESSING_ACTION_IDS.map((id, index) => [id, index]));

/**
 * Default processing actions — prompt text matches the product brief verbatim (see docs).
 * Substitution: `Triple Threat Athletics`, `[Player Name]`, `[Number]`, `[Jersey Number]`, `[Team Name]`, `[jersey color]` when preset fields are set.
 */
export const DEFAULT_PROCESSING_ACTIONS: DefaultProcessingActionDefinition[] = [
  {
    id: "player_identification",
    title: "Player Identification Prompt",
    description: "Full-game identity brief, required/optional inputs, and example line.",
    promptTemplate: `Prompt:

"Scan the full game video and identify every player from Team A using jersey color, jersey number, player roster, and uniform design. Track each player throughout the game, even when they move off-ball, are partially blocked, or switch sides of the court."

Required inputs:

Team name
Jersey color
Player number
Player name
Optional: player photo/headshot
Optional: height/body profile
Optional: shoe/sleeve/accessory identifiers

Example:

"Find and track Player #3 on the black Triple Threat Athletics team. Isolate all possessions where #3 is involved in the play, including scoring, assists, rebounds, steals, blocks, defensive stops, ball handling, and transition plays."`,
  },
  {
    id: "highlight_events",
    title: "Highlight Event Detection Prompt",
    description: "Basketball events where the player makes a positive impact.",
    promptTemplate: `Prompt:

"Create a highlight reel for each player by detecting basketball events where the player makes a positive impact."

Events to pull:

Made 3-point shots
Made jump shots
Layups
Finishes through contact
Dunks
Assists
Hockey assists / pass leading to score
Rebounds
Steals
Blocks
Defensive stops
Deflections
Fast breaks
Ball handling / breakdowns
Good passes
Hustle plays
Charges taken
And-1 plays`,
  },
  {
    id: "team_highlight",
    title: "Team-Based Highlight Prompt",
    description: "Team film brief; preset “Team name” replaces Triple Threat Athletics when filled.",
    promptTemplate: `Prompt:

"Create a team highlight film for Triple Threat Athletics. Prioritize clips where our team scores, forces turnovers, gets stops, moves the ball well, plays in transition, or shows high-energy team basketball."`,
  },
  {
    id: "individual_player_highlight",
    title: "Individual Player Highlight Prompt",
    description: "60–90s reel; panel fields substitute [Player Name], #[Number], [Team Name], [jersey color].",
    promptTemplate: `Prompt:

"Create a 60–90 second highlight video for [Player Name], jersey #[Number], on [Team Name], wearing [jersey color]. Pull only positive plays where this player is clearly involved. Include 1 second before the play develops and 2 seconds after the play ends."`,
  },
  {
    id: "clip_quality_rules",
    title: "Clip Quality Rules",
    description: "Visibility, meaning, and negative filters.",
    promptTemplate: `Prompt:

"Only select clips where the player is clearly visible, the action is meaningful, and the play result is positive. Remove dead time, inbound delays, free throws unless they complete an and-1, and clips where the player is not clearly identifiable."`,
  },
  {
    id: "ranking_prompt",
    title: "Ranking Prompt",
    description: "Explicit highlight-value ordering.",
    promptTemplate: `Prompt:

"Rank clips by highlight value using this order: dunks, blocks, steals leading to points, made threes, assists, tough finishes, transition plays, rebounds, defensive stops, hustle plays."`,
  },
  {
    id: "output_prompt",
    title: "Output Prompt",
    description: "Export/label format with example lines.",
    promptTemplate: `Prompt:

"Export clips by player name and jersey number. Label each clip with player, event type, timestamp, and confidence score. Create both raw clips and a finished highlight reel."

Example output:

Bryn Amiwero #3 — Made 3PT — 04:22 — 92% confidence
Bryn Amiwero #3 — Assist — 08:17 — 88% confidence
Bryn Amiwero #3 — Steal + Layup — 13:44 — 94% confidence`,
  },
];

const PROMPT_LOOKUP = Object.fromEntries(DEFAULT_PROCESSING_ACTIONS.map((definition) => [definition.id, definition]));

function sortSelectedIds(ids: string[]): ProcessingActionId[] {
  const unique = [...new Set(ids)];
  unique.sort((a, b) => (ORDER_INDEX[a] ?? 999) - (ORDER_INDEX[b] ?? 999));
  return unique.filter((id): id is ProcessingActionId => id in PROMPT_LOOKUP);
}

function applyPresetPlaceholders(
  rawTemplate: string,
  placeholders?: ProcessingPresetsPlaceholders | null,
  /** Only `team_highlight` should rewrite the literal organization name in the template */
  actionId?: ProcessingActionId,
): string {
  if (!placeholders) {
    return rawTemplate;
  }
  let text = rawTemplate;
  if (placeholders.teamHighlightName?.trim()) {
    const team = placeholders.teamHighlightName.trim();
    if (actionId === "team_highlight") {
      text = text.split("Triple Threat Athletics").join(team);
    }
    text = text.split("[Team Highlight Name]").join(team);
  }
  if (placeholders.primaryPlayerName?.trim()) {
    text = text.split("[Player Name]").join(placeholders.primaryPlayerName.trim());
  }
  const jersey = placeholders.primaryJerseyNumber?.trim();
  if (jersey) {
    text = text.split("[Number]").join(jersey);
    text = text.split("[Jersey Number]").join(jersey);
  }
  if (placeholders.individualTeamName?.trim()) {
    text = text.split("[Team Name]").join(placeholders.individualTeamName.trim());
  }
  if (placeholders.jerseyColor?.trim()) {
    text = text.split("[jersey color]").join(placeholders.jerseyColor.trim());
  }
  return text;
}

/**
 * Concatenate selected presets into one block suitable for Gemini highlight criteria insertion.
 */
export function buildCombinedPrompt(
  selectedIds: string[],
  placeholders?: ProcessingPresetsPlaceholders | null,
): string {
  const sorted = sortSelectedIds(selectedIds);
  if (!sorted.length) {
    return "";
  }

  const blocks = sorted.map((id) => {
    const definition = PROMPT_LOOKUP[id];
    const body = applyPresetPlaceholders(definition.promptTemplate, placeholders ?? null, id);
    return [`### ${definition.title}`, body.trim()].join("\n");
  });

  return ["── Default processing presets ──", "", ...blocks].join("\n");
}

/** Same separator as server-side merge — keep in sync when stripping preset blocks from the chat composer. */
export const PROCESSING_PRESET_USER_SEPARATOR = "\n\n────────\n\n";

export function mergeUserPromptWithPresetBlock(
  freeformPrompt?: string | null,
  presetBlock?: string | null,
): string | undefined {
  const freeform = typeof freeformPrompt === "string" ? freeformPrompt.trim() : "";
  const preset = typeof presetBlock === "string" ? presetBlock.trim() : "";

  const parts = [preset || undefined, freeform || undefined].filter(Boolean);

  // Preset-first so disclaimers/context land before narrower user tweaks.
  if (parts.length === 0) {
    return undefined;
  }

  return parts.join(PROCESSING_PRESET_USER_SEPARATOR);
}

/**
 * Remove the last injected preset block (and the standard separator before following free text) from composer text.
 */
export function stripLastInjectedPresetFromComposer(full: string, lastBlock: string | null): string {
  if (!lastBlock) {
    return full;
  }
  const idx = full.indexOf(lastBlock);
  if (idx === -1) {
    return full;
  }
  const before = full.slice(0, idx);
  let after = full.slice(idx + lastBlock.length);
  if (after.startsWith(PROCESSING_PRESET_USER_SEPARATOR)) {
    after = after.slice(PROCESSING_PRESET_USER_SEPARATOR.length);
  } else {
    after = after.replace(/^(\n\n)+/, "");
  }
  return (before + after).trim();
}

/**
 * Replace or append the merged preset block into the chat composer, preserving user free text below the standard separator.
 * See README (dashboard): text is only placed in the composer — not auto-sent.
 */
export function applyPresetBlockToComposerText(
  current: string,
  lastInjectedBlock: string | null,
  newPresetBlock: string,
): { next: string; nextLastBlock: string | null } {
  const trimmedCurrent = current.trimEnd();
  const trimmedNew = newPresetBlock.trimEnd();

  // No-op if the composer already ends with this exact merged block (avoids duplicate append on re-save).
  if (trimmedNew && trimmedCurrent.endsWith(trimmedNew)) {
    return { next: current, nextLastBlock: newPresetBlock || null };
  }

  const free = stripLastInjectedPresetFromComposer(current, lastInjectedBlock);
  const freeTrimmed = free.trim();
  const merged = mergeUserPromptWithPresetBlock(
    freeTrimmed.length ? freeTrimmed : null,
    newPresetBlock.length ? newPresetBlock : null,
  );

  return {
    next: merged ?? freeTrimmed,
    nextLastBlock: newPresetBlock.length ? newPresetBlock : null,
  };
}

/**
 * Merge dashboard presets (`base`) with an agent-supplied overlay.
 * Duplicate ids unify; placeholders from `overlay` win on conflicts.
 */
export function mergeProcessingPresetsState(
  base: ProcessingPresetsState | null | undefined,
  overlay: ProcessingPresetsState,
): ProcessingPresetsState | null {
  const normalizedOverlay = normalizeProcessingPresetsState(overlay);
  if (!normalizedOverlay) {
    return normalizeProcessingPresetsState(base);
  }

  const normalizedBase = normalizeProcessingPresetsState(base);
  const idSet = new Set<string>([...(normalizedBase?.selectedIds ?? []), ...(normalizedOverlay.selectedIds ?? [])]);

  const mergedPlaceholdersRaw: ProcessingPresetsPlaceholders = {
    ...normalizedBase?.placeholders,
    ...normalizedOverlay.placeholders,
  };

  const mergedPlaceholders: ProcessingPresetsPlaceholders = {
    ...(mergedPlaceholdersRaw.teamHighlightName?.trim()
      ? { teamHighlightName: mergedPlaceholdersRaw.teamHighlightName.trim() }
      : {}),
    ...(mergedPlaceholdersRaw.primaryPlayerName?.trim()
      ? { primaryPlayerName: mergedPlaceholdersRaw.primaryPlayerName.trim() }
      : {}),
    ...(mergedPlaceholdersRaw.primaryJerseyNumber?.trim()
      ? { primaryJerseyNumber: mergedPlaceholdersRaw.primaryJerseyNumber.trim() }
      : {}),
    ...(mergedPlaceholdersRaw.individualTeamName?.trim()
      ? { individualTeamName: mergedPlaceholdersRaw.individualTeamName.trim() }
      : {}),
    ...(mergedPlaceholdersRaw.jerseyColor?.trim()
      ? { jerseyColor: mergedPlaceholdersRaw.jerseyColor.trim() }
      : {}),
  };

  return normalizeProcessingPresetsState({
    selectedIds: sortSelectedIds([...idSet]),
    ...(Object.keys(mergedPlaceholders).length ? { placeholders: mergedPlaceholders } : {}),
  });
}

export function normalizeProcessingPresetsState(raw: ProcessingPresetsState | null | undefined): ProcessingPresetsState | null {
  if (!raw) {
    return null;
  }
  const ids = sortSelectedIds(raw.selectedIds ?? []);
  const ph = raw.placeholders;
  const placeholders: ProcessingPresetsPlaceholders | undefined =
    ph && typeof ph === "object"
      ? {
          ...(typeof ph.teamHighlightName === "string" ? { teamHighlightName: ph.teamHighlightName.trim() } : {}),
          ...(typeof ph.primaryPlayerName === "string" ? { primaryPlayerName: ph.primaryPlayerName.trim() } : {}),
          ...(typeof ph.primaryJerseyNumber === "string" ? { primaryJerseyNumber: ph.primaryJerseyNumber.trim() } : {}),
          ...(typeof ph.individualTeamName === "string" ? { individualTeamName: ph.individualTeamName.trim() } : {}),
          ...(typeof ph.jerseyColor === "string" ? { jerseyColor: ph.jerseyColor.trim() } : {}),
        }
      : undefined;

  const hasAnyPlaceholder =
    placeholders &&
    (Boolean(placeholders.teamHighlightName?.length) ||
      Boolean(placeholders.primaryPlayerName?.length) ||
      Boolean(placeholders.primaryJerseyNumber?.length) ||
      Boolean(placeholders.individualTeamName?.length) ||
      Boolean(placeholders.jerseyColor?.length));

  return ids.length === 0 && !hasAnyPlaceholder
    ? null
    : {
        ...(ids.length ? { selectedIds: ids } : { selectedIds: [] }),
        ...(hasAnyPlaceholder && placeholders ? { placeholders } : {}),
    };
}
