import { Type } from "@google/genai";

import { isMockAiMode } from "@/lib/aiMode";
import { categoryPacks } from "@/lib/categories/packs";
import { VideoCategory } from "@/lib/categories/types";
import { getGeminiClient, uploadGeminiVideoAndWait } from "@/lib/gemini";
import { TranscriptSegment } from "@/lib/types";

function safeCategory(raw?: string): VideoCategory {
  const key = (raw ?? "").trim() as VideoCategory;
  return categoryPacks[key] ? key : "generic";
}

export async function detectVideoCategory(params: {
  previewVideoPath: string;
  transcriptSegments: TranscriptSegment[];
}): Promise<VideoCategory> {
  if (isMockAiMode()) {
    return "generic";
  }

  const ai = getGeminiClient();
  const uploaded = await uploadGeminiVideoAndWait(params.previewVideoPath);
  const transcriptSnippet = params.transcriptSegments
    .slice(0, 20)
    .map((segment) => segment.text)
    .join(" ")
    .slice(0, 2_000);

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: [
                "Classify this video into one category only.",
                "Allowed categories: sports, talk_podcast, lecture, vlog, gaming, music, generic, unknown.",
                "Respond with JSON: {\"category\": \"...\"}",
                `Transcript sample: ${transcriptSnippet || "none"}`,
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
          type: Type.OBJECT,
          required: ["category"],
          properties: {
            category: { type: Type.STRING },
          },
        },
      },
    });

    const parsed = JSON.parse(response.text ?? "{}") as { category?: string };
    return safeCategory(parsed.category);
  } catch {
    return "generic";
  } finally {
    if (uploaded.name) {
      await ai.files.delete({ name: uploaded.name }).catch(() => undefined);
    }
  }
}
