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
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 30_000),
};
