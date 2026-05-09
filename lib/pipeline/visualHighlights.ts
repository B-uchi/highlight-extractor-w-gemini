import { Type } from "@google/genai";

import { isMockAiMode } from "@/lib/aiMode";
import { getGeminiClient, uploadGeminiVideoAndWait } from "@/lib/gemini";
import { VideoChunk } from "@/lib/pipeline/chunkVideo";
import { Highlight, TranscriptSegment } from "@/lib/types";

export const DEFAULT_HIGHLIGHT_PROMPT =
  "Find every distinct moment in this video that is highlight-worthy: emotionally strong, surprising, informative, funny, dramatic, or visually engaging. Prefer 20-90 second windows.";

interface VisualUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  videoSeconds: number;
}

export interface VisualHighlightsResult {
  highlights: Highlight[];
  effectivePrompt: string;
  usage: VisualUsage;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function overlapRatio(a: Highlight, b: Highlight): number {
  const intersection = Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
  if (intersection === 0) {
    return 0;
  }

  const aDuration = Math.max(0.001, a.endSec - a.startSec);
  const bDuration = Math.max(0.001, b.endSec - b.startSec);
  return Math.max(intersection / aDuration, intersection / bDuration);
}

function dedupeOverlaps(highlights: Highlight[]): Highlight[] {
  const ranked = [...highlights].sort((a, b) => b.score - a.score);
  const kept: Highlight[] = [];

  for (const candidate of ranked) {
    const hasHeavyOverlap = kept.some((existing) => overlapRatio(existing, candidate) > 0.5);
    if (!hasHeavyOverlap) {
      kept.push(candidate);
    }
  }

  return kept.sort((a, b) => a.startSec - b.startSec);
}

function normalizeHighlights(highlights: Highlight[], maxDurationSec: number): Highlight[] {
  const normalized = highlights
    .map((item) => {
      const startSec = clamp(item.startSec, 0, maxDurationSec);
      let endSec = clamp(item.endSec, startSec + 1, maxDurationSec);
      if (endSec - startSec < 5) {
        endSec = clamp(startSec + 20, startSec + 1, maxDurationSec);
      }

      return {
        startSec,
        endSec,
        title: item.title?.trim() || "Highlight moment",
        reason: item.reason?.trim() || "High-engagement moment detected.",
        score: clamp(item.score ?? 70, 0, 100),
      };
    })
    .filter((item) => Number.isFinite(item.startSec) && Number.isFinite(item.endSec) && item.endSec > item.startSec);

  return dedupeOverlaps(normalized);
}

function buildChunkTranscript(segments: TranscriptSegment[], chunk: VideoChunk): string {
  const chunkEnd = chunk.startSec + chunk.durationSec;
  const inChunk = segments.filter((segment) => segment.end >= chunk.startSec && segment.start <= chunkEnd);
  if (inChunk.length === 0) {
    return "No transcript available for this chunk.";
  }

  return inChunk
    .map((segment) => {
      const relativeStart = Math.max(0, segment.start - chunk.startSec);
      const relativeEnd = Math.max(relativeStart, segment.end - chunk.startSec);
      return `[${relativeStart.toFixed(2)}-${relativeEnd.toFixed(2)}] ${segment.text}`;
    })
    .join("\n");
}

function parseGeminiHighlights(raw: string | undefined): Highlight[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as Partial<Highlight>[];
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item) => typeof item.startSec === "number" && typeof item.endSec === "number")
      .map((item) => ({
        startSec: item.startSec as number,
        endSec: item.endSec as number,
        title: String(item.title ?? "Highlight"),
        reason: String(item.reason ?? "Highlight-worthy moment"),
        score: Number(item.score ?? 75),
      }));
  } catch {
    return [];
  }
}

export async function rankVisualHighlights(params: {
  inputVideoPath: string;
  videoChunks: VideoChunk[];
  transcriptSegments: TranscriptSegment[];
  userPrompt?: string;
  maxDurationSec: number;
}): Promise<VisualHighlightsResult> {
  const effectivePrompt = params.userPrompt?.trim() || DEFAULT_HIGHLIGHT_PROMPT;

  if (isMockAiMode()) {
    const fallback = normalizeHighlights(
      [
        {
          startSec: Math.min(30, params.maxDurationSec - 1),
          endSec: Math.min(70, params.maxDurationSec),
          title: "Mock visual highlight 1",
          reason: "Detected high visual and narrative engagement.",
          score: 83,
        },
        {
          startSec: Math.min(140, params.maxDurationSec - 1),
          endSec: Math.min(180, params.maxDurationSec),
          title: "Mock visual highlight 2",
          reason: "Strong visual shift and meaningful spoken moment.",
          score: 79,
        },
      ],
      params.maxDurationSec,
    );

    return {
      highlights: fallback,
      effectivePrompt,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        videoSeconds: params.videoChunks.reduce((sum, chunk) => sum + chunk.durationSec, 0),
      },
    };
  }

  const ai = getGeminiClient();
  const allHighlights: Highlight[] = [];
  const usage: VisualUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    videoSeconds: 0,
  };

  for (const chunk of params.videoChunks) {
    usage.videoSeconds += chunk.durationSec;

    try {
      const uploaded = await uploadGeminiVideoAndWait(chunk.path);
      const transcriptWindow = buildChunkTranscript(params.transcriptSegments, chunk);

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              {
                text: [
                  "You are a highlight detection assistant.",
                  "Given this video chunk and transcript, return every distinct highlight moment you can find.",
                  "Return timestamps relative to THIS chunk (chunk starts at 0).",
                  "Prefer 20-90 second windows when possible.",
                  `Highlight criteria: ${effectivePrompt}`,
                  "",
                  "Transcript for this chunk:",
                  transcriptWindow,
                ].join("\n"),
              },
              {
                fileData: {
                  fileUri: uploaded.uri,
                  mimeType: uploaded.mimeType ?? "video/mp4",
                },
              },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              required: ["startSec", "endSec", "title", "reason", "score"],
              properties: {
                startSec: { type: Type.NUMBER },
                endSec: { type: Type.NUMBER },
                title: { type: Type.STRING },
                reason: { type: Type.STRING },
                score: { type: Type.NUMBER },
              },
            },
          },
        },
      });

      usage.inputTokens += response.usageMetadata?.promptTokenCount ?? 0;
      usage.outputTokens += response.usageMetadata?.candidatesTokenCount ?? 0;
      usage.totalTokens += response.usageMetadata?.totalTokenCount ?? 0;

      const parsed = parseGeminiHighlights(response.text).map((item) => ({
        ...item,
        startSec: item.startSec + chunk.startSec,
        endSec: item.endSec + chunk.startSec,
      }));

      allHighlights.push(...parsed);

      if (uploaded.name) {
        await ai.files.delete({ name: uploaded.name }).catch(() => undefined);
      }
    } catch (error) {
      console.error(`Gemini highlight extraction failed for chunk ${chunk.path}`, error);
      // Continue processing remaining chunks; do not fail whole job.
    }
  }

  return {
    highlights: normalizeHighlights(allHighlights, params.maxDurationSec),
    effectivePrompt,
    usage,
  };
}
