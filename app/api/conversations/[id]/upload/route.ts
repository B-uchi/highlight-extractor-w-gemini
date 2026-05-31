import path from "node:path";
import { rm } from "node:fs/promises";

import { NextResponse } from "next/server";

import { preprocessVideo, getVideoDuration } from "@/lib/ffmpeg";
import { ensureTmpDir, streamToFile, uploadFileToR2 } from "@/lib/storage";
import { createServerClient } from "@/lib/supabase";
import { ensureChunksReady } from "@/lib/gemini";
import { appConfig } from "@/lib/config";
import type { UploadProgressEvent } from "@/lib/types";

export const runtime = "nodejs";

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
        emit({ step: "error", message: "Upload failed.", error: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Transfer-Encoding": "chunked" },
  });
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  const db = createServerClient();
  const { data: conv } = await db.from("conversations").select("status").eq("id", id).single();

  if (!conv) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }
  if (conv.status !== "awaiting_video") {
    return NextResponse.json({ error: "Video already uploaded for this conversation." }, { status: 409 });
  }

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Expected multipart/form-data." }, { status: 400 });
  }

  return makeStream(async (emit) => {
    const tmpBase = await ensureTmpDir(id);
    const rawPath = path.join(tmpBase, "raw_upload");

    try {
      // Parse multipart — find the video field
      const formData = await req.formData();
      const file = formData.get("video");
      if (!file || !(file instanceof File)) {
        emit({ step: "error", message: "No video field in form data." });
        return;
      }

      // Stream raw file to disk
      emit({ step: "preprocessing", message: "Receiving file..." });
      await streamToFile(file.stream(), rawPath);

      // Pre-process to 720p H.264
      emit({ step: "preprocessing", message: "Transcoding to 720p..." });
      const processedPath = path.join(tmpBase, "processed.mp4");
      await preprocessVideo(rawPath, processedPath);
      await rm(rawPath, { force: true });

      // Get duration
      const durationSecs = await getVideoDuration(processedPath);

      // Upload processed video to R2
      emit({ step: "uploading_r2", message: "Uploading to storage..." });
      const timestamp = Date.now();
      const r2Key = `videos/${id}/${timestamp}.mp4`;
      await uploadFileToR2(processedPath, r2Key);

      // Update conversation
      const originalFilename = file.name ?? "video.mp4";
      const title = originalFilename.replace(/\.[^/.]+$/, "");
      await db.from("conversations").update({
        r2_video_key: r2Key,
        video_filename: originalFilename,
        video_duration_secs: Math.round(durationSecs),
        status: "active",
        title,
        updated_at: new Date().toISOString(),
      }).eq("id", id);

      // Upload chunks to Gemini
      const chunkDuration = appConfig.gemini.chunkDurationSec;
      const totalChunks = Math.ceil(durationSecs / chunkDuration);
      emit({ step: "uploading_gemini", message: `Preparing for analysis (0/${totalChunks} chunks)...`, chunk: 0, totalChunks });

      // ensureChunksReady handles splitting and uploading each chunk
      // We emit progress per chunk by doing it ourselves here
      const chunkBoundaries: { startSec: number; endSec: number; index: number }[] = [];
      for (let i = 0; i < totalChunks; i++) {
        chunkBoundaries.push({
          index: i,
          startSec: i * chunkDuration,
          endSec: Math.min((i + 1) * chunkDuration, durationSecs),
        });
      }

      // Use ensureChunksReady for the actual upload work
      await ensureChunksReady(id, r2Key, durationSecs);
      emit({ step: "uploading_gemini", message: `Analysis ready (${totalChunks}/${totalChunks} chunks)`, chunk: totalChunks, totalChunks });

      emit({ step: "done", message: "Ready" });
    } finally {
      await rm(tmpBase, { recursive: true, force: true }).catch(() => {});
    }
  });
}
