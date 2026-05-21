import type { PlayerFocusSpec } from "@/lib/types";

/**
 * Parses and validates a loose JSON object into {@link PlayerFocusSpec}.
 * Returns undefined if the payload is empty or not usable.
 */
export function parsePlayerFocusSpec(raw: unknown): PlayerFocusSpec | undefined {
  if (raw == null || typeof raw !== "object") {
    return undefined;
  }
  const o = raw as Record<string, unknown>;

  const teamAName = typeof o.teamAName === "string" ? o.teamAName.trim() : "";
  if (!teamAName) {
    return undefined;
  }

  const jerseyColors = Array.isArray(o.jerseyColors)
    ? o.jerseyColors.filter((c): c is string => typeof c === "string" && c.trim().length > 0).map((c) => c.trim())
    : typeof o.jerseyColors === "string" && o.jerseyColors.trim()
      ? o.jerseyColors.split(/[,;]+/).map((s) => s.trim()).filter(Boolean)
      : [];

  const identificationPrompt =
    typeof o.identificationPrompt === "string" && o.identificationPrompt.trim()
      ? o.identificationPrompt.trim()
      : undefined;

  const rosterRaw = o.roster;
  const roster: PlayerFocusSpec["roster"] = [];
  if (Array.isArray(rosterRaw)) {
    for (const entry of rosterRaw) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const e = entry as Record<string, unknown>;
      const jerseyNumber = typeof e.jerseyNumber === "string" ? e.jerseyNumber.trim() : "";
      if (!jerseyNumber) {
        continue;
      }
      roster.push({
        jerseyNumber,
        displayName: typeof e.displayName === "string" ? e.displayName.trim() : undefined,
        photoUrl: typeof e.photoUrl === "string" ? e.photoUrl.trim() : undefined,
        height: typeof e.height === "string" ? e.height.trim() : undefined,
        buildProfile: typeof e.buildProfile === "string" ? e.buildProfile.trim() : undefined,
        accessoryNotes: typeof e.accessoryNotes === "string" ? e.accessoryNotes.trim() : undefined,
      });
    }
  }

  const pt = o.primaryTarget;
  let primaryTarget: PlayerFocusSpec["primaryTarget"];
  if (pt && typeof pt === "object") {
    const p = pt as Record<string, unknown>;
    const jerseyNumber = typeof p.jerseyNumber === "string" ? p.jerseyNumber.trim() : "";
    if (jerseyNumber) {
      primaryTarget = {
        jerseyNumber,
        isolationPrompt:
          typeof p.isolationPrompt === "string" && p.isolationPrompt.trim() ? p.isolationPrompt.trim() : undefined,
      };
    }
  }

  return {
    teamAName,
    jerseyColors,
    ...(identificationPrompt ? { identificationPrompt } : {}),
    ...(roster.length ? { roster } : {}),
    ...(primaryTarget ? { primaryTarget } : {}),
  };
}

/**
 * Large, explicit instructions for Gemini chunk calls. This does **not** add true multi-object tracking
 * (that requires detectors + trackers — see next.md Phase 2). It steers the visual model when cues appear.
 */
export function buildPlayerFocusPromptSection(spec: PlayerFocusSpec): string {
  const rosterLines =
    spec.roster?.map((r) => {
      const bits = [
        `#${r.jerseyNumber}`,
        r.displayName,
        r.height,
        r.buildProfile,
        r.accessoryNotes,
        r.photoUrl ? "(photo URL provided for context — you only see pixels in this chunk)" : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      return `- ${bits}`;
    }) ?? [];

  const lines: string[] = [
    "",
    "─── Player / team targeting (critical) ───",
    `Focus team: "${spec.teamAName}".`,
    spec.jerseyColors.length
      ? `Jersey / uniform colors to match: ${spec.jerseyColors.join(", ")}.`
      : "Infer kit colors from roster context when possible.",
    "",
    "LIMITATIONS (must follow):",
    "- You only analyze short video segments, not the entire game in one pass.",
    "- You cannot guarantee identity through long occlusions, camera cuts, or backs to camera; be honest in `visibilityNote`.",
    "- Prefer highlight windows where jersey numbers / team colors are visible enough to justify the label.",
    "",
    spec.identificationPrompt
      ? `User instructions for identification / isolation:\n${spec.identificationPrompt}\n`
      : "",
    rosterLines.length
      ? ["Roster (prioritize these players when visible):", ...rosterLines, ""].join("\n")
      : "",
    spec.primaryTarget
      ? [
          `Primary target: #${spec.primaryTarget.jerseyNumber}.`,
          spec.primaryTarget.isolationPrompt
            ? `Isolation brief:\n${spec.primaryTarget.isolationPrompt}`
            : "Isolate their meaningful touches: scoring, assists, defense, transition, boards when clearly involving this player.",
          "",
        ].join("\n")
      : "",
    "When you output a highlight, set playerJersey / playerName / teamTag when grounded in visible cues; otherwise leave blank and lower score.",
    "Use visibilityNote to briefly state how confident jersey read is (e.g. 'number visible', 'partially blocked').",
    "─── end targeting ───",
    "",
  ];

  return lines.filter((line) => line !== "").join("\n");
}
