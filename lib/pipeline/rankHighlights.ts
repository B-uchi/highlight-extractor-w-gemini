import { isMockAiMode } from "@/lib/aiMode";
import { getOpenAIClient } from "@/lib/openai";
import { Highlight, TranscriptSegment } from "@/lib/types";

export interface RankingRunResult {
  highlight: Highlight;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

function toCompactTimeline(segments: TranscriptSegment[]): string {
  return segments
    .map((segment) => `[${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] ${segment.text}`)
    .join("\n");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export async function rankSingleHighlight(
  segments: TranscriptSegment[],
  maxDurationSec: number,
): Promise<RankingRunResult> {
  if (segments.length === 0) {
    throw new Error("Transcript has no segments to rank.");
  }

  if (isMockAiMode()) {
    const pivot = segments[Math.floor(segments.length / 2)];
    const startSec = clamp(pivot.start, 0, maxDurationSec);
    const endSec = clamp(startSec + 30, startSec + 1, maxDurationSec);

    return {
      highlight: {
        startSec,
        endSec,
        title: "Mock highlight",
        reason: "Mock AI mode selected a central, high-energy transcript segment.",
        score: 80,
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
    };
  }

  const openai = getOpenAIClient();
  const timeline = toCompactTimeline(segments);

  const response = await openai.responses.create({
    model: "gpt-4o",
    input: [
      {
        role: "system",
        content:
          "You rank highlight-worthy moments from a transcript timeline. Return strict JSON only.",
      },
      {
        role: "user",
        content: `
Given transcript segments with timestamps in seconds, pick exactly one best highlight clip.
Keep clip duration between 20 and 90 seconds when possible.

Return JSON with this shape:
{
  "startSec": number,
  "endSec": number,
  "title": string,
  "reason": string,
  "score": number
}

Transcript timeline:
${timeline}
        `.trim(),
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "highlight_pick",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["startSec", "endSec", "title", "reason", "score"],
          properties: {
            startSec: { type: "number" },
            endSec: { type: "number" },
            title: { type: "string" },
            reason: { type: "string" },
            score: { type: "number", minimum: 0, maximum: 100 },
          },
        },
        strict: true,
      },
    },
  });

  const payload = response.output_text;
  if (!payload) {
    throw new Error("LLM returned empty output for highlight ranking.");
  }

  const parsed = JSON.parse(payload) as Highlight;
  const safeStart = clamp(parsed.startSec, 0, maxDurationSec);
  let safeEnd = clamp(parsed.endSec, safeStart + 1, maxDurationSec);

  // Prevent tiny clips when model chooses near-identical timestamps.
  if (safeEnd - safeStart < 5) {
    safeEnd = clamp(safeStart + 20, safeStart + 1, maxDurationSec);
  }

  return {
    highlight: {
      startSec: safeStart,
      endSec: safeEnd,
      title: parsed.title,
      reason: parsed.reason,
      score: clamp(parsed.score, 0, 100),
    },
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    },
  };
}
