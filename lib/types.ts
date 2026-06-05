// ── Conversation ──────────────────────────────────────────────────────────────

export type ConversationStatus = "awaiting_video" | "active" | "archived";

export interface Conversation {
  id: string;
  title: string;
  status: ConversationStatus;
  r2_video_key: string | null;
  video_filename: string | null;
  video_duration_secs: number | null;
  preprocessing_error: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

// ── Video chunks (per-chunk Gemini file tracking) ─────────────────────────────

export interface VideoChunk {
  id: string;
  conversation_id: string;
  chunk_index: number;
  start_sec: number;
  end_sec: number;
  gemini_file_id: string | null;
  gemini_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── Messages ──────────────────────────────────────────────────────────────────

export type MessageRole = "user" | "assistant";

export interface Message {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  job_id: string | null;
  created_at: string;
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

export type JobMode =
  | "action_extraction"
  | "highlight_compilation_individual"
  | "highlight_compilation_team";

export type JobStatus =
  | "pending"
  | "extracting_target"
  | "analyzing"
  | "extracting_clips"
  | "stitching"
  | "done"
  | "error"
  | "unsupported";

export interface Job {
  id: string;
  conversation_id: string;
  message_id: string;
  mode: JobMode;
  status: JobStatus;
  prompt: string;
  extracted_target: string | null;
  jersey_number: string | null;
  jersey_color: string | null;
  team_name: string | null;
  clip_limit: number | null;
  follow_up_secs: number | null;
  include_audio: boolean;
  clips_total: number | null;
  clips_done: number;
  compilation_r2_key: string | null;
  compilation_r2_url: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

// ── Clips ─────────────────────────────────────────────────────────────────────

export interface Clip {
  id: string;
  job_id: string;
  conversation_id: string;
  title: string;
  description: string | null;
  start_sec: number;
  end_sec: number;
  follow_up_end_sec: number | null;
  rank: number;
  jersey_number: string | null;
  jersey_color: string | null;
  r2_clip_key: string | null;
  r2_clip_url: string | null;
  r2_follow_up_clip_key: string | null;
  r2_follow_up_clip_url: string | null;
  created_at: string;
}

// ── Gemini structured response ────────────────────────────────────────────────

export interface GeminiClipResult {
  title: string;
  description: string;
  start_sec: number;
  end_sec: number;
  rank: number;
  confidence: number;
  jerseyNumber?: string | null;
  jerseyColor?: string | null;
}

export interface PreStepResult {
  mode: JobMode | "unsupported";
  target: string;
  jerseyNumber: string | null;
  jerseyColor: string | null;
  teamName: string | null;
  includeAudio: boolean;
  supported: boolean;
}

// ── Upload progress (streamed JSON lines) ─────────────────────────────────────

export type UploadProgressStep =
  | "preprocessing"
  | "uploading_r2"
  | "uploading_gemini"
  | "done"
  | "error"
  | "heartbeat";

export interface UploadProgressEvent {
  step: UploadProgressStep;
  message: string;
  chunk?: number;
  totalChunks?: number;
  error?: string;
}

// ── API response shapes ───────────────────────────────────────────────────────

export interface ConversationDetail extends Conversation {
  messages: MessageWithClips[];
}

export interface MessageWithClips extends Message {
  clips?: Clip[];
  job?: Job | null;
}
