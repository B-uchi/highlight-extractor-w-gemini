import { FunctionCallingConfigMode, type Content } from "@google/genai";

import { AGENT_SYSTEM_PROMPT } from "@/lib/agent/prompts";
import { executeAgentTool, getAgentFunctionDeclarations } from "@/lib/agent/tools";
import type { AgentStreamEvent } from "@/lib/agent/types";
import { getConversation } from "@/lib/conversations";
import { isDatabaseEnabled } from "@/lib/db";
import { getGeminiClient } from "@/lib/gemini";
import { getJob, hydrateJobFromStore } from "@/lib/jobs";
import { summarizeJobForAgent } from "@/lib/pipeline/refine";
import type { ChatMessageRecord, ConversationRecord } from "@/lib/types";

function buildConversationContextForAgent(conv: ConversationRecord | undefined): string {
  if (!conv) {
    return "Conversation: could not load state.";
  }

  const pending = Boolean(conv.pendingInputPath?.trim());
  const activeJobId = conv.activeJobId?.trim() ?? null;

  if (pending && !activeJobId) {
    return [
      "Conversation upload state: a video file is already stored for this chat and is ready to process.",
      "Do NOT ask the user to upload a video.",
      "If the user's latest message shows intent to extract highlights, analyze the video, find clips, tune scoring, specify sports/event type, OR gives player/team/roster/jersey targeting (even lengthy), treat that as sufficient to proceed: call start_processing immediately in this turn.",
      "Do NOT stall with phrases like \"tell me when to start\", \"say when you're ready\", or \"I'll wait for your go\"; only defer if intent is ambiguous (pure small talk/meta questions) or they explicitly postpone.",
      "Populate `prompt` with a concise summary of their highlight/analysis instructions from the latest message(s); merge conversation-saved targeting via `player_focus` when structured fields are evident.",
      "When they explicitly say start/go/run/begin/process, always call start_processing with `prompt` summarizing their instructions and optional `category` if specified.",
    ].join(" ");
  }

  if (pending && activeJobId) {
    return [
      "Conversation state: a new video is pending while job",
      activeJobId,
      "is active. Ask whether to process the new upload (you may need user guidance) or continue with the current job.",
    ].join(" ");
  }

  if (!pending && !activeJobId) {
    return "Conversation state: no video file yet. Ask the user to use Upload video before start_processing.";
  }

  return `Conversation state: active job id is ${activeJobId}. Use tools as needed; do not claim the user must upload unless there is no pending file and no job.`;
}

async function resolveJobState(jobId: string | null | undefined) {
  if (!jobId) {
    return null;
  }
  if (isDatabaseEnabled()) {
    return (await hydrateJobFromStore(jobId)) ?? getJob(jobId);
  }
  return getJob(jobId) ?? (await hydrateJobFromStore(jobId));
}

function buildHistoryContents(messages: ChatMessageRecord[]): Content[] {
  const contents: Content[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      contents.push({ role: "user", parts: [{ text: message.content }] });
    } else if (message.role === "assistant") {
      contents.push({ role: "model", parts: [{ text: message.content }] });
    }
  }
  return contents;
}

function streamTextDeltas(fullText: string, emit: (e: AgentStreamEvent) => void) {
  const chunkSize = 48;
  for (let i = 0; i < fullText.length; i += chunkSize) {
    emit({ type: "message_delta", text: fullText.slice(i, i + chunkSize) });
  }
}

export async function runAgentTurn(params: {
  conversationId: string;
  messages: ChatMessageRecord[];
  emit: (e: AgentStreamEvent) => void;
}): Promise<string> {
  const conversation = await getConversation(params.conversationId);
  const job = await resolveJobState(conversation?.activeJobId ?? undefined);

  const systemInstruction = [
    AGENT_SYSTEM_PROMPT,
    buildConversationContextForAgent(conversation),
    job
      ? `Active job snapshot: ${JSON.stringify(summarizeJobForAgent(job))}`
      : "No active job snapshot in memory yet (job may start after start_processing).",
  ].join("\n\n");

  const contents: Content[] = buildHistoryContents(params.messages);

  const ai = getGeminiClient();
  const tools = [{ functionDeclarations: getAgentFunctionDeclarations() }];

  for (let turn = 0; turn < 10; turn += 1) {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents,
      config: {
        systemInstruction,
        tools,
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode.AUTO,
          },
        },
      },
    });

    const calls = response.functionCalls;
    if (calls && calls.length > 0) {
      const candidate = response.candidates?.[0];
      const modelContent = candidate?.content;
      if (modelContent?.parts?.length) {
        contents.push({ role: "model", parts: modelContent.parts });
      }

      const toolCtx = { conversationId: params.conversationId, emit: params.emit };
      const functionResponseParts = [];

      for (const call of calls) {
        const name = call.name ?? "";
        const args = call.args ?? {};
        params.emit({ type: "tool_call", name, args });

        try {
          const output = await executeAgentTool({ name, args, ctx: toolCtx });
          params.emit({
            type: "tool_result",
            name,
            ok: !("error" in output && output.error),
            summary: JSON.stringify(output).slice(0, 500),
          });
          functionResponseParts.push({
            functionResponse: {
              name,
              response: { output },
              id: call.id,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          params.emit({
            type: "tool_result",
            name,
            ok: false,
            summary: message,
          });
          functionResponseParts.push({
            functionResponse: {
              name,
              response: { error: message },
              id: call.id,
            },
          });
        }
      }

      contents.push({ role: "user", parts: functionResponseParts });
      continue;
    }

    const text = response.text?.trim() ?? "";
    if (text) {
      streamTextDeltas(text, params.emit);
    }
    return text;
  }

  const fallback =
    "I ran into a loop trying to call tools. Please narrow the request or try again in a new message.";
  streamTextDeltas(fallback, params.emit);
  return fallback;
}
