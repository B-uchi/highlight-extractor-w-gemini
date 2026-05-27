import { NextResponse } from "next/server";

import {
  ConversationsDisabledError,
  getConversation,
  updateConversation,
} from "@/lib/conversations";
import { pendingConversationJobId, saveInputVideoStream } from "@/lib/storage";

export const runtime = "nodejs";
/** Large game films can take several minutes to stream to disk. */
export const maxDuration = 900;

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

    const stored = await saveInputVideoStream(
      pendingConversationJobId(id),
      file.name,
      file.stream(),
    );
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
