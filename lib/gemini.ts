import path from "node:path";

import { FileState, GoogleGenAI } from "@google/genai";

import { appConfig } from "@/lib/config";
import { extractSegment, slowdownVideo } from "@/lib/ffmpeg";
import { createServerClient } from "@/lib/supabase";
import {
  downloadFromR2,
  ensureTmpDir,
  safeUnlink,
  uploadFileToR2,
} from "@/lib/storage";
import type { GeminiClipResult, PreStepResult, VideoChunk } from "@/lib/types";
import {
  buildActionExtractionPrompt,
  buildCompilationPrompt,
  PRE_STEP_SYSTEM_PROMPT,
} from "@/lib/prompts";
import type { Job } from "@/lib/types";

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 10 * 60_000;
const CHUNK_DURATION_SEC = appConfig.gemini.chunkDurationSec;

let geminiSingleton: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (geminiSingleton) return geminiSingleton;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set.");
  geminiSingleton = new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: appConfig.gemini.httpTimeoutMs },
  });
  return geminiSingleton;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Upload a local file to Gemini Files API and wait for ACTIVE state. Returns the file URI. */
async function uploadAndWait(
  filePath: string,
): Promise<{ fileUri: string; expiresAt: Date }> {
  const ai = getClient();
  const uploaded = await ai.files.upload({
    file: filePath,
    config: { mimeType: "video/mp4", displayName: path.basename(filePath) },
  });

  if (!uploaded.name) throw new Error("Gemini upload returned no file name.");

  const start = Date.now();
  let latest = uploaded;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    latest = await ai.files.get({ name: uploaded.name });
    if (latest.state === FileState.ACTIVE) {
      // Prefer the URI from the response; fall back to constructing from name
      const uri =
        latest.uri ??
        `https://generativelanguage.googleapis.com/v1beta/${latest.name}`;
      const expiresAt = latest.expirationTime
        ? new Date(latest.expirationTime)
        : new Date(Date.now() + 47 * 3600 * 1000);
      return { fileUri: uri, expiresAt };
    }
    if (latest.state === FileState.FAILED) {
      throw new Error(
        `Gemini file processing failed: ${latest.error?.message ?? uploaded.name}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for Gemini file: ${uploaded.name}`);
}

/**
 * Ensure all video chunks for a conversation are uploaded and active in Gemini.
 * Re-uploads any expired/expiring chunks from R2.
 * Returns ordered array of { chunkIndex, geminiFileId }.
 */
export async function ensureChunksReady(
  conversationId: string,
  r2VideoKey: string,
  videoDurationSecs: number,
): Promise<
  {
    chunkIndex: number;
    geminiFileId: string;
    startSec: number;
    endSec: number;
  }[]
> {
  const db = createServerClient();
  const now = new Date();
  const expiryBuffer = 60 * 60 * 1000; // 1 hour

  // Load existing chunks
  const { data: existingChunks } = await db
    .from("video_chunks")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("chunk_index");

  const chunkCount = Math.ceil(videoDurationSecs / CHUNK_DURATION_SEC);
  const result: {
    chunkIndex: number;
    geminiFileId: string;
    startSec: number;
    endSec: number;
  }[] = [];

  // Download the source video once if any chunk needs re-upload
  const tmpBase = await ensureTmpDir(conversationId);
  const srcPath = path.join(tmpBase, "source.mp4");
  let srcDownloaded = false;

  const chunksMap = new Map<number, VideoChunk>(
    (existingChunks ?? []).map((c: VideoChunk) => [c.chunk_index, c]),
  );

  for (let i = 0; i < chunkCount; i++) {
    const startSec = i * CHUNK_DURATION_SEC;
    const endSec = Math.min((i + 1) * CHUNK_DURATION_SEC, videoDurationSecs);
    const existing = chunksMap.get(i);

    // Treat old-format IDs (e.g. "files/abc123" stored before the URI fix) as needing re-upload.
    const storedId = existing?.gemini_file_id ?? null;
    const isOldFormat = storedId !== null && !storedId.startsWith("https://");

    const needsUpload =
      !storedId ||
      isOldFormat ||
      !existing?.gemini_expires_at ||
      new Date(existing.gemini_expires_at).getTime() - now.getTime() <
        expiryBuffer;

    if (!needsUpload && storedId) {
      result.push({
        chunkIndex: i,
        geminiFileId: storedId,
        startSec,
        endSec,
      });
      continue;
    }

    // Download source video if not yet done
    if (!srcDownloaded) {
      await downloadFromR2(r2VideoKey, srcPath);
      srcDownloaded = true;
    }

    // Extract chunk at normal speed, then slow it down for Gemini
    const chunkPath = path.join(tmpBase, `chunk_${i}.mp4`);
    await extractSegment(srcPath, startSec, endSec - startSec, chunkPath);

    const slowdown = appConfig.gemini.videoSlowdownFactor;
    let uploadPath = chunkPath;
    const slowedPath = path.join(tmpBase, `chunk_${i}_slowed.mp4`);
    if (slowdown > 1) {
      await slowdownVideo(chunkPath, slowedPath, slowdown);
      await safeUnlink(chunkPath);
      uploadPath = slowedPath;
    }

    const { fileUri, expiresAt } = await uploadAndWait(uploadPath);
    await safeUnlink(uploadPath);

    // Upsert DB row
    await db.from("video_chunks").upsert(
      {
        conversation_id: conversationId,
        chunk_index: i,
        start_sec: startSec,
        end_sec: endSec,
        gemini_file_id: fileUri,
        gemini_expires_at: expiresAt.toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "conversation_id,chunk_index" },
    );

    await safeUnlink(chunkPath);

    result.push({ chunkIndex: i, geminiFileId: fileUri, startSec, endSec });
  }

  if (srcDownloaded) await safeUnlink(srcPath);

  return result;
}

/** Run the pre-step classification with Gemini Flash Lite. */
export async function extractTarget(prompt: string): Promise<PreStepResult> {
  const ai = getClient();
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-lite",
    contents: [
      {
        role: "user",
        parts: [
          { text: `${PRE_STEP_SYSTEM_PROMPT}\n\nUser prompt: "${prompt}"` },
        ],
      },
    ],
    config: { responseMimeType: "application/json" },
  });

  const text = response.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  try {
    const parsed = JSON.parse(text) as PreStepResult;
    return {
      mode: parsed.mode ?? "unsupported",
      target: parsed.target ?? prompt,
      jerseyNumber: parsed.jerseyNumber ?? null,
      jerseyColor: parsed.jerseyColor ?? null,
      teamName: parsed.teamName ?? null,
      includeAudio: parsed.includeAudio !== false,
      supported: parsed.supported !== false && parsed.mode !== "unsupported",
    };
  } catch {
    return {
      mode: "unsupported",
      target: prompt,
      jerseyNumber: null,
      jerseyColor: null,
      teamName: null,
      includeAudio: true,
      supported: false,
    };
  }
}

