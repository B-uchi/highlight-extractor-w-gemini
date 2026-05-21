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
 * Canonical copy used when users pick default processing actions from the dashboard.
 * Placeholders `[Team Highlight Name]`, `[Player Name]`, `[Jersey Number]` are swapped when preset fields are filled (otherwise left literal for the agent or API to specialize).
 */
export const DEFAULT_PROCESSING_ACTIONS: DefaultProcessingActionDefinition[] = [
  {
    id: "player_identification",
    title: "Player Identification",
    description:
      "Chunked visual analysis with roster/context — excludes full-game biometric tracking guarantees.",
    promptTemplate: `Player / identity identification (critical context):
- Each model call observes only short video clips, never the continuous game feed in one inference.
- Roster jerseys, heights, accessory notes, photos, or user descriptions are probabilistic priors — not cryptographic proof across cuts, substitutions, fouls out, obscured jerseys, distant cameras, washed-out numbers, towel heads, mirrored streams, duplicate numbers, wrong roster weeks, compression artifacts, intentional deception, stunt doubles, mascot confusion, meme edits, CGI, recap footage intercut with live gameplay, referee bodies blocking digits, swapped feeds, swapped teams, halftime outfit changes.
- Maintain honest visibility: populate playerJersey / playerName only when visibly grounded during that window; omit or downgrade score when occlusion or ambiguity dominates.
- If user references “full scan” roster expectations, prioritize consistent kit colors + plausible jersey reads and explain uncertainty succinctly.`,
  },
  {
    id: "highlight_events",
    title: "Highlight Event Detection",
    description: "Breadth of plausible highlight classes to catch game story beats and human moments.",
    promptTemplate: `Highlight event detection — consider (non-exhaustive):
Sports / competition: explosive scores, steals, turnovers, chasedown blocks, open-field breaks, nutmegs/dribble beats, goalie saves, spikes/aces/service winners, knockout counters, comeback swings, rivalry jawing, benches erupting.
Broadcast / hype: trophy reveals, countdown hits, MVP chants, walk-up intros, ceremonial moments.
Talk / podcast / interview: witty punchlines, sharp rebuttals, surprising admissions, argument peaks, applause/laughter storms, mic-drop tone shifts.
Education / demos: paradigm shifts (“aha” beats), slick visual reveals, catastrophic fails that teach.
Prefer distinct narrative peaks; discard generic filler unless anchored by unusually strong visuals or transcript punch.`,
  },
  {
    id: "team_highlight",
    title: "Team-Based Highlight ([Team Highlight Name])",
    description:
      "Momentum edit for one club — placeholders filled from the presets panel `[Team Highlight Name]` (falls back left as bracket text).",
    promptTemplate: `Team-centric highlight reel brief for **[Team Highlight Name]**:
1) First pick sequences where team identity is visibly readable (kits, sidelines, scorer graphics, coherent camera color bias).
2) Emphasize **runs / swings / defensive stands / transition bursts** telling a team story—not isolated random scores from unclear angles.
3) Include bench/coach reactions only when tightly coupled to meaningful team momentum swings.
4) When another team dominates a stretch, shorten or downgrade unless it sets up **[Team Highlight Name]**'s answer.
5) Keep titles short and declare team tag when grounded.`,
  },
  {
    id: "individual_player_highlight",
    title: "Individual Player Highlight",
    description: "Isolation brief with `[Player Name]` / `[Jersey Number]` substitutions from preset fields.",
    promptTemplate: `Individual player reel for **[Player Name]** (jersey **#[Jersey Number]** priority when visible):
- Score meaningful offensive touches **and** impactful defensive rotations, boards, steals, hustle saves, inbound IQ, communicator leadership if visually obvious.
- If the jersey is obstructed mid-play, widen context slightly ONLY when continuity still plausibly follows the primary subject; otherwise reduce score and explain visibility honesty.
- Deprioritize incidental crowd shots lacking clear player involvement.`,
  },
  {
    id: "clip_quality_rules",
    title: "Clip Quality Rules",
    description: "Edit hygiene for watchable standalone clips.",
    promptTemplate: `Clip quality hygiene:
- Windows should feel **watchable standalone** (~20-90s ideally) with clean story beats—not mid-sentence hard cuts unless irony demands it.
- Avoid dead filler pre-roll unless building deliberate tension rewarded within the clip.
- Favor sharper exposure, stabilized framing, and readable captions/graphics aiding context.
- If audio is muddy, lean on unmistakable visuals or transcript corroboration; flag weakness in reason.`,
  },
  {
    id: "ranking_prompt",
    title: "Ranking Prompt",
    description: "Heuristic blend for comparative scoring.",
    promptTemplate: `Ranking & tie-break intuition:
Combine **novelty**, **spectacle/emotion**, **narrative closure**, **clarity**, and **rarity** vs repetitive similar moments.
Prefer fewer, stronger clips over many borderline echoes.
Sporting plays: elevate game-altering swings, iconic skill bursts, contagious bench energy.`,
  },
  {
    id: "output_prompt",
    title: "Output Prompt",
    description: "How to annotate each highlight blob for downstream UI + editors.",
    promptTemplate: `Output rigor:
- Return machine-parseable arrays of highlight objects respecting schema (timestamps absolute to source media).
- Titles ≤ ~8 words, punchy, no spoiler spam unless payoff earned.
- reason: 2–4 sentences bridging **why** this beat matters vs neighbors.
- eventType/category/tags should be specific (not just "highlight") when evidence supports.`,
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
): string {
  if (!placeholders) {
    return rawTemplate;
  }
  let text = rawTemplate;
  if (placeholders.teamHighlightName?.trim()) {
    text = text.split("[Team Highlight Name]").join(placeholders.teamHighlightName.trim());
  }
  if (placeholders.primaryPlayerName?.trim()) {
    text = text.split("[Player Name]").join(placeholders.primaryPlayerName.trim());
  }
  if (placeholders.primaryJerseyNumber?.trim()) {
    text = text.split("[Jersey Number]").join(placeholders.primaryJerseyNumber.trim());
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
    const body = applyPresetPlaceholders(definition.promptTemplate, placeholders ?? null);
    return [`### ${definition.title}`, body.trim()].join("\n");
  });

  return ["── Default processing presets ──", "", ...blocks].join("\n");
}

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

  return parts.join("\n\n────────\n\n");
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
        }
      : undefined;

  const hasAnyPlaceholder =
    placeholders &&
    (Boolean(placeholders.teamHighlightName?.length) ||
      Boolean(placeholders.primaryPlayerName?.length) ||
      Boolean(placeholders.primaryJerseyNumber?.length));

  return ids.length === 0 && !hasAnyPlaceholder
    ? null
    : {
        ...(ids.length ? { selectedIds: ids } : { selectedIds: [] }),
        ...(hasAnyPlaceholder && placeholders ? { placeholders } : {}),
    };
}
