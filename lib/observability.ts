import { metrics } from "@opentelemetry/api";
import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";

const meter = metrics.getMeter("video-highlights");

export const stageCounter = meter.createCounter("pipeline.stage.transitions", {
  description: "How many stage transitions were executed",
});

const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const processedVideoSeconds = new Counter({
  name: "video_processed_seconds_total",
  help: "Total video seconds processed",
  registers: [registry],
});

export const runningJobsGauge = new Gauge({
  name: "video_jobs_in_progress",
  help: "Current jobs running",
  registers: [registry],
});

export function getPrometheusMetrics(): Promise<string> {
  return registry.metrics();
}