/**
 * Analyze a single chunk with Gemini.
 * geminiFileUri  – full URI stored in DB (e.g. https://...googleapis.com/v1beta/files/XYZ)
 * chunkDurationSec – actual duration of this segment in seconds (used to ground timestamps)
 */
export async function analyzeChunk(
  geminiFileUri: string,
  job: Job,
  chunkDurationSec: number,
): Promise<GeminiClipResult[]> {
  const ai = getClient();

  const systemPrompt =
    job.mode === "action_extraction"
      ? buildActionExtractionPrompt(job, chunkDurationSec)
      : buildCompilationPrompt(job, chunkDurationSec);

  const response = await ai.models.generateContent({
    model: "gemini-3.1-pro-preview",
    contents: [
      {
        role: "user",
        parts: [
          {
            fileData: {
              fileUri: geminiFileUri,
              mimeType: "video/mp4",
            },
            // 4fps: enough to catch fast basketball moves (dunks ~0.3-0.5s = 3-5 frames)
            // without consuming excessive tokens. Timestamps are always wall-clock seconds,
            // not frame indices.
            // fps kept lower when slowdown > 1 to stay within the 1M token budget.
            // Default slowdown=4, fps=3 → effectively 12fps of original content coverage.
            videoMetadata: { fps: appConfig.gemini.analysisFps },
          },
          { text: systemPrompt },
        ],
      },
    ],
    config: { responseMimeType: "application/json" },
  });

  const text = response.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c) =>
        typeof c.start_sec === "number" &&
        typeof c.end_sec === "number" &&
        c.end_sec > c.start_sec &&
        (c.confidence ?? 1) >= 0.6,
    );
  } catch {
    return [];
  }
}
