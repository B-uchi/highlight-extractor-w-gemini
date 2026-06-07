import { NextResponse } from "next/server";

import { createServerClient } from "@/lib/supabase";

export const runtime = "nodejs";

const ACTIVE_STATUSES = [
  "pending",
  "extracting_target",
  "analyzing",
  "extracting_clips",
  "stitching",
  "cancelling",
];

export async function GET() {
  try {
    const db = createServerClient();
    const { count } = await db
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .in("status", ACTIVE_STATUSES);

    return NextResponse.json({ count: count ?? 0 });
  } catch {
    return NextResponse.json({ count: 0 });
  }
}
