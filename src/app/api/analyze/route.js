import { schematicConfig } from "@/config/schematic";
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

const MIME_LOOKUP = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

const EXT_LOOKUP_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/tiff": "tiff",
};

const MAX_UPLOAD_BYTES = 45 * 1024 * 1024; // 45 MB hard cap per image
const MAX_UPLOAD_COUNT = 6;

const sanitizeEnv = (value) =>
  typeof value === "string" ? value.trim().replace(/^['"]|['"]$/g, "") : undefined;

const trimSlashes = (value) =>
  typeof value === "string" ? value.replace(/^\/+|\/+$/g, "") : value;

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

function normalizeUploads(uploads = []) {
  if (!Array.isArray(uploads) || uploads.length === 0) {
    return [];
  }

  return uploads
    .filter((candidate) => Boolean(candidate?.dataUrl))
    .slice(0, MAX_UPLOAD_COUNT)
    .map((upload, index) => {
      const dataUrl = upload.dataUrl.trim();
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
        id: `upload-${index + 1}`,
        name: upload.name?.trim() || `Uploaded image ${index + 1}`,
        detail: upload.detail ?? "high",
        dataUrl,
        buffer,
        mimeType: dataUrlMatch.groups.mime?.toLowerCase() ?? "application/octet-stream",
        bytes: buffer.length,
      };
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

async function buildImageInputs(uploadPayloads) {
  const contents = [];
  const normalizedUploads = normalizeUploads(uploadPayloads);
  const uploadSummaries = [];

  for (const upload of normalizedUploads) {
    let imageUrlPayload;
    let strategy;

    if (s3Client) {
      try {
        const offloadResult = await uploadBufferToS3(
          upload.buffer,
          upload.mimeType
        );

        if (offloadResult?.url) {
          imageUrlPayload = offloadResult.url;
          strategy = "s3";
          uploadSummaries.push({
            id: upload.id,
            name: upload.name,
            bytes: upload.bytes,
            strategy,
            key: offloadResult.key,
            url: offloadResult.url,
          });
        }
      } catch (error) {
        console.error("Failed to offload upload to S3, falling back to inline", {
          error,
          name: upload.name,
        });
      }
    }

    if (!imageUrlPayload) {
      imageUrlPayload = upload.dataUrl;
      strategy = "inline";
      uploadSummaries.push({
        id: upload.id,
        name: upload.name,
        bytes: upload.bytes,
        strategy,
      });
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

    upload.buffer = undefined;
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

  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload." },
      { status: 400 }
    );
  }

  const question = body.prompt?.trim();

  if (!question) {
    return NextResponse.json(
      { error: "Prompt is required." },
      { status: 400 }
    );
  }

  try {
    const model = process.env.OPENAI_VISION_MODEL ?? schematicConfig.model.name;
    const { contents: imageInputs, uploadSummaries } = await buildImageInputs(
      body.uploads
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
