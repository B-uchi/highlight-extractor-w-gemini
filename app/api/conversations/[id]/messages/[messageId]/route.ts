import { NextResponse } from "next/server";

import {
  ConversationsDisabledError,
  updateUserMessageContent,
} from "@/lib/conversations";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; messageId: string }> },
) {
  try {
    const { id: conversationId, messageId } = await context.params;
    const body = (await request.json()) as { content?: string };
    const content = typeof body.content === "string" ? body.content : "";
    if (!content.trim()) {
      return NextResponse.json({ error: "content is required." }, { status: 400 });
    }

    const updated = await updateUserMessageContent({
      conversationId,
      messageId,
      content,
    });

    if (!updated) {
      return NextResponse.json(
        { error: "Message not found or cannot be edited (user messages only)." },
        { status: 404 },
      );
    }

    return NextResponse.json({ message: updated });
  } catch (error) {
    if (error instanceof ConversationsDisabledError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
