import { createReadStream, createWriteStream, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";

import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";

import { config } from "./config";

function s3(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

export async function downloadFromR2(key: string, destPath: string): Promise<void> {
  await mkdir(path.dirname(destPath), { recursive: true });
  const result = await s3().send(
    new GetObjectCommand({ Bucket: config.r2.bucket, Key: key }),
  );
  if (!result.Body) throw new Error(`Empty R2 body for key: ${key}`);
  await pipeline(result.Body as NodeJS.ReadableStream, createWriteStream(destPath));
}

const MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100 MB
const PART_SIZE = 50 * 1024 * 1024; // 50 MB

export async function uploadFileToR2(localPath: string, key: string): Promise<void> {
  const client = s3();
  const { size } = statSync(localPath);

  if (size < MULTIPART_THRESHOLD) {
    await client.send(
      new PutObjectCommand({
        Bucket: config.r2.bucket,
        Key: key,
        Body: createReadStream(localPath),
        ContentType: "video/mp4",
        ContentLength: size,
      }),
    );
    return;
  }

  const { UploadId } = await client.send(
    new CreateMultipartUploadCommand({ Bucket: config.r2.bucket, Key: key, ContentType: "video/mp4" }),
  );

  const parts: { ETag: string; PartNumber: number }[] = [];
  let partNumber = 1;
  let offset = 0;

  while (offset < size) {
    const end = Math.min(offset + PART_SIZE, size);
    const result = await client.send(
      new UploadPartCommand({
        Bucket: config.r2.bucket,
        Key: key,
        UploadId: UploadId!,
        PartNumber: partNumber,
        Body: createReadStream(localPath, { start: offset, end: end - 1 }),
        ContentLength: end - offset,
      }),
    );
    parts.push({ ETag: result.ETag!, PartNumber: partNumber });
    partNumber++;
    offset = end;
  }

  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: config.r2.bucket,
      Key: key,
      UploadId: UploadId!,
      MultipartUpload: { Parts: parts },
    }),
  );
}

export async function deleteFromR2(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: config.r2.bucket, Key: key }));
}
