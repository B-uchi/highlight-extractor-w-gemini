import { readFile } from "node:fs/promises";

import { isMockAiMode } from "@/lib/aiMode";
import { getGeminiClient } from "@/lib/gemini";
import { isDatabaseEnabled } from "@/lib/db";
import { getJob, hydrateJobFromStore } from "@/lib/jobs";
import type { TranscriptSegment } from "@/lib/types";

function segmentsInRange(segments: TranscriptSegment[], startSec: number, endSec: number): TranscriptSegment[] {
  return segments.filter((s) => s.end >= startSec && s.start <= endSec);
}

export async function explainClipWithGemini(params: {
  jobId: string;
  clipId: string;
  question: string;
}): Promise<string> {
  const job = isDatabaseEnabled()
    ? (await hydrateJobFromStore(params.jobId)) ?? getJob(params.jobId)
    : getJob(params.jobId) ?? (await hydrateJobFromStore(params.jobId));
  if (!job) {
    throw new Error(`Job not found: ${params.jobId}`);
  }
  const clip = job.clips?.find((c) => c.id === params.clipId);
  if (!clip) {
    throw new Error(`Clip not found: ${params.clipId}`);
  }

  let transcriptSnippets = "";
  if (job.transcriptPath) {
    try {
      const raw = await readFile(job.transcriptPath, "utf8");
      const parsed = JSON.parse(raw) as { segments?: TranscriptSegment[] };
      const segs = parsed.segments ?? [];
      const window = segmentsInRange(segs, clip.startSec, clip.endSec);
      transcriptSnippets = window.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join("\n");
    } catch {
      transcriptSnippets = "";
    }
  }

  const highlight = job.highlights?.find(
    (h) => Math.abs(h.startSec - clip.startSec) < 1 && Math.abs(h.endSec - clip.endSec) < 1,
  );

  if (isMockAiMode()) {
    return [
      `[Mock] Clip ${clip.id} (${clip.startSec.toFixed(1)}–${clip.endSec.toFixed(1)}s): ${clip.title}.`,
      highlight?.reason ? `Reason: ${highlight.reason}` : "",
      `Q: ${params.question}`,
      transcriptSnippets ? "Transcript window present." : "No transcript window.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const ai = getGeminiClient();
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          {
            text: [
              "You explain video highlight clips to the user.",
              `Clip id: ${clip.id}`,
              `Time range: ${clip.startSec.toFixed(2)}-${clip.endSec.toFixed(2)} seconds`,
              `Title: ${clip.title}`,
              `Score: ${clip.score}`,
              clip.eventType ? `Event type: ${clip.eventType}` : "",
              highlight?.reason ? `Why it's a highlight: ${highlight.reason}` : "",
              transcriptSnippets ? `Transcript in range:\n${transcriptSnippets}` : "No transcript available for this range.",
              "",
              `User question: ${params.question}`,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      },
    ],
  });

  const text = response.text?.trim();
  if (!text) {
    return "No explanation produced.";
  }
  return text;
}
