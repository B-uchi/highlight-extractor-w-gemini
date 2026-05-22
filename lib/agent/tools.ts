import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Type } from "@google/genai";
import type { FunctionDeclaration } from "@google/genai";

import { explainClipWithGemini } from "@/lib/agent/explainClip";
import {
  buildCombinedPrompt,
  mergeProcessingPresetsState,
  mergeUserPromptWithPresetBlock,
  normalizeProcessingPresetsState,
} from "@/lib/defaultActions";
import { parsePlayerFocusSpec } from "@/lib/playerFocus";
import type { AgentStreamEvent } from "@/lib/agent/types";
import { upsertAgentTask, getConversation, updateConversation } from "@/lib/conversations";
import { isDatabaseEnabled } from "@/lib/db";
import { clipLimitChoiceToJobField } from "@/lib/highlightCap";
import { createJob, waitForJobPersistence, getJob, hydrateJobFromStore, setJobError, updateJob } from "@/lib/jobs";
import { runPipeline } from "@/lib/pipeline";
import { runRefineHighlights, summarizeJobForAgent } from "@/lib/pipeline/refine";
import { enqueuePipelineJob, isQueueEnabled } from "@/lib/queue";
import { buildReelFile } from "@/lib/reel";
import { saveInputVideo } from "@/lib/storage";
import type { ProcessingPresetsState } from "@/lib/types";

function coerceToolProcessingPresets(raw: unknown): ProcessingPresetsState | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }
  const o = raw as Record<string, unknown>;

  const KNOWN_KEYS = new Set([
    "selected_preset_ids",
    "selectedIds",
    "team_highlight_name",
    "teamHighlightName",
    "primary_player_name",
    "primaryPlayerName",
    "primary_jersey_number",
    "primaryJerseyNumber",
    "individual_team_name",
    "individualTeamName",
    "jersey_color",
    "jerseyColor",
  ]);
  const touchesKnown = Object.keys(o).some((k) => KNOWN_KEYS.has(k));
  if (!touchesKnown) {
    return undefined;
  }

  const idsRaw = Array.isArray(o.selected_preset_ids)
    ? o.selected_preset_ids
    : Array.isArray(o.selectedIds)
      ? o.selectedIds
      : [];
  const selectedIds = idsRaw.filter((x): x is string => typeof x === "string");

  const teamHighlightName =
    typeof o.team_highlight_name === "string"
      ? o.team_highlight_name.trim()
      : typeof o.teamHighlightName === "string"
        ? o.teamHighlightName.trim()
        : undefined;

  const primaryPlayerName =
    typeof o.primary_player_name === "string"
      ? o.primary_player_name.trim()
      : typeof o.primaryPlayerName === "string"
        ? o.primaryPlayerName.trim()
        : undefined;

  const primaryJerseyNumber =
    typeof o.primary_jersey_number === "string"
      ? o.primary_jersey_number.trim()
      : typeof o.primaryJerseyNumber === "string"
        ? o.primaryJerseyNumber.trim()
        : undefined;

  const individualTeamName =
    typeof o.individual_team_name === "string"
      ? o.individual_team_name.trim()
      : typeof o.individualTeamName === "string"
        ? o.individualTeamName.trim()
        : undefined;

  const jerseyColor =
    typeof o.jersey_color === "string"
      ? o.jersey_color.trim()
      : typeof o.jerseyColor === "string"
        ? o.jerseyColor.trim()
        : undefined;

  const placeholders =
    teamHighlightName || primaryPlayerName || primaryJerseyNumber || individualTeamName || jerseyColor
      ? {
          ...(teamHighlightName ? { teamHighlightName } : {}),
          ...(primaryPlayerName ? { primaryPlayerName } : {}),
          ...(primaryJerseyNumber ? { primaryJerseyNumber } : {}),
          ...(individualTeamName ? { individualTeamName } : {}),
          ...(jerseyColor ? { jerseyColor } : {}),
        }
      : undefined;

  return (
    normalizeProcessingPresetsState({
      selectedIds,
      ...(placeholders ? { placeholders } : {}),
    }) ?? undefined
  );
}

