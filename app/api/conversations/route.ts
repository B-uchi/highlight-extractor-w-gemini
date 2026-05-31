import { NextResponse } from "next/server";

import { createServerClient } from "@/lib/supabase";

export const runtime = "nodejs";

export async function GET() {
  try {
    const db = createServerClient();
    const { data, error } = await db
      .from("conversations")
      .select("id, title, status, video_filename, video_duration_secs, created_at, updated_at, archived_at")
      .order("updated_at", { ascending: false });

    if (error) throw new Error(error.message);

    const conversations = (data ?? []).filter((c) => !c.archived_at);
    const archived = (data ?? []).filter((c) => c.archived_at);
    return NextResponse.json({ conversations, archived });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unexpected error." }, { status: 500 });
  }
}

export async function POST() {
  try {
    const db = createServerClient();
    const { data, error } = await db
      .from("conversations")
      .insert({ title: "New conversation", status: "awaiting_video" })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ conversation: data }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unexpected error." }, { status: 500 });
  }
}
