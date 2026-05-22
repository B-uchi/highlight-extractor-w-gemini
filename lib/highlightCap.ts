import { appConfig } from "@/lib/config";
import type { HighlightClipLimitChoice, JobState } from "@/lib/types";

/** Resolve max clips after normalization; 0 means no cap (preserve all ranked highlights). */
export function resolvedMaxFinalHighlightsForJob(job: Pick<JobState, "maxHighlightsFinal">): number {
  const v = job.maxHighlightsFinal;
  if (v === undefined) return appConfig.pipeline.maxHighlightsFinal;
  return v;
}

/** Map conversation dropdown to job payload: undefined inherits env default via resolvedMaxFinalHighlightsForJob; null ⇒ unlimited (0). */
export function clipLimitChoiceToJobField(limit: HighlightClipLimitChoice | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (limit === null) return 0;
  return limit;
}

/** Parse multipart/form `highlightClipLimit` ("5"|"10"|"15"|"unlimited"). */
export function normalizeHighlightClipLimitFormValue(raw: unknown): HighlightClipLimitChoice | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  if (s === "unlimited") return null;
  if (s === "5") return 5;
  if (s === "10") return 10;
  if (s === "15") return 15;
  return undefined;
}
