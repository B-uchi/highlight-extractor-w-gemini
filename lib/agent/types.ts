export type AgentStreamEvent =
  | { type: "message_delta"; text: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; ok: boolean; summary: string }
  | {
      type: "task_update";
      id: string;
      status: string;
      progress?: number;
      label?: string;
    }
  | { type: "job_update"; jobId: string; stage: string; progress: number }
  | { type: "done"; assistantMessageId: string }
  | { type: "error"; message: string };
