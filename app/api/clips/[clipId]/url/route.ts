import { NextResponse } from "next/server";

import { createServerClient } from "@/lib/supabase";
import { getPresignedUrl } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  context: { params: Promise<{ clipId: string }> },
) {
  try {
    const { clipId } = await context.params;
    const db = createServerClient();

    const { data: clip } = await db
      .from("clips")
      .select("r2_clip_key")
      .eq("id", clipId)
      .single();

    if (!clip?.r2_clip_key) {
      return NextResponse.json({ error: "Clip not found." }, { status: 404 });
    }

    const url = await getPresignedUrl(clip.r2_clip_key);
    return NextResponse.json({ url });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unexpected error." }, { status: 500 });
  }
}
