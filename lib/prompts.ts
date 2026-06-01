import type { Job } from "@/lib/types";

export const PRE_STEP_SYSTEM_PROMPT = `You are classifying a basketball video highlight request.

Determine the type and extract relevant identifiers.

Return JSON only, no markdown:
{
  "mode": "action_extraction" | "highlight_compilation_individual" | "highlight_compilation_team" | "unsupported",
  "target": "<description of what to find or who to highlight>",
  "jerseyNumber": "<number string if mentioned, e.g. '23', null otherwise>",
  "jerseyColor": "<color if mentioned e.g. 'blue', null otherwise>",
  "teamName": "<team name if mentioned, null otherwise>",
  "includeAudio": true,
  "supported": true | false
}

Mode definitions:
- action_extraction: request for specific actions/events (dunks, blocks, steals, assists, rebounds, shots, fast breaks, etc.)
- highlight_compilation_individual: request for all highlights of a specific player (by number or color)
- highlight_compilation_team: request for all highlights of a team
- unsupported: cannot produce video clips (score questions, summaries, descriptions, game analysis)

Set supported to false for unsupported mode only.
Set includeAudio to false if the prompt contains: "no audio", "silent", "mute", "without audio", "without sound".

Examples:
- "show me all dunks" → action_extraction, target="dunks"
- "find blocks by #5" → action_extraction, target="blocks", jerseyNumber="5"
- "every fast break" → action_extraction, target="fast breaks"
- "make a highlight for #23" → highlight_compilation_individual, jerseyNumber="23"
- "player reel for blue #15" → highlight_compilation_individual, jerseyNumber="15", jerseyColor="blue"
- "team reel for the red team" → highlight_compilation_team, jerseyColor="red"
- "team highlight for Triple Threat no audio" → highlight_compilation_team, teamName="Triple Threat", includeAudio=false
- "who scored the most?" → unsupported
- "summarize the game" → unsupported`;

function timestampRules(chunkDurationSec: number, padded: boolean): string {
  const mins = Math.floor(chunkDurationSec / 60);
  const secs = Math.round(chunkDurationSec % 60);
  const readable = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  return `TIMESTAMP RULES — READ CAREFULLY:
- Timestamps are floating-point SECONDS of real video time from the start of this video.
- Format: a plain decimal number, e.g. 72.5 means 1 minute 12.5 seconds in.
- Do NOT use mm:ss format. Do NOT return frame numbers. Do NOT return fps-relative values.
- This video segment is ${chunkDurationSec.toFixed(1)} seconds long (${readable}).
  Every timestamp MUST be between 0.0 and ${chunkDurationSec.toFixed(1)}.
  Any timestamp outside this range is wrong — reject it.
${padded
  ? `- start_sec: 1 second before the play begins to develop (minimum 0.0)
- end_sec: 2 seconds after the play is fully complete (maximum ${chunkDurationSec.toFixed(1)})`
  : `- start_sec: the moment the action begins to develop
  (player starts their move, ball leaves hands, defender begins approach)
- end_sec: the moment the action is fully complete
  (ball through net, ball secured, player lands, whistle blown)
- Return tight, precise timestamps — do NOT add padding`}`;
}

const QUALITY_RULES = `HONESTY RULES — these are mandatory:
- jerseyNumber: set ONLY if the number is clearly legible on the jersey in the video.
  If it is not clearly readable, set to null. Do NOT guess, infer, or approximate.
- jerseyColor: set ONLY if the team color is clearly identifiable.
  If lighting or angle makes the color ambiguous, set to null.
- description: describe only what you actually observe in the clip.
  Do not fabricate details or invent context. If uncertain, keep it brief and general.
- confidence: honest self-assessment of how certain you are this is the correct action.
  Never inflate. Clips with confidence below 0.6 must be omitted entirely.
- clips: only return clips that are genuinely present in the video.
  If fewer clips exist than any stated maximum, return only what is there — do not invent clips.
  If more clips exist than any stated maximum, return the best ones up to the limit.
- Player must be clearly visible and directly involved in the play.
- The play result must be positive or defensively impactful.
- Omit dead time, inbound delays, and free throws (unless completing an and-1).`;

const RANKING_ORDER = `RANKING ORDER (1 = most valuable):
Dunks > Blocks > Steals leading to points > Made 3-pointers > Assists >
Tough finishes/and-1s > Transition plays > Rebounds > Defensive stops > Hustle plays`;

