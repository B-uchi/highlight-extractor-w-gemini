import { parsePlayerFocusSpec } from "@/lib/playerFocus";
import {
  buildCombinedPrompt,
  mergeUserPromptWithPresetBlock,
  normalizeProcessingPresetsState,
} from "@/lib/defaultActions";
import { createJob, setJobError, updateJob, waitForJobPersistence } from "@/lib/jobs";
import { clipLimitChoiceToJobField, normalizeHighlightClipLimitFormValue } from "@/lib/highlightCap";
import { runPipeline } from "@/lib/pipeline";
import { enqueuePipelineJob, isQueueEnabled } from "@/lib/queue";
import { saveInputVideoStream } from "@/lib/storage";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import type { ProcessingPresetsState } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 900;

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

    // Keep local copy for FFmpeg worker path; optionally mirror to object storage.
    const stored = await saveInputVideoStream(jobId, file.name, file.stream());

    const userPrompt =
      typeof promptInput === "string" && promptInput.trim().length > 0 ? promptInput.trim() : undefined;

    const category =
      typeof categoryInput === "string" && categoryInput.trim().length > 0
        ? categoryInput.trim()
        : undefined;

    const playerFocusRaw = formData.get("playerFocus");
    let playerFocus = undefined;
    if (typeof playerFocusRaw === "string" && playerFocusRaw.trim()) {
      try {
        const parsed = JSON.parse(playerFocusRaw) as unknown;
        playerFocus = parsePlayerFocusSpec(parsed) ?? undefined;
      } catch {
        return NextResponse.json({ error: "Invalid JSON in playerFocus field." }, { status: 400 });
      }
    }

    let processingPresets: ProcessingPresetsState | null | undefined = undefined;
    const processingPresetsRaw = formData.get("processingPresets");
    if (typeof processingPresetsRaw === "string" && processingPresetsRaw.trim()) {
      try {
        const parsed = JSON.parse(processingPresetsRaw) as unknown;
        processingPresets = normalizeProcessingPresetsState(parsed as ProcessingPresetsState) ?? null;
      } catch {
        return NextResponse.json({ error: "Invalid JSON in processingPresets field." }, { status: 400 });
      }
    }

    const presetBlock =
      processingPresets?.selectedIds?.length
        ? buildCombinedPrompt(processingPresets.selectedIds, processingPresets.placeholders ?? null)
        : "";

    const mergedUserPrompt = mergeUserPromptWithPresetBlock(userPrompt, presetBlock || null);

    const hlForm = normalizeHighlightClipLimitFormValue(formData.get("highlightClipLimit"));

    createJob(
      jobId,
      stored.path,
      mergedUserPrompt,
      undefined,
      category,
      undefined,
      playerFocus,
      processingPresets,
      clipLimitChoiceToJobField(hlForm),
    );
    if (stored.key) {
      updateJob(jobId, { storageInputKey: stored.key });
    }
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
