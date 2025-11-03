import {
  EXT_LOOKUP_BY_MIME,
  MAX_UPLOAD_BYTES,
  deduceMimeFromName,
  sanitizeEnv,
  trimSlashes,
} from "@/lib/uploads/constants";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import path from "path";

const BLOB_PREFIX =
  sanitizeEnv(process.env.BLOB_UPLOAD_PREFIX) ??
  sanitizeEnv(process.env.AWS_VISION_PREFIX) ??
  "vision-uploads";
const BLOB_FOLDER =
  sanitizeEnv(process.env.BLOB_UPLOAD_FOLDER) ??
  sanitizeEnv(process.env.AWS_SCHEMATICS_FOLDER) ??
  "schematics";
const BLOB_READ_WRITE_TOKEN = sanitizeEnv(process.env.BLOB_READ_WRITE_TOKEN);

const SUPPORTED_MIME_TYPES = new Set(Object.keys(EXT_LOOKUP_BY_MIME));

const buildPathname = (extension) => {
  const segments = [
    trimSlashes(BLOB_PREFIX),
    trimSlashes(BLOB_FOLDER),
    `${randomUUID()}.${extension}`,
  ].filter(Boolean);

  return segments.join("/");
};

export async function POST(req) {
  if (!BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "BLOB_READ_WRITE_TOKEN is not configured on the server." },
      { status: 500 }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload." },
      { status: 400 }
    );
  }

  const filename = typeof body?.filename === "string" ? body.filename.trim() : "";
  const contentType =
    typeof body?.contentType === "string" ? body.contentType.trim() : "";
  const size =
    typeof body?.size === "number" && Number.isFinite(body.size)
      ? body.size
      : undefined;

  if (!filename) {
    return NextResponse.json(
      { error: "filename is required." },
      { status: 400 }
    );
  }

  if (size && size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `File exceeds the ${Math.floor(
          MAX_UPLOAD_BYTES / (1024 * 1024)
        )}MB limit.`,
      },
      { status: 400 }
    );
  }

  const inferredMime =
    contentType ||
    deduceMimeFromName(filename) ||
    "application/octet-stream";

  if (!SUPPORTED_MIME_TYPES.has(inferredMime)) {
    return NextResponse.json(
      {
        error: `Unsupported content type "${inferredMime}". Allowed: ${Array.from(
          SUPPORTED_MIME_TYPES
        ).join(", ")}.`,
      },
      { status: 400 }
    );
  }

  const extension =
    EXT_LOOKUP_BY_MIME[inferredMime] ||
    path.extname(filename).replace(/^\./, "") ||
    "bin";

  const pathname = buildPathname(extension);

  try {
    const token = await generateClientTokenFromReadWriteToken({
      token: BLOB_READ_WRITE_TOKEN,
      pathname,
      maximumSizeInBytes: MAX_UPLOAD_BYTES,
      allowedContentTypes: Array.from(SUPPORTED_MIME_TYPES),
      addRandomSuffix: false,
      allowOverwrite: false,
    });

    return NextResponse.json({
      token,
      pathname,
      contentType: inferredMime,
    });
  } catch (error) {
    console.error("Failed to generate blob upload token", error);
    return NextResponse.json(
      { error: "Failed to generate blob upload token." },
      { status: 500 }
    );
  }
}
