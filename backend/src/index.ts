import express from "express";
import { config } from "./config";
import { startWorker } from "./worker";
import { db } from "./db";

const app = express();
app.use(express.json());

// Health check — Railway uses this to verify the service is up.
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Lightweight status endpoint for debugging.
app.get("/status", async (_req, res) => {
  const { data } = await db
    .from("video_preprocessing_jobs")
    .select("status, count:id")
    .order("status");
  res.json({ jobs: data ?? [] });
});

app.listen(config.port, () => {
  console.log(`[server] listening on :${config.port}`);
});

startWorker().catch((err) => {
  console.error("[worker] failed to start:", err);
  process.exit(1);
});
