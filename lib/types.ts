export type JobStage =
  | "queued"
  | "extracting_audio"
  | "chunking_audio"
  | "transcribing"
  | "ranking"
  | "cutting"
  | "done"
  | "error";

/** Optional substitutions for templated preset copy (dashboard + agent overlays). */
export interface ProcessingPresetsPlaceholders {
  teamHighlightName?: string;
  primaryPlayerName?: string;
  primaryJerseyNumber?: string;
}

/** Multi-select checklist + placeholder values mirrored onto jobs when processing starts. */
export interface ProcessingPresetsState {
  selectedIds: string[];
  placeholders?: ProcessingPresetsPlaceholders;
}

/** Structured roster row for player-focused highlight extraction (used in prompts + job state). */
export interface PlayerRosterEntry {
  jerseyNumber: string;
  displayName?: string;
  photoUrl?: string;
  height?: string;
  buildProfile?: string;
  accessoryNotes?: string;
}

/**
 * Grounding spec for team/player priors. Does not enable true full-game tracking by itself
 * (requires CV / tracking — see `next.md` Phase 2).
 */
export interface PlayerFocusSpec {
  teamAName: string;
  jerseyColors: string[];
  /** e.g. "scan full video…" — user narrative; model still sees chunks only. */
  identificationPrompt?: string;
  roster?: PlayerRosterEntry[];
  primaryTarget?: {
    jerseyNumber: string;
    isolationPrompt?: string;
  };
}

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
  /** When targeting is enabled — only when visibly grounded */
  playerJersey?: string;
  playerName?: string;
  teamTag?: string;
  /** Short honesty note about visibility / occlusion in this chunk */
  visibilityNote?: string;
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

export type ChatRole = "user" | "assistant" | "system" | "tool";

export type AgentTaskType =
  | "upload"
  | "transcribe"
  | "rank"
  | "cut"
  | "refine"
  | "build_reel"
  | "explain";

export type AgentTaskStatus = "pending" | "running" | "done" | "error";

export type AgentToolName =
  | "start_processing"
  | "get_job_status"
  | "list_highlights"
  | "refine_highlights"
  | "build_reel"
  | "explain_clip";

export interface ConversationRecord {
  id: string;
  title: string;
  activeJobId: string | null;
  pendingInputPath: string | null;
  /** Pending structured targeting applied on next start_processing. */
  playerFocus?: PlayerFocusSpec | null;
  /** Saved default processing presets (conversation `player_focus_json.processingPresets`). */
  processingPresets?: ProcessingPresetsState | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageRecord {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface AgentTaskRecord {
  id: string;
  conversationId: string;
  jobId: string | null;
  type: AgentTaskType;
  status: AgentTaskStatus;
  progress: number;
  label: string;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobState {
  id: string;
  stage: JobStage;
  progress: number;
  message: string;
  error?: string;
  inputPath: string;
  /** When set, pipeline updates agent task rows for this conversation. */
  conversationId?: string;
  /** Last pipeline stage before terminal error (for task UI). */
  failedAtStage?: JobStage;
  inputHash?: string;
  storageInputKey?: string;
  userPrompt?: string;
  effectivePrompt?: string;
  category?: string;
  /** Same as conversation targeting; stored on the job for ranking/refine + cache keys. */
  playerFocus?: PlayerFocusSpec;
  /** Preset bundle applied when this job was created (inspectable; refine uses merged freeform prompt). */
  processingPresets?: ProcessingPresetsState | null;
  transcriptPath?: string;
  highlightsPath?: string;
  candidatesPath?: string;
  highlights?: Highlight[];
  clips?: GeneratedClip[];
  metrics: JobMetrics;
  createdAt: string;
  updatedAt: string;
}
