import { NextResponse } from "next/server";

import {
  ConversationsDisabledError,
  getConversation,
  updateConversation,
} from "@/lib/conversations";
import { pendingConversationJobId, saveInputVideo } from "@/lib/storage";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const existing = await getConversation(id);
    if (!existing) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    }

    const formData = await request.formData();
    const file = formData.get("video");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Expected a video file in form field `video`." }, { status: 400 });
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const stored = await saveInputVideo(pendingConversationJobId(id), file.name, bytes);
    await updateConversation(id, {
      pendingInputPath: stored.path,
    });

    return NextResponse.json({
      pendingInputPath: stored.path,
      key: stored.key,
    });
  } catch (error) {
    if (error instanceof ConversationsDisabledError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
