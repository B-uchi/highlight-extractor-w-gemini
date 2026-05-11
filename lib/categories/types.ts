export type VideoCategory =
  | "sports"
  | "talk_podcast"
  | "lecture"
  | "vlog"
  | "gaming"
  | "music"
  | "generic"
  | "unknown";

export interface CategoryPack {
  id: VideoCategory;
  label: string;
  prompt: string;
  minDurationSec: number;
  maxDurationSec: number;
  prePadSec: number;
  postPadSec: number;
  scoreWeights: {
    visual: number;
    transcript: number;
    audio: number;
  };
  allowedEventTypes: string[];
}
