// Modal TypeScript SDK client — calls the deployed Qwen3-VL proposer function.
// Deploy the Python side first: modal deploy backend/modal/proposer.py
// Auth: the `modal` SDK reads MODAL_TOKEN_ID / MODAL_TOKEN_SECRET from the env.

import { config } from "./config";
import { buildQwenProposerPrompt } from "./prompts";
import type { Job, QwenClipProposal } from "./types";

// The modal SDK is ESM/CJS dual; lazy-require so a missing install only fails the
// proposer path, not the whole worker (the Gemini baseline must still boot).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _fn: any = null;

async function getProposerFn() {
  if (_fn) return _fn;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const modal = require("modal") as {
    Function_: { lookup: (app: string, fn: string) => Promise<unknown> };
  };
  _fn = await modal.Function_.lookup(config.qwen.appName, config.qwen.functionName);
  return _fn;
}

// A cached function handle goes stale when the Modal app is stopped/redeployed
// (the old function ID no longer exists). Detect that and force a fresh lookup.
function isStaleFunctionError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("failed_precondition") ||
    msg.includes("is stopped") ||
    msg.includes("not_found") ||
    msg.includes("does not exist")
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callRemote(remoteArgs: any[]): Promise<unknown> {
  let fn = await getProposerFn();
  try {
    return await fn.remote(remoteArgs);
  } catch (err) {
    if (!isStaleFunctionError(err)) throw err;
    // Stale handle — drop the cache, re-resolve the live function, retry once.
    console.warn("[modal] stale function handle — re-resolving and retrying");
    _fn = null;
    fn = await getProposerFn();
    return await fn.remote(remoteArgs);
  }
}

export interface ProposeArgs {
  chunkUrl: string;        // R2 presigned URL — Modal downloads the chunk directly
  chunkSec: number;        // real duration of this chunk
  job: Job;
}

/**
 * Call the Qwen proposer on Modal for one chunk. Returns proposals with
 * timestamps RELATIVE to the chunk (0-based); the caller offsets to absolute time.
 */
export async function proposeClipsForChunk(args: ProposeArgs): Promise<QwenClipProposal[]> {
  const { chunkUrl, chunkSec, job } = args;
  const prompt = buildQwenProposerPrompt(job, chunkSec);

  // Python signature: propose_clips(video_url, chunk_sec, fps, max_pixels, max_model_len, prompt_text)
  const result = await callRemote([
    chunkUrl,
    chunkSec,
    config.qwen.fps,
    config.qwen.maxPixels,
    config.qwen.maxModelLen,
    prompt,
  ]);

  if (!Array.isArray(result)) return [];
  return (result as QwenClipProposal[]).filter(
    (c) =>
      typeof c.start_sec === "number" &&
      typeof c.end_sec === "number" &&
      c.end_sec > c.start_sec &&
      c.start_sec >= 0 &&
      c.end_sec <= chunkSec + 2, // small tolerance for model drift
  );
}
