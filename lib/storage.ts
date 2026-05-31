import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { appConfig } from "@/lib/config";

function createR2Client(): S3Client {
  const { accountId, accessKeyId, secretAccessKey } = appConfig.r2;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY must be set.");
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export function tmpDir(conversationId: string): string {
  return path.join(process.cwd(), "tmp", conversationId);
}

export async function ensureTmpDir(conversationId: string): Promise<string> {
  const dir = tmpDir(conversationId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Stream a Web ReadableStream to a local file without buffering in RAM. */
export async function streamToFile(
  readableStream: ReadableStream<Uint8Array>,
  destPath: string,
): Promise<void> {
  await mkdir(path.dirname(destPath), { recursive: true });
  await pipeline(
    Readable.fromWeb(readableStream as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(destPath),
  );
}

const MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100 MB
const PART_SIZE = 50 * 1024 * 1024; // 50 MB parts

/** Upload a local file to R2. Uses multipart for files ≥ 100 MB. */
export async function uploadFileToR2(localPath: string, key: string): Promise<string> {
  const { bucket } = appConfig.r2;
  const s3 = createR2Client();
  const { size } = await import("node:fs").then((fs) =>
    new Promise<{ size: number }>((res, rej) =>
      fs.stat(localPath, (err, s) => (err ? rej(err) : res({ size: s.size }))),
    ),
  );

  if (size < MULTIPART_THRESHOLD) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createReadStream(localPath),
        ContentType: "video/mp4",
        ContentLength: size,
      }),
    );
    return key;
  }

  // Multipart upload for large files
  const create = await s3.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: "video/mp4" }),
  );
  const uploadId = create.UploadId!;

  const parts: { ETag: string; PartNumber: number }[] = [];
  let partNumber = 1;
  let offset = 0;

  while (offset < size) {
    const end = Math.min(offset + PART_SIZE, size);
    const partStream = createReadStream(localPath, { start: offset, end: end - 1 });
    const result = await s3.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: partStream,
        ContentLength: end - offset,
      }),
    );
    parts.push({ ETag: result.ETag!, PartNumber: partNumber });
    partNumber++;
    offset = end;
  }

  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }),
  );

  return key;
}

/** Download an R2 object to a local file path. */
export async function downloadFromR2(key: string, destPath: string): Promise<void> {
  const { bucket } = appConfig.r2;
  const s3 = createR2Client();
  await mkdir(path.dirname(destPath), { recursive: true });
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new Error(`Empty body for R2 key: ${key}`);
  await pipeline(result.Body as NodeJS.ReadableStream, createWriteStream(destPath));
}

/** Generate a presigned GET URL for a private R2 object. */
export async function getPresignedUrl(
  key: string,
  expiresIn = appConfig.r2.presignExpiresIn,
): Promise<string> {
  const { bucket } = appConfig.r2;
  const s3 = createR2Client();
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
}

export async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // ignore
  }
}
