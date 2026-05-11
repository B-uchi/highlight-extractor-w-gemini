import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { NextResponse } from "next/server";

import { appConfig } from "@/lib/config";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (appConfig.storage.mode !== "s3") {
    return NextResponse.json({ error: "Presigned uploads are enabled only in STORAGE_MODE=s3." }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as { fileName?: string; contentType?: string };
  const extension = path.extname(body.fileName ?? "") || ".mp4";
  const key = `inputs/${randomUUID()}/upload${extension}`;

  const client = new S3Client({
    region: appConfig.storage.region,
    endpoint: appConfig.storage.endpoint || undefined,
    forcePathStyle: true,
    credentials: {
      accessKeyId: appConfig.storage.accessKeyId,
      secretAccessKey: appConfig.storage.secretAccessKey,
    },
  });

  const url = await getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: appConfig.storage.bucket,
      Key: key,
      ContentType: body.contentType ?? "video/mp4",
    }),
    { expiresIn: 60 * 15 },
  );

  return NextResponse.json({ uploadUrl: url, key });
}
