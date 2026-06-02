import { NextResponse } from "next/server";

import { createServerClient } from "@/lib/supabase";
import { getPresignedUploadUrl } from "@/lib/storage";

export const runtime = "nodejs";

// Step 1 of the direct-upload flow: hand the browser a presigned PUT URL so it
// can upload the raw video straight to R2 (the bytes never pass through this
// function, avoiding Vercel's request body size limit).
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const db = createServerClient();

    const { data: conv } = await db
      .from("conversations")
      .select("status")
      .eq("id", id)
      .single();

    if (!conv) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    if (conv.status !== "awaiting_video") {
      return NextResponse.json({ error: "Video already uploaded for this conversation." }, { status: 409 });
    }

    const body = (await req.json().catch(() => ({}))) as { filename?: string };
    const originalName = body.filename ?? "video.mp4";
    const safeName = originalName.replace(/[^\w.-]/g, "_");

    // Temporary location for the raw upload; /complete transcodes it to the final key.
    const rawKey = `uploads/raw/${id}/${Date.now()}-${safeName}`;
    const uploadUrl = await getPresignedUploadUrl(rawKey, 3600);

    return NextResponse.json({ uploadUrl, key: rawKey });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unexpected error." },
      { status: 500 },
    );
  }
}
