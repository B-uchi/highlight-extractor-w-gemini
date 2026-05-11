import { NextResponse } from "next/server";

import { getPrometheusMetrics } from "@/lib/observability";

export const runtime = "nodejs";

export async function GET() {
  const body = await getPrometheusMetrics();
  return new NextResponse(body, {
    headers: {
      "content-type": "text/plain; version=0.0.4",
    },
  });
}
