import { schematicConfig } from "@/config/schematic";
import {
  EXT_LOOKUP_BY_MIME,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_COUNT,
  MIME_LOOKUP,
  sanitizeEnv,
  trimSlashes,
} from "@/lib/uploads/constants";
import { promises as fs } from "fs";
import OpenAI from "openai";
import { NextResponse } from "next/server";
import path from "path";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";

const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const AWS_UPLOAD_PREFIX = sanitizeEnv(process.env.AWS_VISION_PREFIX) ?? "vision-uploads";
const AWS_REGION = sanitizeEnv(process.env.AWS_REGION) ?? "us-east-1";
const AWS_BUCKET = sanitizeEnv(process.env.AWS_BUCKET_NAME);
const AWS_ACCESS_KEY_ID = sanitizeEnv(process.env.AWS_ACCESS_KEY_ID);
const AWS_ACCESS_KEY_SECRET = sanitizeEnv(process.env.AWS_ACCESS_KEY_SECRET);
const AWS_SCHEMATICS_FOLDER =
  sanitizeEnv(process.env.AWS_SCHEMATICS_FOLDER) ?? "schematics";

const hasAwsConfig = Boolean(AWS_BUCKET && AWS_ACCESS_KEY_ID && AWS_ACCESS_KEY_SECRET);

const s3Client = hasAwsConfig
  ? new S3Client({
      region: AWS_REGION,
      credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_ACCESS_KEY_SECRET,
      },
    })
  : null;

function toDataUrl(filePath, fileBuffer) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_LOOKUP[ext];

  if (!mimeType) {
    throw new Error(
      `Unsupported schematic image extension "${ext}". Update MIME_LOOKUP to continue.`
    );
  }

  return `data:${mimeType};base64,${fileBuffer.toString("base64")}`;
}

function bufferToDataUrl(buffer, mimeType = "application/octet-stream") {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function normalizeUploads(uploads = []) {
  if (!Array.isArray(uploads) || uploads.length === 0) {
    return [];
  }

  return uploads
    .slice(0, MAX_UPLOAD_COUNT)
    .map((upload, index) => {
      const id = `upload-${index + 1}`;
      const name = upload.name?.trim() || `Uploaded image ${index + 1}`;
      const detail = upload.detail ?? "high";
      const dataUrl = typeof upload.dataUrl === "string" ? upload.dataUrl.trim() : "";
      const remoteUrl =
        typeof upload.url === "string" ? upload.url.trim() : "";
      const s3Key =
        typeof upload.s3Key === "string"
          ? trimSlashes(upload.s3Key.trim())
          : undefined;
      const blobPathname =
        typeof upload.blobPathname === "string"
          ? trimSlashes(upload.blobPathname.trim())
          : typeof upload.blobPath === "string"
          ? trimSlashes(upload.blobPath.trim())
          : undefined;
      const bufferCandidate =
        Buffer.isBuffer(upload.buffer)
          ? upload.buffer
          : upload.buffer instanceof ArrayBuffer
          ? Buffer.from(upload.buffer)
          : upload.buffer instanceof Uint8Array
          ? Buffer.from(upload.buffer)
          : null;
      const reportedBytes =
        typeof upload.bytes === "number" && Number.isFinite(upload.bytes)
          ? upload.bytes
          : typeof upload.size === "number" && Number.isFinite(upload.size)
          ? upload.size
          : undefined;
      const explicitMime =
        typeof upload.mimeType === "string"
          ? upload.mimeType.toLowerCase()
          : typeof upload.type === "string"
          ? upload.type.toLowerCase()
          : undefined;

      if (bufferCandidate) {
        const bytes = reportedBytes ?? bufferCandidate.length;
        if (bytes > MAX_UPLOAD_BYTES) {
          throw new Error(
            `Uploaded image "${
              upload.name ?? `#${index + 1}`
            }" exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit.`
          );
        }

        const ext = path.extname(name).toLowerCase();
        const inferredMime =
          explicitMime ?? MIME_LOOKUP[ext] ?? "application/octet-stream";

        return {
          id,
          name,
          detail,
          buffer: bufferCandidate,
          mimeType: inferredMime,
          bytes,
          dataUrl: dataUrl || undefined,
          blobPathname,
        };
      }

      if (dataUrl) {
        const dataUrlMatch =
          /^data:(?<mime>[^;]+);base64,(?<data>.+)$/i.exec(dataUrl);

        if (!dataUrlMatch?.groups?.data) {
          throw new Error(
            `Uploaded image #${index + 1} is missing a valid base64 data URL.`
          );
        }

        const buffer = Buffer.from(dataUrlMatch.groups.data, "base64");
        if (buffer.length > MAX_UPLOAD_BYTES) {
          throw new Error(
            `Uploaded image "${
              upload.name ?? `#${index + 1}`
            }" exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB limit.`
          );
        }

        return {
          id,
          name,
          detail,
          dataUrl,
          buffer,
          mimeType: dataUrlMatch.groups.mime?.toLowerCase() ?? "application/octet-stream",
          bytes: buffer.length,
          blobPathname,
        };
      }

      if (remoteUrl) {
        return {
          id,
          name,
          detail,
          remoteUrl,
          bytes: reportedBytes,
          mimeType: explicitMime,
          blobPathname,
        };
      }

      if (s3Key) {
        return {
          id,
          name,
          detail,
          s3Key,
          bytes: reportedBytes,
          mimeType: explicitMime,
          blobPathname,
        };
      }

      throw new Error(
        `Upload "${name}" must include either a base64 dataUrl, direct url, or s3Key.`
      );
    });
}

