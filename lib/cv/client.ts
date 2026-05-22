import { appConfig } from "@/lib/config";
import {
  collectsConnectionRefusedPorts,
  isLikelyFetchConnectionFailure,
} from "@/lib/networkErrors";

interface SceneResponse {
  boundariesSec: number[];
}

const CV_SCENE_MAX_ATTEMPTS = 8;
const CV_SCENE_BASE_DELAY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatCvUnreachableMessage(baseUrl: string, pathSuffix: string, original: unknown): string {
  const ports = collectsConnectionRefusedPorts(original);
  const portHints =
    ports.length > 0
      ? ` Refused ports: ${ports.join(", ")}.${
          ports.includes(8000)
            ? " Port 8000 is the Python CV worker (see `npm run dev` cv process and `scripts/dev-cv-worker.sh`)."
            : ""
        }`
      : "";
  return (
    `Cannot reach CV worker at ${baseUrl}${pathSuffix} (connection refused).` +
    ` Ensure the CV service is listening (default http://localhost:8000), or set ENABLE_CV_WORKER=false to skip scene detection.` +
    ` Override URL with CV_WORKER_URL.${portHints}` +
    ` Underlying error: ${original instanceof Error ? original.message : String(original)}`
  );
}

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const url = `${appConfig.cv.baseUrl}${path}`;

  for (let attempt = 1; attempt <= CV_SCENE_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`CV worker call failed: ${path} (${response.status})`);
      }
      return (await response.json()) as T;
    } catch (error) {
      const isHttpKnownError = error instanceof Error && error.message.startsWith("CV worker call failed");
      if (isHttpKnownError) {
        throw error;
      }

      const canRetry =
        isLikelyFetchConnectionFailure(error) &&
        collectsConnectionRefusedPorts(error).length > 0 &&
        attempt < CV_SCENE_MAX_ATTEMPTS;

      if (canRetry) {
        const backoff = CV_SCENE_BASE_DELAY_MS * 2 ** (attempt - 1);
        console.warn(
          `[cv-worker] ${path} unreachable (${error instanceof Error ? error.message : String(error)}), retry ${attempt}/${CV_SCENE_MAX_ATTEMPTS} in ${backoff}ms`,
        );
        await sleep(backoff);
        continue;
      }

      throw new Error(formatCvUnreachableMessage(appConfig.cv.baseUrl, path, error), {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  throw new Error("CV worker retries exhausted unexpectedly.");
}

export async function detectScenes(inputVideoPath: string): Promise<number[]> {
  if (!appConfig.cv.enabled) {
    return [];
  }
  const result = await postJson<SceneResponse>("/scenes", { inputVideoPath });
  return result.boundariesSec ?? [];
}
