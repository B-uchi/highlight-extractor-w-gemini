import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";

export async function sha256File(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function getCacheDir(hash: string): string {
  return path.join(process.cwd(), "tmp", "cache", hash);
}

export async function readJsonCache<T>(hash: string, key: string): Promise<T | undefined> {
  const target = path.join(getCacheDir(hash), `${key}.json`);
  try {
    await access(target);
  } catch {
    return undefined;
  }
  const content = await readFile(target, "utf8");
  return JSON.parse(content) as T;
}

export async function writeJsonCache(hash: string, key: string, value: unknown): Promise<void> {
  const dir = getCacheDir(hash);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${key}.json`), JSON.stringify(value, null, 2), "utf8");
}