async function uploadBufferToS3(buffer, mimeType) {
  if (!s3Client) {
    return null;
  }

  const extension = EXT_LOOKUP_BY_MIME[mimeType] ?? "bin";
  const keySegments = [
    trimSlashes(AWS_UPLOAD_PREFIX),
    trimSlashes(AWS_SCHEMATICS_FOLDER),
    `${randomUUID()}.${extension}`,
  ].filter(Boolean);
  const key = keySegments.join("/");

  await s3Client.send(
    new PutObjectCommand({
      Bucket: AWS_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      CacheControl: "max-age=3600",
    })
  );

  const signedUrl = await getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: AWS_BUCKET,
      Key: key,
    }),
    { expiresIn: 60 * 60 }
  );

  return { key, url: signedUrl };
}

async function createSignedUrlForKey(key) {
  if (!s3Client) {
    throw new Error("AWS credentials are not configured for S3 access.");
  }

  const sanitizedKey = trimSlashes(key);
  const signedUrl = await getSignedUrl(
    s3Client,
    new GetObjectCommand({
      Bucket: AWS_BUCKET,
      Key: sanitizedKey,
    }),
    { expiresIn: 60 * 60 }
  );

  return { key: sanitizedKey, url: signedUrl };
}

async function buildImageInputs(uploadPayloads) {
  const contents = [];
  const normalizedUploads = normalizeUploads(uploadPayloads);
  const uploadSummaries = [];

  for (const image of schematicConfig.images) {
    const absolutePath = path.join(
      process.cwd(),
      "public",
      image.path.replace(/^\/+/, "")
    );

    const file = await fs.readFile(absolutePath);

    contents.push({
      type: "input_text",
      text: `Reference ${image.id}: ${image.label}${
        image.caption ? ` — ${image.caption}` : ""
      }`,
    });

    contents.push({
      type: "input_image",
      image_url: toDataUrl(absolutePath, file),
      detail: image.detail ?? "high",
    });
  }

  for (const upload of normalizedUploads) {
    let imageUrlPayload;
    let strategy;
    const summary = {
      id: upload.id,
      name: upload.name,
    };
    if (typeof upload.bytes === "number") {
      summary.bytes = upload.bytes;
    }

    if (typeof upload.mimeType === "string") {
      summary.mimeType = upload.mimeType;
    }

    if (upload.remoteUrl) {
      imageUrlPayload = upload.remoteUrl;
      const isBlobUrl = /vercel-storage\.com/i.test(upload.remoteUrl);
      strategy = isBlobUrl ? "vercel-blob" : "remote-url";
      summary.strategy = strategy;
      summary.url = upload.remoteUrl;
      if (upload.blobPathname) {
        summary.blobPathname = upload.blobPathname;
      }
    }

    if (!imageUrlPayload && upload.s3Key) {
      try {
        const presigned = await createSignedUrlForKey(upload.s3Key);
        if (presigned?.url) {
          imageUrlPayload = presigned.url;
          strategy = "s3-key";
          summary.strategy = strategy;
          summary.key = presigned.key;
          summary.url = presigned.url;
        }
      } catch (error) {
        console.error("Failed to sign existing S3 key", {
          error,
          key: upload.s3Key,
          name: upload.name,
        });
        throw new Error(
          `Unable to load uploaded image "${upload.name}" from S3.`
        );
      }
    }

    if (!imageUrlPayload && upload.buffer && s3Client) {
      try {
        const offloadResult = await uploadBufferToS3(
          upload.buffer,
          upload.mimeType
        );

        if (offloadResult?.url) {
          imageUrlPayload = offloadResult.url;
          strategy = "s3";
          summary.strategy = strategy;
          summary.key = offloadResult.key;
          summary.url = offloadResult.url;
        }
      } catch (error) {
        console.error("Failed to offload upload to S3, falling back to inline", {
          error,
          name: upload.name,
        });
      }
    }

    if (!imageUrlPayload) {
      const inlineDataUrl =
        upload.dataUrl ||
        (upload.buffer && upload.mimeType
          ? bufferToDataUrl(upload.buffer, upload.mimeType)
          : null);

      if (inlineDataUrl) {
        imageUrlPayload = inlineDataUrl;
        strategy = "inline";
        summary.strategy = strategy;
      }
    }

    if (!imageUrlPayload) {
      throw new Error(
        `Unable to determine an image URL for upload "${upload.name}".`
      );
    }

    uploadSummaries.push(summary);

    if (upload.buffer) {
      upload.buffer = undefined;
    }

    contents.push({
      type: "input_text",
      text: `Uploaded ${upload.id}: ${upload.name}`,
    });
    contents.push({
      type: "input_image",
      image_url: imageUrlPayload,
      detail: upload.detail,
    });
  }

  return {
    contents,
    uploadSummaries,
  };
}

