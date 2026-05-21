import { isDatabaseEnabled } from "@/lib/db";
import { getJob, hydrateJobFromStore } from "@/lib/jobs";
import { onJobUpdate } from "@/lib/events";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      let closed = false;
      let lastUpdatedAt = "";
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: () => void = () => {};

      const closeStream = () => {
        if (closed) {
          return;
        }
        closed = true;
        unsubscribe();
        if (pollTimer !== null) {
          clearInterval(pollTimer);
        }
        controller.close();
      };

      const fetchLatest = async () => {
        if (isDatabaseEnabled()) {
          const fromStore = await hydrateJobFromStore(jobId);
          if (fromStore) {
            return fromStore;
          }
        }
        return getJob(jobId);
      };

      const emitIfChanged = async () => {
        const latest = await fetchLatest();
        if (!latest) {
          return;
        }
        if (latest.updatedAt !== lastUpdatedAt) {
          lastUpdatedAt = latest.updatedAt;
          send(latest);
        }
        if (latest.stage === "done" || latest.stage === "error") {
          closeStream();
        }
      };

      const existing = await fetchLatest();
      if (existing) {
        lastUpdatedAt = existing.updatedAt;
        send(existing);
      }

      unsubscribe = onJobUpdate(jobId, (job) => {
        if (closed) {
          return;
        }
        lastUpdatedAt = job.updatedAt;
        send(job);
        if (job.stage === "done" || job.stage === "error") {
          closeStream();
        }
      });

      pollTimer = setInterval(() => {
        void emitIfChanged().catch(() => undefined);
      }, 1_000);
    },
    cancel() {
      // No-op: interval/listener cleanup is handled in closeStream.
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}
