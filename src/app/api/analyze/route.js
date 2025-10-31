import { schematicConfig } from "@/config/schematic";
import { promises as fs } from "fs";
import OpenAI from "openai";
import { NextResponse } from "next/server";
import path from "path";

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

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024; // 12 MB
const MAX_UPLOAD_COUNT = 6;

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
      };
    });
}

async function buildImageInputs(uploadPayloads) {
  const contents = [];
  const normalizedUploads = normalizeUploads(uploadPayloads);

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
    contents.push({
      type: "input_text",
      text: `Uploaded ${upload.id}: ${upload.name}`,
    });
    contents.push({
      type: "input_image",
      image_url: upload.dataUrl,
      detail: upload.detail,
    });
  }

  return contents;
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
    const imageInputs = await buildImageInputs(body.uploads);

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

    return NextResponse.json({
      output: response.output_text,
      usage: response.usage,
      model,
      uploadsAttached: imageInputs.filter(
        (item) => item.type === "input_image"
      ).length,
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