function estimateCostUsd(usage) {
  if (!usage || !schematicConfig.model.pricingUsdPerMTok) {
    return null;
  }

  const { input_tokens: inputTokens = 0, output_tokens: outputTokens = 0 } =
    usage;
  const { input: inputRate, output: outputRate } =
    schematicConfig.model.pricingUsdPerMTok;

  const inputUsd = (inputTokens / 1_000_000) * inputRate;
  const outputUsd = (outputTokens / 1_000_000) * outputRate;

  return {
    inputUsd,
    outputUsd,
    totalUsd: inputUsd + outputUsd,
  };
}

export async function POST(req) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      {
        error: "OPENAI_API_KEY is not configured on the server.",
      },
      { status: 500 }
    );
  }

  const contentType = req.headers.get("content-type") ?? "";
  let question = "";
  let uploadPayloads = [];

  if (contentType.includes("multipart/form-data")) {
    let formData;
    try {
      formData = await req.formData();
    } catch (error) {
      console.error("Failed to parse multipart form data", error);
      return NextResponse.json(
        { error: "Invalid multipart form payload." },
        { status: 400 }
      );
    }

    const promptField = formData.get("prompt") ?? formData.get("question");
    const FileCtor = globalThis.File;
    if (typeof promptField === "string") {
      question = promptField.trim();
    } else if (FileCtor && promptField instanceof FileCtor) {
      const promptText = await promptField.text();
      question = promptText.trim();
    }

    const defaultDetail =
      typeof formData.get("detail") === "string"
        ? formData.get("detail").trim()
        : undefined;

    let uploadsMeta = {};
    const metaField = formData.get("uploadsMeta");
    if (typeof metaField === "string" && metaField.trim().length > 0) {
      try {
        uploadsMeta = JSON.parse(metaField);
      } catch (error) {
        console.warn("Unable to parse uploadsMeta JSON", error);
      }
    }

    const fileEntries = [];
    for (const [key, value] of formData.entries()) {
      if (FileCtor && value instanceof FileCtor) {
        fileEntries.push({ key, file: value });
      }
    }

    let index = 0;
    for (const { key, file } of fileEntries) {
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const bytes = buffer.length;
      if (bytes === 0) {
        continue;
      }

      const metaSource =
        uploadsMeta &&
        typeof uploadsMeta === "object" &&
        !Array.isArray(uploadsMeta)
          ? uploadsMeta[key] ?? uploadsMeta[file.name]
          : undefined;
      const meta =
        metaSource && typeof metaSource === "object" ? metaSource : {};

      const detail =
        typeof meta.detail === "string"
          ? meta.detail
          : defaultDetail ?? "high";
      const displayName =
        typeof meta.name === "string" && meta.name.trim().length > 0
          ? meta.name.trim()
          : file.name || `Uploaded image ${index + 1}`;

      const ext = path.extname(displayName).toLowerCase();
      const rawMime =
        (typeof meta.mimeType === "string" && meta.mimeType.trim().length > 0
          ? meta.mimeType.trim()
          : file.type) ||
        MIME_LOOKUP[ext] ||
        "application/octet-stream";
      const mimeType =
        typeof rawMime === "string" && rawMime.length > 0
          ? rawMime.trim().toLowerCase()
          : "application/octet-stream";

      uploadPayloads.push({
        name: displayName,
        detail,
        buffer,
        mimeType,
        bytes,
      });
      index += 1;
    }
  } else {
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON payload." },
        { status: 400 }
      );
    }

    question = body.prompt?.trim() ?? "";
    if (Array.isArray(body.uploads)) {
      uploadPayloads = body.uploads;
    }
  }

  if (!question) {
    return NextResponse.json(
      { error: "Prompt is required." },
      { status: 400 }
    );
  }

  try {
    const model = process.env.OPENAI_VISION_MODEL ?? schematicConfig.model.name;
    const { contents: imageInputs, uploadSummaries } = await buildImageInputs(
      uploadPayloads
    );

    const response = await openaiClient.responses.create({
      model,
      max_output_tokens: schematicConfig.model.maxOutputTokens,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: schematicConfig.systemPrompt,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                "A facilities manager is asking a question about the schematic.",
                "Return a concise, direct answer grounded in the drawing.",
                "If applicable, lay out instructions step-by-step with bullet numbers.",
                "If information is missing or unreadable, describe what else is needed.",
                "",
                `Question: ${question}`,
              ].join("\n"),
            },
            ...imageInputs,
          ],
        },
      ],
    });

    const costEstimate = estimateCostUsd(response.usage);

    return NextResponse.json({
      output: response.output_text,
      usage: response.usage,
      costEstimate,
      model,
      uploadsAttached: imageInputs.filter(
        (item) => item.type === "input_image"
      ).length,
      uploadSummaries,
    });
  } catch (error) {
    console.error("Vision request failed", error);

    return NextResponse.json(
      {
        error: "Vision request failed.",
        details:
          error instanceof Error ? error.message : "Unknown error occurred.",
      },
      { status: 500 }
    );
  }
}