function isExplicitPresetEmptySelection(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) {
    return false;
  }
  const o = raw as Record<string, unknown>;
  const hasSelectedIdsKey =
    Object.prototype.hasOwnProperty.call(o, "selected_preset_ids") ||
    Object.prototype.hasOwnProperty.call(o, "selectedIds");

  const idsRaw = Array.isArray(o.selected_preset_ids)
    ? o.selected_preset_ids
    : Array.isArray(o.selectedIds)
      ? o.selectedIds
      : null;

  if (!hasSelectedIdsKey || idsRaw === null) {
    return false;
  }

  return idsRaw.every((entry) => typeof entry === "string") && idsRaw.length === 0;
}

export function getAgentFunctionDeclarations(): FunctionDeclaration[] {
  return [
    {
      name: "start_processing",
      description:
        "Start the full video-highlight pipeline now for this conversation's pending uploaded file (must already be uploaded). Prefer calling this proactively in the same turn when prerequisites are met and the user conveys extraction/analysis/highlight intent or detailed player/roster targeting — do not ask them to confirm readiness first.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          prompt: {
            type: Type.STRING,
            description:
              "Highlight/analysis instructions synthesized from the latest user message(s). Omit only if intent is vague; normally pass a concise summary whenever you call start_processing after the user describes what they want.",
          },
          category: {
            type: Type.STRING,
            description: "Video category override (e.g. auto, sports, talk_podcast).",
          },
          player_focus: {
            type: Type.OBJECT,
            description:
              "Optional structured player/team targeting (jersey colors, roster, primary target). Merged with any targeting saved on the conversation.",
            properties: {
              teamAName: { type: Type.STRING },
              jerseyColors: { type: Type.ARRAY, items: { type: Type.STRING } },
              identificationPrompt: { type: Type.STRING },
              roster: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    jerseyNumber: { type: Type.STRING },
                    displayName: { type: Type.STRING },
                    photoUrl: { type: Type.STRING },
                    height: { type: Type.STRING },
                    buildProfile: { type: Type.STRING },
                    accessoryNotes: { type: Type.STRING },
                  },
                },
              },
              primaryTarget: {
                type: Type.OBJECT,
                properties: {
                  jerseyNumber: { type: Type.STRING },
                  isolationPrompt: { type: Type.STRING },
                },
              },
            },
          },
          processing_presets: {
            type: Type.OBJECT,
            description:
              "Optional tweak merged onto the user's saved checklist from the Processing presets workspace panel. Omit to rely solely on the conversation's stored presets.",
            properties: {
              selected_preset_ids: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description:
                  "Subset of ids: player_identification, highlight_events, team_highlight, individual_player_highlight, clip_quality_rules, ranking_prompt, output_prompt.",
              },
              team_highlight_name: { type: Type.STRING },
              primary_player_name: { type: Type.STRING },
              primary_jersey_number: { type: Type.STRING },
              individual_team_name: { type: Type.STRING, description: "Fills [Team Name] in the individual-player preset." },
              jersey_color: { type: Type.STRING, description: "Fills [jersey color] in the individual-player preset." },
            },
          },
        },
      },
    },
    {
      name: "get_job_status",
      description: "Fetch the current processing job snapshot for this conversation.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          job_id: { type: Type.STRING, description: "Job id. Defaults to the conversation's active job." },
        },
      },
    },
    {
      name: "list_highlights",
      description: "List highlights/clips for a job with optional filters.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          job_id: { type: Type.STRING, description: "Job id. Defaults to active job." },
          min_score: { type: Type.NUMBER, description: "Minimum score 0-100." },
          event_type: { type: Type.STRING, description: "Filter by event type substring." },
        },
      },
    },
    {
      name: "refine_highlights",
      description:
        "Re-run highlight detection using the existing transcript (faster than a full reprocess). Provide updated instructions.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          job_id: { type: Type.STRING, description: "Job id. Defaults to active job." },
          new_prompt: { type: Type.STRING, description: "New highlight instructions." },
        },
        required: ["new_prompt"],
      },
    },
    {
      name: "build_reel",
      description:
        "Concatenate selected clips into a single reel MP4 on disk for download from the workspace UI.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          job_id: { type: Type.STRING, description: "Job id. Defaults to active job." },
          clip_ids: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Clip ids in order (e.g. clip-001).",
          },
        },
      },
    },
    {
      name: "explain_clip",
      description: "Answer a question about a specific generated clip using metadata and transcript context.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          job_id: { type: Type.STRING, description: "Job id. Defaults to active job." },
          clip_id: { type: Type.STRING, description: "Clip id like clip-001." },
          question: { type: Type.STRING, description: "User question about the clip." },
        },
        required: ["clip_id", "question"],
      },
    },
  ];
}

