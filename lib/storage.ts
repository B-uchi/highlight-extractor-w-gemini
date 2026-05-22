import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable as NodeReadable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { appConfig } from "@/lib/config";
import type { GeneratedClip } from "@/lib/types";

function createS3Client(): S3Client {
  return new S3Client({
    region: appConfig.storage.region,
    endpoint: appConfig.storage.endpoint || undefined,
    forcePathStyle: true,
    credentials:
      appConfig.storage.accessKeyId && appConfig.storage.secretAccessKey
        ? {
            accessKeyId: appConfig.storage.accessKeyId,
            secretAccessKey: appConfig.storage.secretAccessKey,
          }
        : undefined,
  });
}

export function isObjectStorageEnabled(): boolean {
  return appConfig.storage.mode === "s3";
}

/** Temp working dir for FFmpeg intermediates (transcript chunks, proxies). */
export function localJobDir(jobId: string): string {
  return path.join(process.cwd(), "tmp", jobId);
}

/** Durable on-disk assets for reloadable playback (survives tmp cleanup). */
export function durableJobMediaDir(jobId: string): string {
  return path.join(appConfig.storage.dataDir, "jobs", jobId);
}

/** Stable pseudo job folder for a conversation's pending upload (before a real job id exists). */
export function pendingConversationJobId(conversationId: string): string {
  return `conv-${conversationId}`;
}

export function clipObjectStorageKey(jobId: string, clipId: string): string {
  return `clips/${jobId}/${clipId}.mp4`;
}

export async function saveInputVideo(jobId: string, fileName: string, bytes: Buffer): Promise<{ path: string; key?: string }> {
  const extension = path.extname(fileName) || ".mp4";
  const jobDir = durableJobMediaDir(jobId);
  const localPath = path.join(jobDir, `input${extension}`);
  await mkdir(jobDir, { recursive: true });
  await writeFile(localPath, bytes);

  if (!isObjectStorageEnabled()) {
    return { path: localPath };
  }

  const key = `inputs/${jobId}/input${extension}`;
  const s3 = createS3Client();
  await s3.send(
    new PutObjectCommand({
      Bucket: appConfig.storage.bucket,
      Key: key,
      Body: bytes,
      ContentType: "video/mp4",
    }),
  );
  return { path: localPath, key };
}

export async function promoteCutClipsToDurable(jobId: string, clips: GeneratedClip[]): Promise<GeneratedClip[]> {
  const destRoot = path.join(durableJobMediaDir(jobId), "clips");
  await mkdir(destRoot, { recursive: true });
  return Promise.all(
    clips.map(async (clip) => {
      const dest = path.join(destRoot, `${clip.id}.mp4`);
      await copyFile(clip.path, dest);
      return { ...clip, path: dest };
    }),
  );
}

export async function uploadClipToStorage(
  jobId: string,
  clipId: string,
  clipPath: string,
): Promise<{ url: string; storageClipKey?: string }> {
  if (!isObjectStorageEnabled()) {
    return { url: `/api/clip/${jobId}/${clipId}` };
  }

  const key = clipObjectStorageKey(jobId, clipId);
  const s3 = createS3Client();
  await s3.send(
    new PutObjectCommand({
      Bucket: appConfig.storage.bucket,
      Key: key,
      Body: createReadStream(clipPath),
      ContentType: "video/mp4",
    }),
  );

  return {
    url: `${appConfig.storage.basePublicUrl.replace(/\/$/, "")}/${key}`,
    storageClipKey: key,
  };
}

export async function downloadClipToFile(jobId: string, clipId: string, destPath: string): Promise<void> {
  if (!isObjectStorageEnabled()) {
    throw new Error("Object storage is not enabled; cannot download clip from bucket.");
  }
  const key = clipObjectStorageKey(jobId, clipId);
  const s3 = createS3Client();
  const result = await s3.send(
    new GetObjectCommand({
      Bucket: appConfig.storage.bucket,
      Key: key,
    }),
  );
  const body = result.Body;
  if (!body) {
    throw new Error(`Empty body for ${key}`);
  }
  await pipeline(body as NodeReadable, createWriteStream(destPath));
}

export async function getClipReadUrl(jobId: string, clipId: string): Promise<string> {
  if (!isObjectStorageEnabled()) {
    return `/api/clip/${jobId}/${clipId}`;
  }
  const key = clipObjectStorageKey(jobId, clipId);
  const s3 = createS3Client();
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: appConfig.storage.bucket,
      Key: key,
    }),
    { expiresIn: 60 * 30 },
  );
}
