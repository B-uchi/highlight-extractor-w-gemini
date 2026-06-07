import path from "node:path";
import { rm } from "node:fs/promises";

import { FileState, GoogleGenAI } from "@google/genai";

import { config } from "./config";
import { extractSegment, slowdownVideo } from "./ffmpeg";
import { db } from "./db";
import { downloadFromR2, ensureTmpDir, safeUnlink } from "./storage";
import type { GeminiClipResult, PreStepResult, VideoChunk, Job } from "./types";
import { buildActionExtractionPrompt, buildCompilationPrompt, PRE_STEP_SYSTEM_PROMPT } from "./prompts";

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

let geminiSingleton: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (geminiSingleton) return geminiSingleton;
  geminiSingleton = new GoogleGenAI({
    apiKey: config.gemini.apiKey,
    httpOptions: { timeout: config.gemini.httpTimeoutMs },
  });
  return geminiSingleton;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

function extractGeminiFileName(uri: string): string | null {
  const match = uri.match(/\/v1beta\/(files\/[^/?]+)/);
  return match?.[1] ?? null;
}

export function isStorageQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("file_storage_bytes");
}

export function isBillingQuotaError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("billing_not_enabled") ||
    msg.includes("check your plan and billing") ||
    msg.includes("per_day") ||
    msg.includes("free_tier") ||
    msg.includes("insufficient_quota")
  );
}

async function evictGeminiFilesForOtherConversations(conversationId: string): Promise<number> {
  const ai = getClient();

  const { data: activeJobs } = await db
    .from("jobs")
    .select("conversation_id")
    .in("status", ["extracting_target", "analyzing", "extracting_clips", "stitching"]);

  const protectedConvIds = new Set<string>(
    (activeJobs ?? []).map((j: { conversation_id: string }) => j.conversation_id),
  );
  protectedConvIds.add(conversationId);

  const { data: allChunks } = await db
    .from("video_chunks")
    .select("id, gemini_file_id, conversation_id")
    .not("gemini_file_id", "is", null)
    .order("gemini_expires_at", { ascending: true });

  if (!allChunks?.length) return 0;

  const toEvict = (allChunks as { id: string; gemini_file_id: string; conversation_id: string }[])
    .filter((row) => !protectedConvIds.has(row.conversation_id));

  if (!toEvict.length) return 0;

  await Promise.allSettled(
    toEvict.map(async (row) => {
      const name = extractGeminiFileName(row.gemini_file_id);
      if (name) {
        try { await ai.files.delete({ name }); } catch { /* may already be expired */ }
      }
    }),
  );

  await db
    .from("video_chunks")
    .update({ gemini_file_id: null, gemini_expires_at: null, updated_at: new Date().toISOString() })
    .in("id", toEvict.map((r) => r.id));

  console.log(`[gemini] evicted ${toEvict.length} Gemini file(s) from other conversations to free storage`);
  return toEvict.length;
}

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

