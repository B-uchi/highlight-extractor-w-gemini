import "dotenv/config";

function require(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  supabase: {
    url: require("SUPABASE_URL"),
    serviceRoleKey: require("SUPABASE_SERVICE_ROLE_KEY"),
  },
  r2: {
    accountId: require("R2_ACCOUNT_ID"),
    accessKeyId: require("R2_ACCESS_KEY_ID"),
    secretAccessKey: require("R2_SECRET_ACCESS_KEY"),
    bucket: require("R2_BUCKET_NAME"),
  },
  // poll interval fallback in case Realtime misses an event
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 30_000),
};
