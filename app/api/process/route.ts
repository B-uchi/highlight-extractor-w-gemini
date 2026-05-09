import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createJob, setJobError } from "@/lib/jobs";
import { runPipeline } from "@/lib/pipeline";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("video");
    const promptInput = formData.get("prompt");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Expected a video file in form field `video`." }, { status: 400 });
    }

    const jobId = randomUUID();
    const jobDir = path.join(process.cwd(), "tmp", jobId);
    await mkdir(jobDir, { recursive: true });

    const extension = path.extname(file.name) || ".mp4";
    const inputPath = path.join(jobDir, `input${extension}`);
    const bytes = await file.arrayBuffer();
    await writeFile(inputPath, Buffer.from(bytes));

    const userPrompt =
      typeof promptInput === "string" && promptInput.trim().length > 0 ? promptInput.trim() : undefined;

    createJob(jobId, inputPath, userPrompt);

    void runPipeline(jobId).catch((error) => {
      setJobError(jobId, error);
      console.error(`Pipeline failed for ${jobId}`, error);
    });

    return NextResponse.json({ jobId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected upload failure.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
