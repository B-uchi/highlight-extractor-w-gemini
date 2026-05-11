export type JobStage =
  | "queued"
  | "extracting_audio"
  | "chunking_audio"
  | "transcribing"
  | "ranking"
  | "cutting"
  | "done"
  | "error";

export interface Highlight {
  startSec: number;
  endSec: number;
  title: string;
  reason: string;
  score: number;
  eventType?: string;
  confidence?: number;
  evidence?: string[];
  category?: string;
  tags?: string[];
  transcriptQuote?: string;
  keyFrameSec?: number;
  audioPeakDb?: number;
}

export interface GeneratedClip {
  id: string;
  path: string;
  url: string;
  startSec: number;
  endSec: number;
  title: string;
  score: number;
  eventType?: string;
  category?: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptResult {
  fullText: string;
  segments: TranscriptSegment[];
}

export interface OpenAiUsageMetrics {
  transcriptionSeconds: number;
}

export interface GeminiUsageMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  videoSeconds: number;
}

export interface AiUsageMetrics {
  openai: OpenAiUsageMetrics;
  gemini: GeminiUsageMetrics;
  totalTokens: number;
}

export interface JobMetrics {
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  ai: AiUsageMetrics;
  costUsdEstimate?: number;
}

export interface CandidateWindow {
  startSec: number;
  endSec: number;
  transcriptScore: number;
  audioScore: number;
  reasons: string[];
}

export interface JobState {
  id: string;
  stage: JobStage;
  progress: number;
  message: string;
  error?: string;
  inputPath: string;
  inputHash?: string;
  storageInputKey?: string;
  userPrompt?: string;
  effectivePrompt?: string;
  category?: string;
  transcriptPath?: string;
  highlightsPath?: string;
  candidatesPath?: string;
  highlights?: Highlight[];
  clips?: GeneratedClip[];
  metrics: JobMetrics;
  createdAt: string;
  updatedAt: string;
}
