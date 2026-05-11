export const appConfig = {
  pipeline: {
    audioChunkDurationSec: Number(process.env.AUDIO_CHUNK_DURATION_SEC ?? 600),
    videoLongThresholdSec: Number(process.env.VIDEO_LONG_THRESHOLD_SEC ?? 1_200),
    videoChunkDurationSec: Number(process.env.VIDEO_CHUNK_DURATION_SEC ?? 900),
    geminiConcurrency: Number(process.env.GEMINI_CONCURRENCY ?? 4),
    whisperConcurrency: Number(process.env.WHISPER_CONCURRENCY ?? 4),
    maxHighlightsFinal: Number(process.env.MAX_HIGHLIGHTS_FINAL ?? 15),
    budgetMaxTotalTokens: Number(process.env.MAX_JOB_TOTAL_TOKENS ?? 300_000),
  },
  clip: {
    defaultPrePadSec: Number(process.env.DEFAULT_PRE_PAD_SEC ?? 1),
    defaultPostPadSec: Number(process.env.DEFAULT_POST_PAD_SEC ?? 2),
  },
  queue: {
    enabled: process.env.USE_QUEUE === "true",
    redisUrl: process.env.REDIS_URL ?? "",
    jobQueueName: process.env.JOB_QUEUE_NAME ?? "video-highlights-jobs",
    workerConcurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
  },
  storage: {
    mode: process.env.STORAGE_MODE ?? "local",
    basePublicUrl: process.env.STORAGE_BASE_PUBLIC_URL ?? "",
    bucket: process.env.STORAGE_BUCKET ?? "",
    endpoint: process.env.STORAGE_ENDPOINT ?? "",
    region: process.env.STORAGE_REGION ?? "auto",
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? "",
  },
  jobs: {
    useDatabase: process.env.USE_DATABASE_JOBS === "true",
    databaseUrl: process.env.DATABASE_URL ?? "",
  },
  cv: {
    enabled: process.env.ENABLE_CV_WORKER === "true",
    baseUrl: process.env.CV_WORKER_URL ?? "http://localhost:8000",
  },
};
