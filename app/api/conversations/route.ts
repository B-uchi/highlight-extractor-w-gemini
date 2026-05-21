import { NextResponse } from "next/server";

import {
  ConversationsDisabledError,
  createConversation,
  listConversations,
} from "@/lib/conversations";

export const runtime = "nodejs";

export async function GET() {
  try {
    const [conversations, archived] = await Promise.all([
      listConversations({ archived: false }),
      listConversations({ archived: true }),
    ]);
    return NextResponse.json({ conversations, archived });
  } catch (error) {
    if (error instanceof ConversationsDisabledError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { title?: string };
    const conversation = await createConversation(
      typeof body.title === "string" && body.title.trim() ? body.title.trim() : "New conversation",
    );
    return NextResponse.json({ conversation });
  } catch (error) {
    if (error instanceof ConversationsDisabledError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
