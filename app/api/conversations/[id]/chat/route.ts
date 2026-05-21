import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { runAgentTurn } from "@/lib/agent/orchestrator";
import type { AgentStreamEvent } from "@/lib/agent/types";
import {
  appendMessage,
  ConversationsDisabledError,
  getConversation,
  listMessagesForConversation,
  updateConversation,
} from "@/lib/conversations";

export const runtime = "nodejs";

function sseEncode(event: string, data: unknown): Uint8Array {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return new TextEncoder().encode(`event: ${event}\ndata: ${payload}\n\n`);
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as { content?: string };
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content) {
      return NextResponse.json({ error: "content is required." }, { status: 400 });
    }

    const existing = await getConversation(id);
    if (!existing) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    }

    await appendMessage({ conversationId: id, role: "user", content });

    if (existing.title === "New conversation") {
      const nextTitle = content.slice(0, 80) || "Conversation";
      await updateConversation(id, { title: nextTitle });
    }

    const messages = await listMessagesForConversation(id);

    const assistantId = randomUUID();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const push = (event: string, data: unknown) => {
          controller.enqueue(sseEncode(event, data));
        };

        try {
          const text = await runAgentTurn({
            conversationId: id,
            messages,
            emit: (e: AgentStreamEvent) => {
              if (e.type === "message_delta") {
                push("message_delta", { text: e.text });
                return;
              }
              if (e.type === "tool_call") {
                push("tool_call", { name: e.name, args: e.args });
                return;
              }
              if (e.type === "tool_result") {
                push("tool_result", { name: e.name, ok: e.ok, summary: e.summary });
                return;
              }
              if (e.type === "task_update") {
                push("task_update", e);
                return;
              }
              if (e.type === "job_update") {
                push("job_update", e);
                return;
              }
              push(e.type, e);
            },
          });

          await appendMessage({
            id: assistantId,
            conversationId: id,
            role: "assistant",
            content: text,
            metadata: { source: "agent" },
          });

          push("done", { assistantMessageId: assistantId } satisfies { assistantMessageId: string });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          push("error", { message });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  } catch (error) {
    if (error instanceof ConversationsDisabledError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
