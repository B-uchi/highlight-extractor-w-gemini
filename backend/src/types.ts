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
  chunks_analyzed: number;
  chunks_total: number | null;
  chunk_cache: Record<string, GeminiClipResult[]>;
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