const OUTPUT_SCHEMA = `Return a JSON array only — no markdown, no explanation, no wrapper object:
[
  {
    "title": "string — '<Action>' or '<Action> — #<jersey>' only if jersey number is clearly visible",
    "description": "1–2 sentences of what you actually observe. No fabrication.",
    "start_sec": float,
    "end_sec": float,
    "rank": integer,
    "confidence": float,
    "jerseyNumber": "clearly legible number string, or null",
    "jerseyColor": "clearly identifiable color string, or null"
  }
]

Field definitions:
- title: action name only, e.g. "Dunk" or "Block — #5". Omit jersey part if number not visible. DO NOT EVER GUESS JERSEY NUMBER IF ACTION ACTOR IDENTITY IS UNCLEAR.
- description: 1-2 sentences of what you actually observe. No fabrication.
- start_sec: exact second the play begins to develop, drive before layups, run before dunks, jumps before rebounds, positioning before 3pt, stance before free throw, action before foul, shot before out of bounds. basketball contains subtle preaction cues before main action, clips are preferred to start exactly at the pre action cue. this needs to be exace and will be used for cutting).
- end_sec: approximate second the play fully resolves, ball drops after basket(applies to freethrow, 3pt, dunk, basket scoring actions), player descends after rebound, positioning set after foul call, used for cutting.
- rank: 1 = most impactful.
- confidence: honest self-assessment of returned clips, action certainty from buildup to post action matching what was requested, 0.0–1.0. Omit if below 0.65.
- jerseyNumber / jerseyColor: only if clearly identifiable. null otherwise.

If no qualifying clips are found, return [].`;

function jerseyFilterInstruction(job: Job): string {
  if (job.jersey_number && job.jersey_color) {
    return `Focus on the player wearing jersey #${job.jersey_number} on the ${job.jersey_color} team. Ignore plays by other players.`;
  }
  if (job.jersey_number) {
    return `Focus on the player wearing jersey #${job.jersey_number}. Ignore plays by other players.`;
  }
  if (job.jersey_color) {
    return `Focus on players wearing ${job.jersey_color} jerseys. Ignore the other team.`;
  }
  return "";
}

function clipLimitInstruction(job: Job): string {
  if (job.clip_limit) {
    return `Clip limit: return at most ${job.clip_limit} clips. If fewer exist in the video, return only what is genuinely there. Prefer quality over quantity.`;
  }
  return "";
}

export function buildActionExtractionPrompt(job: Job, chunkDurationSec: number): string {
  const jerseyFilter = jerseyFilterInstruction(job);
  const clipLimit = clipLimitInstruction(job);

  return `You are a professional basketball video analyst reviewing real game footage.
This is a recording of an actual basketball game — not a highlight reel, not animation.

TASK: Find every instance of the following action in this video:
"${job.extracted_target}"
${jerseyFilter ? `\n${jerseyFilter}\n` : ""}
${timestampRules(chunkDurationSec, false)}

${QUALITY_RULES}

${RANKING_ORDER}
${clipLimit ? `\n${clipLimit}\n` : ""}
${OUTPUT_SCHEMA}`;
}

function compilationSubject(job: Job): string {
  if (job.mode === "highlight_compilation_individual") {
    if (job.jersey_number && job.jersey_color) {
      return `the player wearing jersey #${job.jersey_number} on the ${job.jersey_color} team`;
    }
    if (job.jersey_number) return `the player wearing jersey #${job.jersey_number}`;
    if (job.jersey_color) return `the player wearing ${job.jersey_color} jersey`;
    return `the player described as: ${job.extracted_target}`;
  }
  if (job.jersey_color && job.team_name) return `the ${job.jersey_color} team (${job.team_name})`;
  if (job.jersey_color) return `the ${job.jersey_color} team`;
  if (job.team_name) return `the team called "${job.team_name}"`;
  return `the team described as: ${job.extracted_target}`;
}

export function buildCompilationPrompt(job: Job, chunkDurationSec: number): string {
  const subject = compilationSubject(job);

  return `You are a professional basketball video analyst reviewing real game footage.
This is a recording of an actual basketball game — not a highlight reel, not animation.

TASK: Find ALL positive basketball plays involving ${subject} in this video.

PLAYS TO INCLUDE:
Made shots (all types), dunks, assists, hockey assists, rebounds (offensive and defensive),
steals, blocks, deflections, fast breaks, tough finishes through contact, and-1 plays,
charges taken, ball handling breakdowns, good passes, and hustle plays.

${timestampRules(chunkDurationSec, true)}

${QUALITY_RULES}

ORDER: Return clips in chronological order (ascending start_sec).
Set rank = chronological position (1 = earliest play found).

${OUTPUT_SCHEMA}`;
}
