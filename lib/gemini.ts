import path from "node:path";

import { File, FileState, GoogleGenAI } from "@google/genai";

import { appConfig } from "@/lib/config";

const FILE_POLL_INTERVAL_MS = 3_000;
const FILE_POLL_TIMEOUT_MS = 5 * 60_000;

let geminiClient: GoogleGenAI | null = null;

export function getGeminiClient(): GoogleGenAI {
  if (geminiClient) {
    return geminiClient;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set.");
  }

  geminiClient = new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: appConfig.gemini.httpTimeoutMs,
    },
  });
  return geminiClient;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function uploadGeminiVideoAndWait(filePath: string): Promise<File> {
  const ai = getGeminiClient();

  const uploaded = await ai.files.upload({
    file: filePath,
    config: {
      mimeType: "video/mp4",
      displayName: path.basename(filePath),
    },
  });

  if (!uploaded.name) {
    throw new Error("Gemini file upload returned no file name.");
  }

  const startMs = Date.now();
  let latest = uploaded;

  while (Date.now() - startMs < FILE_POLL_TIMEOUT_MS) {
    latest = await ai.files.get({ name: uploaded.name });

    if (latest.state === FileState.ACTIVE) {
      return latest;
    }
    if (latest.state === FileState.FAILED) {
      throw new Error(`Gemini file processing failed: ${latest.error?.message ?? uploaded.name}`);
    }

    await sleep(FILE_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for Gemini file to become ACTIVE: ${uploaded.name}`);
}
