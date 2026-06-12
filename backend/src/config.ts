import "dotenv/config";

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const slowdown = Number(process.env.GEMINI_VIDEO_SLOWDOWN ?? 2);
const analysisFps = Number(process.env.GEMINI_ANALYSIS_FPS ?? 3);
const autoChunkSec = Math.floor(900_000 / (slowdown * analysisFps * 258));

export const config = {
  port: Number(process.env.PORT ?? 3001),
  supabase: {
    url: requireEnv("SUPABASE_URL"),
    serviceRoleKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
  },
  r2: {
    accountId: requireEnv("R2_ACCOUNT_ID"),
    accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    bucket: requireEnv("R2_BUCKET_NAME"),
    presignExpiresIn: Number(process.env.R2_PRESIGN_EXPIRES_SEC ?? 3600),
  },
  gemini: {
    apiKey: requireEnv("GEMINI_API_KEY"),
    // 2.5 Pro on a ~900K-token chunk can take 5–8 min. 12 min gives breathing room.
    httpTimeoutMs: Math.max(10_000, Number(process.env.GEMINI_HTTP_TIMEOUT_MS ?? 720_000)),
    chunkDurationSec: Number(process.env.GEMINI_CHUNK_DURATION_SEC ?? autoChunkSec),
    analysisParallelism: Number(process.env.GEMINI_ANALYSIS_PARALLELISM ?? 2),
    videoSlowdownFactor: slowdown,
    analysisFps,
    minConfidence: Number(process.env.GEMINI_MIN_CONFIDENCE ?? 0.80),
  },

  // "gemini" (default, baseline) or "proposer_verifier" (Qwen on Modal proposes, Gemini verifies).
  analysisMode: (process.env.ANALYSIS_MODE ?? "gemini") as "gemini" | "proposer_verifier",

  // Qwen3-VL-32B-Thinking proposer on Modal. Token budget per chunk ≈
  // chunkSec × fps × (maxPixels / 784); must stay under maxModelLen minus ~10K for
  // prompt + thinking output. Validate against [QWEN-TUNE] logs and retune.
  qwen: {
    appName: process.env.QWEN_MODAL_APP ?? "video-highlight-proposer",
    functionName: process.env.QWEN_MODAL_FUNCTION ?? "propose_clips",
    fps: Number(process.env.QWEN_FPS ?? 6),
    // Measured: ~70 tok/frame at 147456 px (not 188). 48s × ~7.5 eff-fps × ~75 ≈ 28K
    // prompt tokens — well under maxModelLen. Bigger chunks ≈ halve Modal calls/cost.
    maxPixels: Number(process.env.QWEN_MAX_PIXELS ?? 147_456), // ≈512×288 → ~70 tok/frame
    chunkSec: Number(process.env.QWEN_CHUNK_SEC ?? 48),
    maxModelLen: Number(process.env.QWEN_MAX_MODEL_LEN ?? 40_960),
    // Each concurrent call lets Modal autoscale another warm A100. Total GPU-compute is
    // conserved — this just spreads chunks across more GPUs instead of queueing them.
    proposalParallelism: Number(process.env.QWEN_PROPOSAL_PARALLELISM ?? 6),
  },

  // Gemini verifier — confirms each small candidate clip inline (no Files API, no slowdown).
  verifier: {
    model: process.env.VERIFY_MODEL ?? "gemini-3.1-pro-preview",
    fps: Number(process.env.VERIFY_FPS ?? 6),
    parallelism: Number(process.env.VERIFY_PARALLELISM ?? 4), // keep well under 1000 RPM
    minConfidence: Number(process.env.VERIFY_MIN_CONFIDENCE ?? 0.6),
    preActionPad: Number(process.env.VERIFY_PRE_PAD ?? 2.5),
    postActionPad: Number(process.env.VERIFY_POST_PAD ?? 2.5),
  },

  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 30_000),
};
