import { createReadStream } from "node:fs";

import { isMockAiMode } from "@/lib/aiMode";
import { getOpenAIClient } from "@/lib/openai";
import { TranscriptResult, TranscriptSegment } from "@/lib/types";
import { AudioChunk } from "@/lib/pipeline/chunkAudio";

interface WhisperVerboseSegment {
  start?: number;
  end?: number;
  text?: string;
}

interface WhisperVerboseResponse {
  text?: string;
  segments?: WhisperVerboseSegment[];
  usage?: {
    seconds?: number;
  };
}

export interface TranscriptionRunResult {
  transcript: TranscriptResult;
  usage: {
    transcriptionSeconds: number;
  };
}

export async function transcribeChunks(chunks: AudioChunk[]): Promise<TranscriptionRunResult> {
  if (isMockAiMode()) {
    const segments: TranscriptSegment[] = chunks.map((chunk, index) => ({
      start: chunk.startSec,
      end: chunk.startSec + chunk.durationSec,
      text: `Mock transcript segment ${index + 1} with energetic audience reaction and important moment.`,
    }));

    return {
      transcript: {
        fullText: segments.map((segment) => segment.text).join(" "),
        segments,
      },
      usage: {
        transcriptionSeconds: 0,
      },
    };
  }

  const openai = getOpenAIClient();
  const stitchedSegments: TranscriptSegment[] = [];
  const fullTextParts: string[] = [];
  let transcriptionSeconds = 0;

  for (const chunk of chunks) {
    const response = (await openai.audio.transcriptions.create({
      file: createReadStream(chunk.path),
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
    })) as WhisperVerboseResponse;

    if (response.text) {
      fullTextParts.push(response.text.trim());
    }
    if (typeof response.usage?.seconds === "number") {
      transcriptionSeconds += response.usage.seconds;
    }

    for (const segment of response.segments ?? []) {
      if (
        typeof segment.start !== "number" ||
        typeof segment.end !== "number" ||
        !segment.text?.trim()
      ) {
        continue;
      }

      stitchedSegments.push({
        start: segment.start + chunk.startSec,
        end: segment.end + chunk.startSec,
        text: segment.text.trim(),
      });
    }
  }

  return {
    transcript: {
      fullText: fullTextParts.join(" ").trim(),
      segments: stitchedSegments,
    },
    usage: {
      transcriptionSeconds,
    },
  };
}
