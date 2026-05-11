import { JobsOptions, Queue, Worker } from "bullmq";
import IORedis from "ioredis";

import { appConfig } from "@/lib/config";

interface QueueJobPayload {
  jobId: string;
}

let queue: Queue<QueueJobPayload> | null = null;
let connection: IORedis | null = null;

function getConnection(): IORedis {
  if (!appConfig.queue.redisUrl) {
    throw new Error("REDIS_URL is required when queue is enabled.");
  }
  if (!connection) {
    connection = new IORedis(appConfig.queue.redisUrl, { maxRetriesPerRequest: null });
  }
  return connection;
}

export function isQueueEnabled(): boolean {
  return appConfig.queue.enabled;
}

export function getPipelineQueue(): Queue<QueueJobPayload> {
  if (!isQueueEnabled()) {
    throw new Error("Queue mode is disabled.");
  }
  if (!queue) {
    queue = new Queue<QueueJobPayload>(appConfig.queue.jobQueueName, {
      connection: getConnection(),
    });
  }
  return queue;
}

export async function enqueuePipelineJob(jobId: string): Promise<void> {
  const q = getPipelineQueue();
  const options: JobsOptions = {
    removeOnComplete: 1_000,
    removeOnFail: 1_000,
    attempts: 3,
    backoff: { type: "exponential", delay: 2_000 },
  };
  await q.add("process-video", { jobId }, options);
}

export function createPipelineWorker(
  handler: (jobId: string) => Promise<void>,
): Worker<QueueJobPayload, unknown, string> {
  return new Worker<QueueJobPayload>(
    appConfig.queue.jobQueueName,
    async (job) => {
      await handler(job.data.jobId);
    },
    {
      connection: getConnection(),
      concurrency: appConfig.queue.workerConcurrency,
    },
  );
}
