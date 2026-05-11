import { EventEmitter } from "node:events";

import { JobState } from "@/lib/types";

const events = new EventEmitter();
events.setMaxListeners(100);

export function emitJobUpdate(job: JobState): void {
  events.emit(`job:${job.id}`, job);
}

export function onJobUpdate(jobId: string, listener: (job: JobState) => void): () => void {
  const key = `job:${jobId}`;
  events.on(key, listener);
  return () => events.off(key, listener);
}
