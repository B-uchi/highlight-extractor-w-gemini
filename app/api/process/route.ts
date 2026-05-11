import { createJob, setJobError, waitForJobPersistence } from "@/lib/jobs";
import { runPipeline } from "@/lib/pipeline";
import { enqueuePipelineJob, isQueueEnabled } from "@/lib/queue";
import { saveInputVideo } from "@/lib/storage";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("video");
    const promptInput = formData.get("prompt");
    const categoryInput = formData.get("category");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Expected a video file in form field `video`." }, { status: 400 });
    }

    const jobId = randomUUID();
    const bytes = await file.arrayBuffer();
    const inputBuffer = Buffer.from(bytes);

    // Keep local copy for FFmpeg worker path; optionally mirror to object storage.
    const stored = await saveInputVideo(jobId, file.name, inputBuffer);

    const userPrompt =
      typeof promptInput === "string" && promptInput.trim().length > 0 ? promptInput.trim() : undefined;

    const category =
      typeof categoryInput === "string" && categoryInput.trim().length > 0
        ? categoryInput.trim()
        : undefined;

    createJob(jobId, stored.path, userPrompt, undefined, category);
    await waitForJobPersistence(jobId);

    if (isQueueEnabled()) {
      await enqueuePipelineJob(jobId);
    } else {
      void runPipeline(jobId).catch((error) => {
        setJobError(jobId, error);
        console.error(`Pipeline failed for ${jobId}`, error);
      });
    }

    return NextResponse.json({ jobId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected upload failure.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
