import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";

import { appConfig } from "@/lib/config";
import { isDatabaseEnabled } from "@/lib/db";
import { getJob, hydrateJobFromStore } from "@/lib/jobs";
import { isObjectStorageEnabled } from "@/lib/storage";

export const runtime = "nodejs";

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

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await context.params;
  try {
    const job = isDatabaseEnabled()
      ? (await hydrateJobFromStore(jobId)) ?? getJob(jobId)
      : getJob(jobId) ?? (await hydrateJobFromStore(jobId));

    if (!job) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }

    const inputPath = job.inputPath;
    if (!inputPath) {
      return NextResponse.json({ error: "No input path for job." }, { status: 404 });
    }

    try {
      await access(inputPath);
    } catch {
      if (!isObjectStorageEnabled() || !job.storageInputKey) {
        return NextResponse.json({ error: "Input file is not available." }, { status: 404 });
      }
      const s3 = createS3Client();
      const result = await s3.send(
        new GetObjectCommand({
          Bucket: appConfig.storage.bucket,
          Key: job.storageInputKey,
        }),
      );
      const body = result.Body as import("stream").Readable;
      if (!body) {
        return NextResponse.json({ error: "Empty S3 body." }, { status: 502 });
      }
      const webStream = Readable.toWeb(body) as ReadableStream<Uint8Array>;
      return new NextResponse(webStream, {
        headers: {
          "content-type": "video/mp4",
          "cache-control": "private, max-age=3600",
        },
      });
    }

    const nodeStream = createReadStream(inputPath);
    const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

    const ext = path.extname(inputPath).toLowerCase();
    const contentType =
      ext === ".mov"
        ? "video/quicktime"
        : ext === ".webm"
          ? "video/webm"
          : ext === ".mkv"
            ? "video/x-matroska"
            : "video/mp4";

    return new NextResponse(webStream, {
      headers: {
        "content-type": contentType,
        "cache-control": "private, max-age=3600",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
