import type { Job } from "./types";

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
- Format: a plain decimal number. You MUST mathematically convert minutes to seconds.
- Example: 1 minute 12.5 seconds = (1 * 60) + 12.5 = 72.5. Output: 72.5
- Example: 4 minutes 10.0 seconds = (4 * 60) + 10.0 = 250.0. Output: 250.0
- CRITICAL: Do NOT just remove the colon from mm:ss. 4 minutes 10 seconds is NOT 410.0. It is 250.0.
- Do NOT return frame numbers. Do NOT return fps-relative values.
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
  If the request filters by jersey number, you MUST verify the number is visible before returning the clip.
- jerseyColor: set ONLY if the team color is clearly identifiable.
  If lighting or angle makes the color ambiguous, set to null.
- description: describe only what you actually observe in the clip.
  Do not fabricate details or invent context. If uncertain, keep it brief and general.
- confidence: honest self-assessment (0.0 to 1.0) of how certain you are this is the correct action and that it successfully completed.
  Never inflate. Clips with confidence below 0.8 must be omitted entirely. Do not guess on blurry or obstructed actions.
- clips: only return clips that are genuinely present in the video.
  If fewer clips exist than any stated maximum, return only what is there — do not invent clips.
  If more clips exist than any stated maximum, return the best ones up to the limit.
- Player must be clearly visible and directly involved in the play.
- The play result must be positive or defensively impactful.
- Omit dead time, inbound delays, and free throws (unless completing an and-1).

