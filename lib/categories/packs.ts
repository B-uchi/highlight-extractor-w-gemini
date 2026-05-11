import { CategoryPack, VideoCategory } from "@/lib/categories/types";

const baseGenericPrompt =
  "Find distinct moments that are emotionally strong, surprising, informative, funny, dramatic, or visually engaging.";

export const categoryPacks: Record<VideoCategory, CategoryPack> = {
  sports: {
    id: "sports",
    label: "Sports",
    prompt:
      "Prioritize momentum shifts, scoring sequences, clutch defense, crowd reactions, and clear action outcomes.",
    minDurationSec: 12,
    maxDurationSec: 70,
    prePadSec: 1,
    postPadSec: 2,
    scoreWeights: { visual: 0.5, transcript: 0.2, audio: 0.3 },
    allowedEventTypes: ["score", "assist", "defensive_stop", "hustle_play", "momentum_shift"],
  },
  talk_podcast: {
    id: "talk_podcast",
    label: "Talk / Podcast",
    prompt: "Prioritize quotable insights, emotional moments, humor spikes, and audience-engaging statements.",
    minDurationSec: 20,
    maxDurationSec: 120,
    prePadSec: 1,
    postPadSec: 1,
    scoreWeights: { visual: 0.2, transcript: 0.6, audio: 0.2 },
    allowedEventTypes: ["quote", "insight", "debate", "reaction", "humor"],
  },
  lecture: {
    id: "lecture",
    label: "Lecture",
    prompt: "Prioritize key explanations, memorable examples, summary statements, and major conceptual transitions.",
    minDurationSec: 25,
    maxDurationSec: 150,
    prePadSec: 1,
    postPadSec: 1,
    scoreWeights: { visual: 0.15, transcript: 0.75, audio: 0.1 },
    allowedEventTypes: ["key_point", "example", "summary", "transition", "takeaway"],
  },
  vlog: {
    id: "vlog",
    label: "Vlog",
    prompt: "Prioritize high-energy moments, emotional peaks, reveal moments, and scene changes with narrative progress.",
    minDurationSec: 15,
    maxDurationSec: 90,
    prePadSec: 1,
    postPadSec: 2,
    scoreWeights: { visual: 0.45, transcript: 0.25, audio: 0.3 },
    allowedEventTypes: ["reveal", "reaction", "transition", "story_peak", "humor"],
  },
  gaming: {
    id: "gaming",
    label: "Gaming",
    prompt: "Prioritize clutch plays, boss kills, tactical turning points, and intense reactions.",
    minDurationSec: 12,
    maxDurationSec: 80,
    prePadSec: 1,
    postPadSec: 2,
    scoreWeights: { visual: 0.5, transcript: 0.2, audio: 0.3 },
    allowedEventTypes: ["clutch", "win", "boss", "comeback", "reaction"],
  },
  music: {
    id: "music",
    label: "Music",
    prompt: "Prioritize chorus drops, solos, crowd participation, emotional crescendos, and strongest vocal/instrumental moments.",
    minDurationSec: 20,
    maxDurationSec: 110,
    prePadSec: 1,
    postPadSec: 2,
    scoreWeights: { visual: 0.35, transcript: 0.15, audio: 0.5 },
    allowedEventTypes: ["chorus", "solo", "drop", "crowd_peak", "crescendo"],
  },
  generic: {
    id: "generic",
    label: "Generic",
    prompt: baseGenericPrompt,
    minDurationSec: 20,
    maxDurationSec: 90,
    prePadSec: 1,
    postPadSec: 2,
    scoreWeights: { visual: 0.4, transcript: 0.3, audio: 0.3 },
    allowedEventTypes: ["highlight"],
  },
  unknown: {
    id: "unknown",
    label: "Unknown",
    prompt: baseGenericPrompt,
    minDurationSec: 20,
    maxDurationSec: 90,
    prePadSec: 1,
    postPadSec: 2,
    scoreWeights: { visual: 0.4, transcript: 0.3, audio: 0.3 },
    allowedEventTypes: ["highlight"],
  },
};

export function getCategoryPack(category: VideoCategory): CategoryPack {
  return categoryPacks[category] ?? categoryPacks.generic;
}
