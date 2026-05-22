import path from "node:path";

import { Type } from "@google/genai";

import { isMockAiMode } from "@/lib/aiMode";
import { getCategoryPack } from "@/lib/categories/packs";
import { detectVideoCategory } from "@/lib/categories/router";
import { VideoCategory } from "@/lib/categories/types";
import { appConfig } from "@/lib/config";
import { mapWithConcurrency, withRetry } from "@/lib/concurrency";
import { appendPipelineLog, updateJob } from "@/lib/jobs";
import { getGeminiClient, uploadGeminiVideoAndWait } from "@/lib/gemini";
import { buildCandidateWindows } from "@/lib/pipeline/candidateWindows";
import { VideoChunk } from "@/lib/pipeline/chunkVideo";
import { createVisionProxyVideo } from "@/lib/pipeline/proxy";
import { buildPlayerFocusPromptSection } from "@/lib/playerFocus";
import { CandidateWindow, Highlight, PlayerFocusSpec, TranscriptSegment } from "@/lib/types";

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
  category: VideoCategory;
  candidates: CandidateWindow[];
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

function rescaleScore(rawScore: number | undefined, maxObservedScore: number): number {
  const value = Number.isFinite(rawScore) ? Number(rawScore) : 70;
  // Models sometimes emit 0-1, 0-10, or 0-100. Pick a multiplier from the batch max.
  let multiplier = 1;
  if (maxObservedScore > 0 && maxObservedScore <= 1.0001) {
    multiplier = 100;
  } else if (maxObservedScore > 1 && maxObservedScore <= 10.0001) {
    multiplier = 10;
  }
  return clamp(Math.round(value * multiplier), 0, 100);
}