NEGATIVE RULES — CRITICAL TO REDUCE FALSE POSITIVES:
- Do NOT flag a timestamp if the ball bounces off the rim and away (missed shot).
- Do NOT flag a timestamp if a player is shooting around during a dead ball or after the whistle.
- Do NOT flag a timestamp if the referee has stopped play.`;

const RANKING_ORDER = `RANKING ORDER (1 = most valuable):
Dunks > Blocks > Steals leading to points > Made 3-pointers > Assists >
Tough finishes/and-1s > Transition plays > Rebounds > Defensive stops > Hustle plays`;

const OUTPUT_SCHEMA = `Return a JSON array only — no markdown, no explanation, no wrapper object:
[
  {
    "reasoning": "Step-by-step visual chain of thought. Describe the trajectory of the ball, player positioning, and outcome before deciding.",
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
- reasoning: Step-by-step visual chain of thought. Narrate the sequence (e.g., "Ball leaves hand, travels to hoop, passes through net") BEFORE deciding if it's a highlight.
- title: action name only, e.g. "Dunk" or "Block — #5". Omit jersey part if number not visible. DO NOT EVER GUESS JERSEY NUMBER IF ACTION ACTOR IDENTITY IS UNCLEAR.
- description: 1-2 sentences of what you actually observe. No fabrication.
- start_sec: exact second the play begins to develop, drive before layups, run before dunks, jumps before rebounds, positioning before 3pt, stance before free throw, action before foul, shot before out of bounds. basketball contains subtle preaction cues before main action, clips are preferred to start exactly at the pre action cue. this needs to be exace and will be used for cutting).
- end_sec: approximate second the play fully resolves, ball drops after basket(applies to freethrow, 3pt, dunk, basket scoring actions), player descends after rebound, positioning set after foul call, used for cutting.
- rank: 1 = most impactful.
- confidence: honest self-assessment of returned clips, action certainty from buildup to post action matching what was requested, 0.0–1.0. Omit if below 0.80.
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
  return `Clip limit: none. You MUST completely EXHAUST the video and extract EVERY SINGLE INSTANCE of this action. Do not stop early.`;
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

// ── Qwen3-VL-32B-Thinking proposer prompt ────────────────────────────────────
// Stage 1 of the proposer-verifier pipeline. Deliberately LIBERAL: the Gemini
// verifier removes false positives, so the proposer should over-propose rather
// than miss. The model is a *thinking* model — it reasons, then must emit ONLY
// a JSON array as its final output. Extremely explicit to avoid discrepancies.

function qwenTask(job: Job): string {
  if (job.mode === "action_extraction") {
    const filter = jerseyFilterInstruction(job);
    return `Find EVERY possible instance of this action: "${job.extracted_target}"${filter ? `\n${filter}` : ""}`;
  }
  return `Find EVERY possible positive basketball play involving ${compilationSubject(job)}.`;
}

export function buildQwenProposerPrompt(job: Job, chunkDurationSec: number): string {
  const dur = chunkDurationSec.toFixed(1);

  return `You are a meticulous professional basketball video analyst reviewing REAL game footage.
This is a recording of an actual basketball game — not a highlight reel, not an animation, not a simulation.

You are the PROPOSER in a two-stage system. A second, stricter model will VERIFY every clip you
propose and discard the wrong ones. Therefore your job is RECALL, not precision:
- Propose ANY moment that could POSSIBLY match — even if you are only 30% sure.
- It is far better to propose a borderline clip (the verifier will reject it) than to miss a real one.
- Do NOT self-censor. Do NOT require certainty. When in doubt, INCLUDE it.

TASK: ${qwenTask(job)}

HOW TO THINK (reason step by step BEFORE answering):
1. Scan the clip second by second for the on-court action.
2. For each candidate moment, narrate the visual sequence: ball/player movement, the decisive
   instant (shot release, contact, ball through net, possession change), and the resolution.
3. Decide the precise start and end seconds for cutting.
4. Only AFTER reasoning, output the final JSON array.

TIMESTAMP RULES — READ CAREFULLY:
- Timestamps are floating-point SECONDS measured from the START of THIS clip (which begins at 0.0).
- This clip is exactly ${dur} seconds long. Every start_sec and end_sec MUST be between 0.0 and ${dur}.
- Do NOT use mm:ss. Do NOT output frame numbers. Use plain decimal seconds (e.g. 7.5).
- start_sec: the moment the play begins to develop (the drive, the gather, the jump, the defensive close-out).
- end_sec: the moment the play fully resolves (ball through net, ball secured, player lands, whistle).
- end_sec MUST be greater than start_sec.

OUTPUT CONTRACT — THIS IS MANDATORY:
- Do your reasoning first, in plain text.
- Then, as the VERY LAST thing in your response, output ONLY a single JSON array.
- After the closing ] of the JSON array, output NOTHING else — no commentary, no markdown fences.
- If you find no candidates at all, the final output must be exactly: []

JSON array schema (one object per proposed clip):
[
  {
    "title": "short action name, e.g. 'Dunk' or 'Block'",
    "description": "1 sentence of what you observe",
    "start_sec": <float, 0.0 to ${dur}>,
    "end_sec": <float, start_sec to ${dur}>,
    "confidence": <float 0.0-1.0, your honest recall estimate — low is fine, include it anyway>,
    "rank": <integer, 1 = most confident/impactful>,
    "jerseyNumber": "<clearly legible number string, or null>",
    "jerseyColor": "<clearly identifiable color string, or null>"
  }
]

Remember: propose generously. The verifier will handle precision. Output the JSON array LAST.`;
}

// ── Gemini verifier prompt ───────────────────────────────────────────────────
// Stage 2. Strict binary confirm/reject for one small candidate clip.

function verifierSubject(job: Job): string {
  if (job.mode === "action_extraction") {
    const action = `a "${job.extracted_target}"`;
    if (job.jersey_number && job.jersey_color) {
      return `${action} performed by the player wearing jersey #${job.jersey_number} on the ${job.jersey_color} team`;
    }
    if (job.jersey_number) return `${action} performed by the player wearing jersey #${job.jersey_number}`;
    if (job.jersey_color) return `${action} performed by a player on the ${job.jersey_color} team`;
    return action;
  }
  return `a positive basketball play by ${compilationSubject(job)}`;
}

export function buildGeminiVerifierPrompt(
  job: Job,
  clipDurationSec: number,
  minConfidence: number,
): string {
  const subject = verifierSubject(job);

  return `You are a professional basketball video analyst reviewing real game footage.
This is a recording of an actual basketball game — not a highlight reel, not animation.

You are the VERIFIER in a two-stage system: a first model proposed this clip as a candidate,
and your only job is to CONFIRM or REJECT it. You do not find new plays or suggest timestamps.

ABOUT THIS CLIP:
- It is roughly ${clipDurationSec.toFixed(1)} seconds of real gameplay at normal speed.
- The candidate action occurs in the MIDDLE of the clip. The first ~2.5 seconds and last
  ~2.5 seconds are surrounding context (build-up and aftermath) — judge the main action, not the padding.

THE CANDIDATE WAS PROPOSED AS:
${subject}

CONFIRMATION RULES — be strict:
- confirmed=true ONLY if the action is clearly and unmistakably present AND completed successfully
  (a made 3-pointer requires the ball through the net; a block requires the shot to be stopped;
  a dunk requires the ball thrown down through the rim; a steal requires possession actually changing).
- If the play is only attempted, missed, or merely similar to the target, set confirmed=false.
- If a specific jersey number or color was requested, that exact player must perform the action.
  If the number is not clearly legible or it is a different player, set confirmed=false. Never guess a number.
- If the footage is too unclear or you genuinely cannot tell, set confirmed=false.
- A clip you confirm must have confidence of at least ${minConfidence.toFixed(2)}.

Return a JSON object only — no markdown, no explanation, no wrapper text:
{
  "confirmed": true | false,
  "confidence": <float 0.0-1.0>,
  "reason": "one sentence describing exactly what you observe in the main action"
}`;
}
