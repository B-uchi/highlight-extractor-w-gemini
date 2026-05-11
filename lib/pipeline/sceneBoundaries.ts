import { Highlight } from "@/lib/types";

function nearestSceneBoundary(timeSec: number, boundaries: number[]): number {
  if (boundaries.length === 0) {
    return timeSec;
  }
  let best = boundaries[0];
  let bestDistance = Math.abs(best - timeSec);
  for (const boundary of boundaries) {
    const distance = Math.abs(boundary - timeSec);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = boundary;
    }
  }
  return best;
}

export function applySceneAwareClipBoundaries(
  highlights: Highlight[],
  sceneBoundariesSec: number[],
  options: { prePadSec: number; postPadSec: number; maxDurationSec: number },
): Highlight[] {
  return highlights.map((highlight) => {
    const startWithPad = Math.max(0, highlight.startSec - options.prePadSec);
    const endWithPad = Math.min(options.maxDurationSec, highlight.endSec + options.postPadSec);
    const snappedStart = nearestSceneBoundary(startWithPad, sceneBoundariesSec);
    const snappedEnd = nearestSceneBoundary(endWithPad, sceneBoundariesSec);
    const normalizedEnd = Math.max(snappedStart + 1, snappedEnd);
    return {
      ...highlight,
      startSec: Math.max(0, snappedStart),
      endSec: Math.min(options.maxDurationSec, normalizedEnd),
    };
  });
}
