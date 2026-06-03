import { NextResponse } from "next/server";
import AdmZip from "adm-zip";

import { createServerClient } from "@/lib/supabase";
import { appConfig } from "@/lib/config";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

export const runtime = "nodejs";

function createR2Client(): S3Client {
  const { accountId, accessKeyId, secretAccessKey } = appConfig.r2;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY must be set.");
  }
  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

async function fetchR2Buffer(s3: S3Client, bucket: string, key: string): Promise<Buffer> {
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new Error(`Empty body for R2 key: ${key}`);
  const chunks: Buffer[] = [];
  for await (const chunk of result.Body as any) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ clipId: string }> },
) {
  try {
    const { clipId } = await context.params;
    const db = createServerClient();

    const { data: clip } = await db
      .from("clips")
      .select("r2_clip_key, r2_follow_up_clip_key, title")
      .eq("id", clipId)
      .single();

    if (!clip?.r2_clip_key) {
      return NextResponse.json({ error: "Clip not found." }, { status: 404 });
    }
    if (!clip?.r2_follow_up_clip_key) {
      return NextResponse.json({ error: "Follow-up clip not found." }, { status: 400 });
    }

    const s3 = createR2Client();
    const { bucket } = appConfig.r2;

    const [mainBuffer, followUpBuffer] = await Promise.all([
      fetchR2Buffer(s3, bucket, clip.r2_clip_key),
      fetchR2Buffer(s3, bucket, clip.r2_follow_up_clip_key),
    ]);

    const zip = new AdmZip();
    const safeTitle = (clip.title ?? "clip").replace(/[^\w\s.-]/g, "_");
    
    zip.addFile(`${safeTitle}.mp4`, mainBuffer);
    zip.addFile(`${safeTitle}_follow_up.mp4`, followUpBuffer);

    const zipBuffer = zip.toBuffer();

    return new NextResponse(zipBuffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${safeTitle}_bundle.zip"`,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unexpected error." },
      { status: 500 },
    );
  }
}
