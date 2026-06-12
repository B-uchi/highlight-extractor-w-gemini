export type JobMode =
  | "action_extraction"
  | "highlight_compilation_individual"
  | "highlight_compilation_team";

export type JobStatus =
  | "pending"
  | "extracting_target"
  | "analyzing"
  | "proposing"
  | "verifying"
  | "extracting_clips"
  | "stitching"
  | "done"
  | "error"
  | "unsupported"
  | "cancelling"
  | "cancelled";

export interface FailedChunk {
  chunkIndex: number;
  startSec: number;
  endSec: number;
  error: string;
}

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
  chunks_analyzed: number;
  chunks_total: number | null;
  chunk_cache: Record<string, GeminiClipResult[]>;
  // Proposer-verifier: per-candidate verify verdict (keyed by candidate index) for resume.
  pv_verdicts: Record<string, { confirmed: boolean; confidence: number; reason: string }> | null;
  failed_chunks: FailedChunk[] | null;
  compilation_r2_key: string | null;
  compilation_r2_url: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

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

// A candidate clip proposed by the Qwen proposer. Structurally a GeminiClipResult
// (so it can flow through the same merge/dedup/cut helpers), with chunk-relative
// timestamps until the backend offsets them to absolute video time.
export type QwenClipProposal = GeminiClipResult;

export interface VerifyResult {
  confirmed: boolean;
  confidence: number;
  reason: string;
}
