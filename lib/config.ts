// Token budget math:
// At slowdown=S and fps=F, a chunk of N original seconds uses:
//   N × S × F × 258 tokens
// Stay under 900K tokens (90% of 1M context):
//   N ≤ 900_000 / (S × F × 258)
// Default S=2, F=3 → N ≤ 900_000 / (2 × 3 × 258) = 581s ≈ 9.7 min per chunk
// Slowed chunk uploaded to Gemini = 9.7 × 2 = 19.4 min of video at 3fps
// For a 90-min game: ~10 chunks (analysed in parallel batches of 3)

const slowdown = Number(process.env.GEMINI_VIDEO_SLOWDOWN ?? 2);
const analysisFps = Number(process.env.GEMINI_ANALYSIS_FPS ?? 3);
const autoChunkSec = Math.floor(900_000 / (slowdown * analysisFps * 258));

export const appConfig = {
  gemini: {
    // 2.5 Pro on a ~900K-token chunk can take 5–8 min to respond. 12 min gives
    // breathing room so a single slow call doesn't kill the whole job.
    httpTimeoutMs: Math.max(10_000, Number(process.env.GEMINI_HTTP_TIMEOUT_MS ?? 720_000)),
    // Max ORIGINAL-time seconds per chunk. Auto-calculated from token budget unless overridden.
    chunkDurationSec: Number(process.env.GEMINI_CHUNK_DURATION_SEC ?? autoChunkSec),
    analysisParallelism: Number(process.env.GEMINI_ANALYSIS_PARALLELISM ?? 3),
    // Slow-motion factor applied to each chunk before Gemini upload.
    // Gives Gemini denser frame coverage of fast actions (dunks, blocks, etc.).
    // Set to 1 to disable. Timestamps from Gemini are divided by this factor
    // to recover real video time.
    videoSlowdownFactor: slowdown,
    // FPS passed to Gemini's videoMetadata. Lower than 10 to stay within token budget
    // when slowdown > 1.
    analysisFps,
    // Minimum confidence score to keep a clip. Raise to reduce false positives.
    minConfidence: Number(process.env.GEMINI_MIN_CONFIDENCE ?? 0.80),
  },
  r2: {
    accountId: process.env.R2_ACCOUNT_ID ?? "",
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    bucket: process.env.R2_BUCKET_NAME ?? "",
    presignExpiresIn: Number(process.env.R2_PRESIGN_EXPIRES_SEC ?? 3600),
  },
  supabase: {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  },
  cron: {
    secret: process.env.CRON_SECRET ?? "",
  },
};
