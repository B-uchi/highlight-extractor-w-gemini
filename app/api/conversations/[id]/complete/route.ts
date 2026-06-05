import path from "node:path";
import { rm } from "node:fs/promises";

import { NextResponse } from "next/server";

import { preprocessVideo, getVideoDuration } from "@/lib/ffmpeg";
import {
  ensureTmpDir,
  uploadFileToR2,
  downloadFromR2,
  deleteFromR2,
} from "@/lib/storage";
import { createServerClient } from "@/lib/supabase";
import { ensureChunksReady } from "@/lib/gemini";
import { appConfig } from "@/lib/config";
import type { UploadProgressEvent } from "@/lib/types";

export const runtime = "nodejs";
// Processing can take minutes. On Vercel this is bounded by maxDuration; once
// moved to a long-running Railway container there is no ceiling.
export const maxDuration = 300;

// Emits a heartbeat event every intervalMs while fn is running, keeping Railway's
// HTTP/2 proxy from closing the stream during long silent operations.
async function withHeartbeat(
  emit: (event: UploadProgressEvent) => void,
  message: string,
  fn: () => Promise<unknown>,
  intervalMs = 15_000,
): Promise<void> {
  const timer = setInterval(() => emit({ step: "heartbeat", message }), intervalMs);
  try {
    await fn();
  } finally {
    clearInterval(timer);
  }
}

function makeStream(
  handler: (emit: (event: UploadProgressEvent) => void) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: UploadProgressEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        await handler(emit);
      } catch (err) {
        emit({ step: "error", message: "Processing failed.", error: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Transfer-Encoding": "chunked" },
  });
}

// Step 2 of the direct-upload flow: the browser has already PUT the raw video to
// R2 at `key`. This downloads it, transcodes to 720p, stores the processed copy,
// marks the conversation active, and uploads chunks to Gemini.
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const db = createServerClient();

  const { data: conv } = await db.from("conversations").select("status").eq("id", id).single();
  if (!conv) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  if (conv.status !== "awaiting_video") {
    return NextResponse.json({ error: "Video already processed for this conversation." }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as { key?: string; filename?: string };
  if (!body.key) {
    return NextResponse.json({ error: "Missing upload key." }, { status: 400 });
  }
  const rawKey = body.key;
  const originalFilename = body.filename ?? "video.mp4";

  return makeStream(async (emit) => {
    const tmpBase = await ensureTmpDir(id);
    const rawPath = path.join(tmpBase, "raw_upload");
    const processedPath = path.join(tmpBase, "processed.mp4");

    try {
      // Pull the raw upload back from R2
      emit({ step: "preprocessing", message: "Fetching uploaded video..." });
      await withHeartbeat(emit, "Fetching uploaded video...",
        () => downloadFromR2(rawKey, rawPath));

      // Transcode to 720p H.264
      emit({ step: "preprocessing", message: "Transcoding..." });
      await withHeartbeat(emit, "Transcoding...",
        () => preprocessVideo(rawPath, processedPath));
      await rm(rawPath, { force: true });

      const durationSecs = await getVideoDuration(processedPath);

      // Store the processed video at the canonical key
      emit({ step: "uploading_r2", message: "Processing..." });
      const r2Key = `videos/${id}/${Date.now()}.mp4`;
      await withHeartbeat(emit, "Processing...",
        () => uploadFileToR2(processedPath, r2Key));

      const title = originalFilename.replace(/\.[^/.]+$/, "");
      await db.from("conversations").update({
        r2_video_key: r2Key,
        video_filename: originalFilename,
        video_duration_secs: Math.round(durationSecs),
        status: "active",
        title,
        updated_at: new Date().toISOString(),
      }).eq("id", id);

      // The raw temp object in R2 is no longer needed
      await deleteFromR2(rawKey).catch(() => {});

      // Upload chunks to Gemini
      const chunkDuration = appConfig.gemini.chunkDurationSec;
      const totalChunks = Math.ceil(durationSecs / chunkDuration);
      emit({ step: "uploading_gemini", message: `Preparing for analysis (0/${totalChunks} chunks)...`, chunk: 0, totalChunks });

      await ensureChunksReady(id, r2Key, durationSecs);
      emit({ step: "uploading_gemini", message: `Analysis ready (${totalChunks}/${totalChunks} chunks)`, chunk: totalChunks, totalChunks });

      emit({ step: "done", message: "Ready" });
    } finally {
      await rm(tmpBase, { recursive: true, force: true }).catch(() => {});
    }
  });
}