export interface ToolContext {
  conversationId: string;
  emit: (event: AgentStreamEvent) => void;
}

async function resolveActiveJobId(conversationId: string, explicit?: string): Promise<string | null> {
  if (explicit) {
    return explicit;
  }
  const conv = await getConversation(conversationId);
  return conv?.activeJobId ?? null;
}

export async function executeAgentTool(params: {
  name: string;
  args: Record<string, unknown>;
  ctx: ToolContext;
}): Promise<Record<string, unknown>> {
  const { name, args, ctx } = params;

  switch (name) {
    case "start_processing": {
      const conv = await getConversation(ctx.conversationId);
      if (!conv?.pendingInputPath) {
        return { error: "No uploaded video pending for this conversation. Upload a video first." };
      }

      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : undefined;
      const category =
        typeof args.category === "string" && args.category.trim() ? args.category.trim() : undefined;

      const fromArgs = parsePlayerFocusSpec(args.player_focus);
      const fromConv = conv.playerFocus ?? undefined;
      const mergedFocus = fromArgs ?? fromConv;

      const presetArgProvided = Object.prototype.hasOwnProperty.call(args, "processing_presets");

      let mergedPresetState: ProcessingPresetsState | null = normalizeProcessingPresetsState(conv.processingPresets ?? null);
      if (presetArgProvided) {
        if (isExplicitPresetEmptySelection(args.processing_presets)) {
          mergedPresetState = null;
        } else {
          const overlay = coerceToolProcessingPresets(args.processing_presets);
          if (overlay) {
            mergedPresetState = mergeProcessingPresetsState(conv.processingPresets, overlay);
          }
        }
      }

      const presetBlock =
        mergedPresetState && mergedPresetState.selectedIds.length > 0
          ? buildCombinedPrompt(mergedPresetState.selectedIds, mergedPresetState.placeholders ?? null)
          : "";

      const combinedPrompt = mergeUserPromptWithPresetBlock(prompt, presetBlock || null);

      const bytes = await readFile(conv.pendingInputPath);
      const jobId = randomUUID();
      const stored = await saveInputVideo(jobId, basename(conv.pendingInputPath), bytes);

      createJob(
        jobId,
        stored.path,
        combinedPrompt,
        undefined,
        category,
        ctx.conversationId,
        mergedFocus,
        mergedPresetState,
        clipLimitChoiceToJobField(conv.highlightClipLimit),
      );
      if (stored.key) {
        updateJob(jobId, { storageInputKey: stored.key });
      }
      await waitForJobPersistence(jobId);
      await updateConversation(ctx.conversationId, {
        activeJobId: jobId,
        pendingInputPath: null,
        playerFocus: null,
      });

      if (isDatabaseEnabled()) {
        await upsertAgentTask({
          id: `${jobId}-agent-upload`,
          conversationId: ctx.conversationId,
          jobId,
          type: "upload",
          status: "done",
          progress: 100,
          label: "Receive video",
          detail: stored.path,
        });
      }

      if (isQueueEnabled()) {
        await enqueuePipelineJob(jobId);
      } else {
        void runPipeline(jobId).catch((error) => {
          setJobError(jobId, error);
          console.error(`Pipeline failed for ${jobId}`, error);
        });
      }

      ctx.emit({ type: "job_update", jobId, stage: "queued", progress: 0 });
      return { ok: true, job_id: jobId, message: "Processing started." };
    }
    case "get_job_status": {
      const jobId = await resolveActiveJobId(ctx.conversationId, typeof args.job_id === "string" ? args.job_id : undefined);
      if (!jobId) {
        return { error: "No active job." };
      }
      const job = isDatabaseEnabled()
        ? (await hydrateJobFromStore(jobId)) ?? getJob(jobId)
        : getJob(jobId) ?? (await hydrateJobFromStore(jobId));
      if (!job) {
        return { error: `Job not found: ${jobId}` };
      }
      return { job: summarizeJobForAgent(job) };
    }
    case "list_highlights": {
      const jobId = await resolveActiveJobId(ctx.conversationId, typeof args.job_id === "string" ? args.job_id : undefined);
      if (!jobId) {
        return { error: "No active job." };
      }
      const job = isDatabaseEnabled()
        ? (await hydrateJobFromStore(jobId)) ?? getJob(jobId)
        : getJob(jobId) ?? (await hydrateJobFromStore(jobId));
      if (!job) {
        return { error: `Job not found: ${jobId}` };
      }

      const minScore = typeof args.min_score === "number" ? args.min_score : 0;
      const eventFilter =
        typeof args.event_type === "string" && args.event_type.trim()
          ? args.event_type.trim().toLowerCase()
          : null;

      const highlights = (job.highlights ?? []).filter((h) => {
        if (h.score < minScore) {
          return false;
        }
        if (eventFilter && !(h.eventType ?? "").toLowerCase().includes(eventFilter)) {
          return false;
        }
        return true;
      });

      const clips = (job.clips ?? []).filter((c) => {
        if (c.score < minScore) {
          return false;
        }
        if (eventFilter && !(c.eventType ?? "").toLowerCase().includes(eventFilter)) {
          return false;
        }
        return true;
      });

      return {
        job_id: jobId,
        stage: job.stage,
        highlight_count: highlights.length,
        clip_count: clips.length,
        highlights: highlights.slice(0, 30),
        clips: clips.map((c) => ({
          id: c.id,
          title: c.title,
          score: c.score,
          startSec: c.startSec,
          endSec: c.endSec,
          eventType: c.eventType,
        })),
      };
    }
    case "refine_highlights": {
      const jobId = await resolveActiveJobId(ctx.conversationId, typeof args.job_id === "string" ? args.job_id : undefined);
      if (!jobId) {
        return { error: "No active job." };
      }
      const newPrompt = typeof args.new_prompt === "string" ? args.new_prompt.trim() : "";
      if (!newPrompt) {
        return { error: "new_prompt is required." };
      }
      ctx.emit({ type: "message_delta", text: "\n\n_Re-running highlight ranking…_\n\n" });
      await runRefineHighlights(jobId, newPrompt);
      return { ok: true, job_id: jobId, message: "Refine complete." };
    }
    case "build_reel": {
      const jobId = await resolveActiveJobId(ctx.conversationId, typeof args.job_id === "string" ? args.job_id : undefined);
      if (!jobId) {
        return { error: "No active job." };
      }
      const clipIds = Array.isArray(args.clip_ids) ? (args.clip_ids as unknown[]).filter((x) => typeof x === "string") as string[] : undefined;

      if (isDatabaseEnabled()) {
        await upsertAgentTask({
          id: `${jobId}-build-reel`,
          conversationId: ctx.conversationId,
          jobId,
          type: "build_reel",
          status: "running",
          progress: 10,
          label: "Build reel",
          detail: clipIds?.join(", ") ?? "all clips",
        });
      }

      const { outputPath, selectedClips } = await buildReelFile(jobId, clipIds);

      if (isDatabaseEnabled()) {
        await upsertAgentTask({
          id: `${jobId}-build-reel`,
          conversationId: ctx.conversationId,
          jobId,
          type: "build_reel",
          status: "done",
          progress: 100,
          label: "Build reel",
          detail: outputPath,
        });
      }

      return {
        ok: true,
        job_id: jobId,
        clip_count: selectedClips.length,
        output_path: outputPath,
        hint: "The reel is available on disk for this job; you can also download via the Reel panel (POST /api/reel/{jobId}).",
      };
    }
    case "explain_clip": {
      const jobId = await resolveActiveJobId(ctx.conversationId, typeof args.job_id === "string" ? args.job_id : undefined);
      if (!jobId) {
        return { error: "No active job." };
      }
      const clipId = typeof args.clip_id === "string" ? args.clip_id.trim() : "";
      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (!clipId || !question) {
        return { error: "clip_id and question are required." };
      }
      if (isDatabaseEnabled()) {
        await upsertAgentTask({
          id: `${jobId}-explain-${clipId}`,
          conversationId: ctx.conversationId,
          jobId,
          type: "explain",
          status: "running",
          progress: 50,
          label: `Explain ${clipId}`,
          detail: question,
        });
      }
      const answer = await explainClipWithGemini({ jobId, clipId, question });
      if (isDatabaseEnabled()) {
        await upsertAgentTask({
          id: `${jobId}-explain-${clipId}`,
          conversationId: ctx.conversationId,
          jobId,
          type: "explain",
          status: "done",
          progress: 100,
          label: `Explain ${clipId}`,
          detail: "Done",
        });
      }
      return { answer };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
