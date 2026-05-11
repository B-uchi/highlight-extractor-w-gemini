import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable as NodeReadable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { appConfig } from "@/lib/config";

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

export function localJobDir(jobId: string): string {
  return path.join(process.cwd(), "tmp", jobId);
}

export async function saveInputVideo(jobId: string, fileName: string, bytes: Buffer): Promise<{ path: string; key?: string }> {
  const extension = path.extname(fileName) || ".mp4";
  const localPath = path.join(localJobDir(jobId), `input${extension}`);
  await mkdir(localJobDir(jobId), { recursive: true });
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

export async function uploadClipToStorage(jobId: string, clipId: string, clipPath: string): Promise<string> {
  if (!isObjectStorageEnabled()) {
    return `/api/clip/${jobId}/${clipId}`;
  }

  const key = `clips/${jobId}/${clipId}.mp4`;
  const s3 = createS3Client();
  await s3.send(
    new PutObjectCommand({
      Bucket: appConfig.storage.bucket,
      Key: key,
      Body: createReadStream(clipPath),
      ContentType: "video/mp4",
    }),
  );

  return `${appConfig.storage.basePublicUrl.replace(/\/$/, "")}/${key}`;
}

export async function downloadClipToFile(jobId: string, clipId: string, destPath: string): Promise<void> {
  if (!isObjectStorageEnabled()) {
    throw new Error("Object storage is not enabled; cannot download clip from bucket.");
  }
  const key = `clips/${jobId}/${clipId}.mp4`;
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
  const key = `clips/${jobId}/${clipId}.mp4`;
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
