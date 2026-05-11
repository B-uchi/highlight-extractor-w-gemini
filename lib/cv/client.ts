import { appConfig } from "@/lib/config";

interface SceneResponse {
  boundariesSec: number[];
}

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(`${appConfig.cv.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`CV worker call failed: ${path} (${response.status})`);
  }
  return (await response.json()) as T;
}

export async function detectScenes(inputVideoPath: string): Promise<number[]> {
  if (!appConfig.cv.enabled) {
    return [];
  }
  const result = await postJson<SceneResponse>("/scenes", { inputVideoPath });
  return result.boundariesSec ?? [];
}
