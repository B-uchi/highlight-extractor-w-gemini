import { NextResponse } from "next/server";

import {
  ConversationsDisabledError,
  deleteConversation,
  getConversation,
  listAgentTasksForConversation,
  listMessagesForConversation,
  updateConversation,
} from "@/lib/conversations";
import { getJob, hydrateJobFromStore } from "@/lib/jobs";
import { isDatabaseEnabled } from "@/lib/db";
import type { HighlightClipLimitChoice, JobState } from "@/lib/types";

export const runtime = "nodejs";

async function resolveJob(jobId: string | null): Promise<JobState | null> {
  if (!jobId) {
    return null;
  }
  if (isDatabaseEnabled()) {
    return (await hydrateJobFromStore(jobId)) ?? getJob(jobId) ?? null;
  }
  return getJob(jobId) ?? (await hydrateJobFromStore(jobId)) ?? null;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const conversation = await getConversation(id);
    if (!conversation) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    }

    const [messages, agentTasks, job] = await Promise.all([
      listMessagesForConversation(id),
      listAgentTasksForConversation(id),
      resolveJob(conversation.activeJobId),
    ]);

    return NextResponse.json({ conversation, messages, agentTasks, job });
  } catch (error) {
    if (error instanceof ConversationsDisabledError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as {
      title?: string;
      archived?: boolean;
      highlight_clip_limit?: HighlightClipLimitChoice | "unlimited" | number | string | null;
    };
    const existing = await getConversation(id);
    if (!existing) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    }

    const patch: Parameters<typeof updateConversation>[1] = {};
    if (typeof body.title === "string") {
      const title = body.title.trim();
      if (!title) {
        return NextResponse.json({ error: "Title cannot be empty." }, { status: 400 });
      }
      patch.title = title;
    }
    if (typeof body.archived === "boolean") {
      patch.archivedAt = body.archived ? new Date().toISOString() : null;
    }
    if (body.highlight_clip_limit !== undefined) {
      const v = body.highlight_clip_limit;
      if (v === null || v === "unlimited") {
        patch.highlightClipLimit = null;
      } else if (v === 5 || v === 10 || v === 15) {
        patch.highlightClipLimit = v;
      } else if (v === "5" || v === "10" || v === "15") {
        patch.highlightClipLimit = Number(v) as 5 | 10 | 15;
      } else {
        return NextResponse.json({ error: "Invalid highlight_clip_limit." }, { status: 400 });
      }
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "No valid fields to update." }, { status: 400 });
    }

    const conversation = await updateConversation(id, patch);
    return NextResponse.json({ conversation });
  } catch (error) {
    if (error instanceof ConversationsDisabledError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const deleted = await deleteConversation(id);
    if (!deleted) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ConversationsDisabledError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