function normalizeHighlights(highlights: Highlight[], maxDurationSec: number): Highlight[] {
  const observedMaxScore = highlights.reduce((max, item) => {
    const candidate = Number.isFinite(item.score) ? Number(item.score) : 0;
    return candidate > max ? candidate : max;
  }, 0);

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
        score: rescaleScore(item.score, observedMaxScore),
        confidence: clamp(item.confidence ?? 0.7, 0, 1),
        eventType: item.eventType ?? "highlight",
        evidence: item.evidence ?? ["visual-model"],
        category: item.category ?? "generic",
        tags: item.tags ?? [],
        transcriptQuote: item.transcriptQuote,
        keyFrameSec: item.keyFrameSec,
        audioPeakDb: item.audioPeakDb,
        playerJersey: item.playerJersey,
        playerName: item.playerName,
        teamTag: item.teamTag,
        visibilityNote: item.visibilityNote,
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
        eventType: String(item.eventType ?? "highlight"),
        confidence: Number(item.confidence ?? 0.7),
        evidence: Array.isArray(item.evidence) ? item.evidence.map((entry) => String(entry)) : ["gemini"],
        category: String(item.category ?? "generic"),
        tags: Array.isArray(item.tags) ? item.tags.map((entry) => String(entry)) : [],
        transcriptQuote: item.transcriptQuote ? String(item.transcriptQuote) : undefined,
        keyFrameSec: typeof item.keyFrameSec === "number" ? item.keyFrameSec : undefined,
        audioPeakDb: typeof item.audioPeakDb === "number" ? item.audioPeakDb : undefined,
        playerJersey: item.playerJersey != null ? String(item.playerJersey) : undefined,
        playerName: item.playerName != null ? String(item.playerName) : undefined,
        teamTag: item.teamTag != null ? String(item.teamTag) : undefined,
        visibilityNote: item.visibilityNote != null ? String(item.visibilityNote) : undefined,
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
  previewVideoPath?: string;
  initialCategory?: VideoCategory | string;
  maxDurationSec: number;
  playerFocus?: PlayerFocusSpec;
  /** Cap after normalization; omit to use MAX_HIGHLIGHTS_FINAL env default. 0 = unlimited. */
  maxFinalHighlights?: number;
  /** When set, Gemini chunk progress is appended to job pipeline logs. */
  jobId?: string;
}): Promise<VisualHighlightsResult> {
  const detectedCategory =
    params.initialCategory && params.initialCategory !== "auto"
      ? (params.initialCategory as VideoCategory)
      : await detectVideoCategory({
          previewVideoPath: params.previewVideoPath ?? params.inputVideoPath,
          transcriptSegments: params.transcriptSegments,
        });
  const pack = getCategoryPack(detectedCategory);
  const corePrompt = params.userPrompt?.trim() || `${DEFAULT_HIGHLIGHT_PROMPT}\n${pack.prompt}`;
  const focusBlock = params.playerFocus ? buildPlayerFocusPromptSection(params.playerFocus) : "";
  const effectivePrompt = focusBlock ? `${corePrompt}\n${focusBlock}` : corePrompt;
  const candidates = buildCandidateWindows({
    transcriptSegments: params.transcriptSegments,
    maxDurationSec: params.maxDurationSec,
    desiredWindowSec: Math.max(pack.minDurationSec, Math.min(pack.maxDurationSec, 35)),
  });

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
          eventType: "highlight",
          category: detectedCategory,
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
      category: detectedCategory,
      candidates,
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

  const totalRankingChunks = params.videoChunks.length;
  let rankingChunksDone = 0;
  const bumpRankingProgress = () => {
    if (!params.jobId || totalRankingChunks === 0) return;
    rankingChunksDone += 1;
    const progress = Math.min(84, 70 + Math.floor((rankingChunksDone / totalRankingChunks) * 14));
    updateJob(params.jobId, {
      progress,
      message: `Ranking with Gemini (${rankingChunksDone}/${totalRankingChunks} chunks done)…`,
    });
  };

  const chunkHighlights = await mapWithConcurrency(
    params.videoChunks,
    appConfig.pipeline.geminiConcurrency,
    async (chunk, index) => {
      usage.videoSeconds += chunk.durationSec;
      if (params.jobId) {
        appendPipelineLog(params.jobId, {
          level: "info",
          stage: "gemini",
          message: `Ranking chunk ${index + 1}/${params.videoChunks.length} start`,
          detail: `${chunk.startSec.toFixed(0)}s+${chunk.durationSec.toFixed(0)}s`,
        });
      }

      try {
        const proxyDir = path.join(path.dirname(chunk.path), "..", "chunk-proxies");
        const proxyPath = await createVisionProxyVideo(chunk.path, proxyDir);
        const uploaded = await uploadGeminiVideoAndWait(proxyPath);
        const transcriptWindow = buildChunkTranscript(params.transcriptSegments, chunk);

        const response = await withRetry(
          () =>
            ai.models.generateContent({
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
                        "Score must be an integer between 0 and 100 (not 0-10, not 0-1).",
                        "Confidence must be a decimal between 0 and 1.",
                        `Category: ${detectedCategory}`,
                        `Allowed event types: ${pack.allowedEventTypes.join(", ")}`,
                        ...(focusBlock ? [focusBlock] : []),
                        `Highlight criteria: ${corePrompt}`,
                        "",
                        "Candidate windows to prioritize (seconds):",
                        candidates.map((window) => `${window.startSec.toFixed(2)}-${window.endSec.toFixed(2)}`).join(", "),
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
                    required: ["startSec", "endSec", "title", "reason", "score", "eventType", "confidence"],
                    properties: {
                      startSec: { type: Type.NUMBER },
                      endSec: { type: Type.NUMBER },
                      title: { type: Type.STRING },
                      reason: { type: Type.STRING },
                      score: { type: Type.NUMBER },
                      eventType: { type: Type.STRING },
                      confidence: { type: Type.NUMBER },
                      evidence: { type: Type.ARRAY, items: { type: Type.STRING } },
                      category: { type: Type.STRING },
                      tags: { type: Type.ARRAY, items: { type: Type.STRING } },
                      transcriptQuote: { type: Type.STRING },
                      keyFrameSec: { type: Type.NUMBER },
                      audioPeakDb: { type: Type.NUMBER },
                      playerJersey: { type: Type.STRING },
                      playerName: { type: Type.STRING },
                      teamTag: { type: Type.STRING },
                      visibilityNote: { type: Type.STRING },
                    },
                  },
                },
              },
            }),
          { retries: 2, baseDelayMs: 800 },
        );

        usage.inputTokens += response.usageMetadata?.promptTokenCount ?? 0;
        usage.outputTokens += response.usageMetadata?.candidatesTokenCount ?? 0;
        usage.totalTokens += response.usageMetadata?.totalTokenCount ?? 0;

        const parsed = parseGeminiHighlights(response.text).map((item) => ({
          ...item,
          startSec: item.startSec + chunk.startSec,
          endSec: item.endSec + chunk.startSec,
          category: detectedCategory,
        }));

        if (uploaded.name) {
          await ai.files.delete({ name: uploaded.name }).catch(() => undefined);
        }
        if (params.jobId) {
          appendPipelineLog(params.jobId, {
            level: "info",
            stage: "gemini",
            message: `Ranking chunk ${index + 1}/${params.videoChunks.length} done`,
            detail: `${parsed.length} highlight(s)`,
          });
          bumpRankingProgress();
        }
        return parsed;
      } catch (error) {
        console.error(`Gemini highlight extraction failed for chunk ${chunk.path}`, error);
        if (params.jobId) {
          appendPipelineLog(params.jobId, {
            level: "warn",
            stage: "gemini",
            message: `Ranking chunk ${index + 1}/${params.videoChunks.length} failed`,
            detail: error instanceof Error ? error.message : String(error),
          });
          bumpRankingProgress();
        }
        return [];
      }
    },
  );
  allHighlights.push(...chunkHighlights.flat());

  const normalized = normalizeHighlights(allHighlights, params.maxDurationSec);

  const cap =
    params.maxFinalHighlights !== undefined
      ? params.maxFinalHighlights
      : appConfig.pipeline.maxHighlightsFinal;

  // Final pass: enforce diversity and global ranking.
  const finalHighlights = [...normalized]
    .sort((a, b) => b.score + (b.confidence ?? 0) * 100 - (a.score + (a.confidence ?? 0) * 100));
  const limited = cap > 0 ? finalHighlights.slice(0, cap) : finalHighlights;
  limited.sort((a, b) => a.startSec - b.startSec);

  return {
    highlights: limited,
    effectivePrompt,
    category: detectedCategory,
    candidates,
    usage,
  };
}
