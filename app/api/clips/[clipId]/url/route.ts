import { NextResponse } from "next/server";

import { createServerClient } from "@/lib/supabase";
import { getPresignedUrl } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(
  req: Request,
  context: { params: Promise<{ clipId: string }> },
) {
  try {
    const { clipId } = await context.params;
    const { searchParams } = new URL(req.url);
    const type = searchParams.get("type");
    const db = createServerClient();

    const { data: clip } = await db
      .from("clips")
      .select("r2_clip_key, r2_follow_up_clip_key")
      .eq("id", clipId)
      .single();

    const targetKey = type === "followup" ? clip?.r2_follow_up_clip_key : clip?.r2_clip_key;

    if (!targetKey) {
      return NextResponse.json({ error: "Clip not found." }, { status: 404 });
    }

    const url = await getPresignedUrl(targetKey);
    return NextResponse.json({ url });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unexpected error." }, { status: 500 });
  }
}
