import { access } from "node:fs/promises";
import { createReadStream } from "node:fs";
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

async function resolveJob(jobId: string) {
  if (isDatabaseEnabled()) {
    return (await hydrateJobFromStore(jobId)) ?? getJob(jobId) ?? null;
  }
  return getJob(jobId) ?? (await hydrateJobFromStore(jobId)) ?? null;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string; clipId: string }> },
) {
  const { jobId, clipId } = await context.params;
  const job = await resolveJob(jobId);
  const clip = job?.clips?.find((item) => item.id === clipId);

  if (!job || !clip) {
    return NextResponse.json({ error: "Clip not available for this job." }, { status: 404 });
  }
  if (clip.url.startsWith("http://") || clip.url.startsWith("https://")) {
    return NextResponse.redirect(clip.url);
  }

  try {
    await access(clip.path);
  } catch {
    const storageClipKey =
      typeof clip.storageClipKey === "string" ? clip.storageClipKey : "";
    const derivedKey =
      storageClipKey || (isObjectStorageEnabled() ? `clips/${jobId}/${clip.id}.mp4` : "");

    if (isObjectStorageEnabled() && derivedKey) {
      try {
        const s3 = createS3Client();
        const result = await s3.send(
          new GetObjectCommand({
            Bucket: appConfig.storage.bucket,
            Key: derivedKey,
          }),
        );
        const body = result.Body as import("stream").Readable;
        if (!body) {
          return NextResponse.json({ error: "Empty clip body from storage." }, { status: 502 });
        }
        const webStream = Readable.toWeb(body) as ReadableStream<Uint8Array>;
        return new NextResponse(webStream, {
          headers: {
            "content-type": "video/mp4",
            "cache-control": "private, max-age=3600",
            "content-disposition": `inline; filename="${clip.id}.mp4"`,
          },
        });
      } catch {
        /* fall through to 404 */
      }
    }
    return NextResponse.json({ error: "Clip file not found on disk." }, { status: 404 });
  }

  const nodeStream = createReadStream(clip.path);
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;

  return new NextResponse(webStream, {
    headers: {
      "content-type": "video/mp4",
      "cache-control": "no-store",
      "content-disposition": `inline; filename="${clip.id}.mp4"`,
    },
  });
}