export async function ensureChunksReady(
  conversationId: string,
  r2VideoKey: string,
  videoDurationSecs: number,
): Promise<{ chunkIndex: number; geminiFileId: string; startSec: number; endSec: number }[]> {
  const now = new Date();
  const expiryBuffer = 60 * 60 * 1000;
  const CHUNK_DURATION_SEC = config.gemini.chunkDurationSec;

  const { data: existingChunks } = await db
    .from("video_chunks")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("chunk_index");

  const chunkCount = Math.ceil(videoDurationSecs / CHUNK_DURATION_SEC);
  const result: { chunkIndex: number; geminiFileId: string; startSec: number; endSec: number }[] = [];

  const tmpBase = await ensureTmpDir(`gemini-${conversationId}`);
  const srcPath = path.join(tmpBase, "source.mp4");
  let srcDownloaded = false;

  const chunksMap = new Map<number, VideoChunk>(
    (existingChunks ?? []).map((c: VideoChunk) => [c.chunk_index, c]),
  );

  try {
    for (let i = 0; i < chunkCount; i++) {
      const startSec = i * CHUNK_DURATION_SEC;
      const endSec = Math.min((i + 1) * CHUNK_DURATION_SEC, videoDurationSecs);
      const existing = chunksMap.get(i);

      const storedId = existing?.gemini_file_id ?? null;
      const isOldFormat = storedId !== null && !storedId.startsWith("https://");

      const needsUpload =
        !storedId ||
        isOldFormat ||
        !existing?.gemini_expires_at ||
        new Date(existing.gemini_expires_at).getTime() - now.getTime() < expiryBuffer;

      if (!needsUpload && storedId) {
        result.push({ chunkIndex: i, geminiFileId: storedId, startSec, endSec });
        continue;
      }

      if (!srcDownloaded) {
        await downloadFromR2(r2VideoKey, srcPath);
        srcDownloaded = true;
      }

      const chunkPath = path.join(tmpBase, `chunk_${i}.mp4`);
      await extractSegment(srcPath, startSec, endSec - startSec, chunkPath);

      const slowdown = config.gemini.videoSlowdownFactor;
      let uploadPath = chunkPath;
      const slowedPath = path.join(tmpBase, `chunk_${i}_slowed.mp4`);
      if (slowdown > 1) {
        await slowdownVideo(chunkPath, slowedPath, slowdown);
        await safeUnlink(chunkPath);
        uploadPath = slowedPath;
      }

      let uploadResult: { fileUri: string; expiresAt: Date };
      try {
        uploadResult = await uploadAndWait(uploadPath);
      } catch (uploadErr) {
        if (isStorageQuotaError(uploadErr)) {
          console.warn("[gemini] Storage quota hit — evicting files from other conversations");
          const evicted = await evictGeminiFilesForOtherConversations(conversationId);
          if (evicted === 0) {
            throw new Error(
              "Gemini file storage is full and no files from other conversations could be freed. " +
              "Delete some conversations or wait for files to expire (up to 48 hours).",
            );
          }
          uploadResult = await uploadAndWait(uploadPath);
        } else {
          throw uploadErr;
        }
      }
      const { fileUri, expiresAt } = uploadResult;
      await safeUnlink(uploadPath);

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

    return result;
  } finally {
    await rm(tmpBase, { recursive: true, force: true }).catch(() => {});
  }
}

export async function extractTarget(prompt: string): Promise<PreStepResult> {
  const ai = getClient();
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-lite",
    contents: [
      {
        role: "user",
        parts: [{ text: `${PRE_STEP_SYSTEM_PROMPT}\n\nUser prompt: "${prompt}"` }],
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

export function retryDelayMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.includes("RESOURCE_EXHAUSTED") && !msg.includes("429")) return null;
  if (isBillingQuotaError(err)) return null; // Hard quota — not retryable
  const match = msg.match(/"retryDelay":\s*"([\d.]+)s"/);
  // Honour the server-specified delay + 2s buffer, or fall back to 60s.
  return match ? Math.ceil(parseFloat(match[1])) * 1000 + 2_000 : 60_000;
}

export function estimateChunkTokens(chunkDurationSec: number): number {
  return Math.ceil(chunkDurationSec * config.gemini.videoSlowdownFactor * config.gemini.analysisFps * 258);
}

const MAX_ANALYZE_RETRIES = 3;

export async function analyzeChunk(
  geminiFileUri: string,
  job: Job,
  chunkDurationSec: number,
  signal?: AbortSignal,
): Promise<GeminiClipResult[]> {
  const ai = getClient();

  const systemPrompt =
    job.mode === "action_extraction"
      ? buildActionExtractionPrompt(job, chunkDurationSec)
      : buildCompilationPrompt(job, chunkDurationSec);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ANALYZE_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-pro",
        contents: [
          {
            role: "user",
            parts: [
              {
                fileData: { fileUri: geminiFileUri, mimeType: "video/mp4" },
                videoMetadata: { fps: config.gemini.analysisFps },
              },
              { text: systemPrompt },
            ],
          },
        ],
        config: { responseMimeType: "application/json", abortSignal: signal },
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
    } catch (err) {
      // AbortError means a user-initiated cancel — propagate immediately.
      if ((err as Error)?.name === "AbortError") throw err;
      // Billing quota is not retryable — propagate immediately.
      if (isBillingQuotaError(err)) throw err;
      lastErr = err;
      const delay = retryDelayMs(err);
      if (delay === null || attempt === MAX_ANALYZE_RETRIES) throw err;
      console.warn(`[gemini] 429 on chunk — waiting ${delay}ms before retry ${attempt + 1}/${MAX_ANALYZE_RETRIES}`);
      await sleep(delay);
    }
  }
  throw lastErr;
}
