import { CandidateWindow, TranscriptSegment } from "@/lib/types";

interface CandidateInput {
  transcriptSegments: TranscriptSegment[];
  maxDurationSec: number;
  desiredWindowSec?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function mergeWindows(candidates: CandidateWindow[]): CandidateWindow[] {
  const sorted = [...candidates].sort((a, b) => a.startSec - b.startSec);
  const merged: CandidateWindow[] = [];
  for (const item of sorted) {
    const prev = merged[merged.length - 1];
    if (!prev || item.startSec > prev.endSec + 2) {
      merged.push(item);
      continue;
    }

    prev.endSec = Math.max(prev.endSec, item.endSec);
    prev.audioScore = Math.max(prev.audioScore, item.audioScore);
    prev.transcriptScore = Math.max(prev.transcriptScore, item.transcriptScore);
    prev.reasons = [...new Set([...prev.reasons, ...item.reasons])];
  }
  return merged;
}

export function buildCandidateWindows(input: CandidateInput): CandidateWindow[] {
  const desiredWindowSec = input.desiredWindowSec ?? 35;
  const candidates: CandidateWindow[] = [];

  for (const segment of input.transcriptSegments) {
    const text = segment.text.toLowerCase();
    const hasTriggerWord = /(wow|incredible|important|key|great|amazing|goal|score|winner|clutch|laugh)/.test(
      text,
    );
    const segmentDuration = Math.max(1, segment.end - segment.start);
    const transcriptScore = hasTriggerWord ? 0.9 : Math.min(0.7, segmentDuration / desiredWindowSec);
    const simulatedAudioScore = hasTriggerWord ? 0.8 : 0.4;

    if (transcriptScore < 0.5) {
      continue;
    }

    const center = (segment.start + segment.end) / 2;
    const startSec = clamp(center - desiredWindowSec / 2, 0, input.maxDurationSec - 1);
    const endSec = clamp(startSec + desiredWindowSec, startSec + 1, input.maxDurationSec);
    candidates.push({
      startSec,
      endSec,
      transcriptScore,
      audioScore: simulatedAudioScore,
      reasons: hasTriggerWord ? ["transcript-keyword", "audio-spike"] : ["transcript-salience"],
    });
  }

  if (candidates.length === 0) {
    return [
      {
        startSec: 0,
        endSec: Math.min(desiredWindowSec, input.maxDurationSec),
        transcriptScore: 0.3,
        audioScore: 0.3,
        reasons: ["fallback-window"],
      },
    ];
  }

  return mergeWindows(candidates).slice(0, 30);
}
