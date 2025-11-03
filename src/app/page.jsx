"use client";

import { schematicConfig } from "@/config/schematic";
import { put } from "@vercel/blob/client";
import Image from "next/image";
import { useMemo, useState } from "react";

const MAX_UPLOAD_MB = 12;
const MAX_UPLOAD_COUNT = 6;

const formatUsd = (amount) => {
  if (typeof amount !== "number" || Number.isNaN(amount)) {
    return "—";
  }

  return `$${amount.toFixed(amount < 0.01 ? 4 : 2)}`;
};

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [uploads, setUploads] = useState([]);
  const [uploadError, setUploadError] = useState(null);
  const [isUploadingFiles, setIsUploadingFiles] = useState(false);

  const canSubmit = useMemo(
    () => !!prompt.trim() && !isLoading && !isUploadingFiles,
    [prompt, isLoading, isUploadingFiles]
  );

  const requestBlobUploadToken = async (file) => {
    const response = await fetch("/api/uploads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type,
        size: file.size,
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error ?? "Failed to prepare upload.");
    }

    return payload;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!prompt.trim() || isLoading) {
      return;
    }

    setIsLoading(true);
    setError(null);
    setResponse(null);

    try {
      const validUploads = uploads.filter(
        (upload) => typeof upload.url === "string" && upload.url.length > 0
      );

      if (validUploads.length !== uploads.length) {
        throw new Error(
          "Some uploads are incomplete. Remove failed items or retry before submitting."
        );
      }

      setUploadError(null);

      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          uploads: validUploads.map((upload) => ({
            name: upload.name,
            detail: upload.detail,
            url: upload.url,
            blobPathname: upload.blobPathname,
            size: upload.size,
            mimeType: upload.mimeType,
          })),
        }),
      });

      const result = await res.json();

      if (!res.ok) {
        throw new Error(result.error ?? "Vision request failed.");
      }

      setResponse(result);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Vision request failed."
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleExampleClick = (question) => {
    setPrompt(question);
  };

  const handleUploadChange = async (event) => {
    const fileList = event.target.files;
    if (!fileList) {
      return;
    }

    const remainingSlots = MAX_UPLOAD_COUNT - uploads.length;
    if (remainingSlots <= 0) {
      setUploadError(
        `Maximum of ${MAX_UPLOAD_COUNT} images attached at a time. Remove one before adding more.`
      );
      event.target.value = "";
      return;
    }

    const files = Array.from(fileList).slice(0, remainingSlots);
    const oversize = files.find(
      (file) => file.size > MAX_UPLOAD_MB * 1024 * 1024
    );

    if (oversize) {
      setUploadError(
        `"${oversize.name}" is larger than ${MAX_UPLOAD_MB}MB. Please upload a smaller export or downscale slightly.`
      );
      event.target.value = "";
      return;
    }

    const successfulUploads = [];
    let firstError = null;

    setUploadError(null);
    setIsUploadingFiles(true);
    try {
      for (const file of files) {
        try {
          const tokenPayload = await requestBlobUploadToken(file);
          const resolvedMime = (
            tokenPayload.contentType ||
            file.type ||
            ""
          ).toLowerCase();
          const blob = await put(tokenPayload.pathname, file, {
            access: "public",
            token: tokenPayload.token,
            contentType: resolvedMime || tokenPayload.contentType || file.type,
          });

          successfulUploads.push({
            id: crypto.randomUUID?.() ?? `upload-${Date.now()}-${file.name}`,
            name: file.name,
            size: file.size,
            detail: "high",
            url: blob.url,
            blobPathname: blob.pathname,
            mimeType: resolvedMime || tokenPayload.contentType || file.type,
          });
        } catch (caught) {
          if (!firstError) {
            firstError =
              caught instanceof Error
                ? caught.message
                : "Failed to upload file to storage.";
          }
        }
      }
    } finally {
      setIsUploadingFiles(false);
      event.target.value = "";
    }

    if (successfulUploads.length > 0) {
      setUploads((prev) => [...prev, ...successfulUploads]);
    }

    setUploadError(firstError);
  };

  const handleRemoveUpload = (id) => {
    setUploads((prev) => prev.filter((upload) => upload.id !== id));
  };

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 text-zinc-900 dark:bg-black dark:text-zinc-100">
      <header className="border-b border-zinc-200 bg-white/70 px-6 py-6 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/70">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.3em] text-zinc-500 dark:text-zinc-400">
              Vision POC
            </p>
            <h1 className="text-2xl font-semibold sm:text-3xl">
              {schematicConfig.displayName}
            </h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Upload one or more schematic exports below, then ask the model
              pointed questions about the space. Keep prompts natural—no special
              formatting required.
            </p>
          </div>
          <div className="text-sm text-zinc-500 dark:text-zinc-400">
            Model default:{" "}
            <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs dark:bg-zinc-800 dark:text-zinc-200">
              {process.env.NEXT_PUBLIC_OPENAI_VISION_MODEL ??
                schematicConfig.model.name}
            </code>
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-6 py-8 lg:flex-row">
        <section className="w-full max-w-xl space-y-6 lg:w-[380px]">
          <form
            onSubmit={handleSubmit}
            className="flex flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
          >
            <label className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
              Question
            </label>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="e.g. How do I get from Stair 6 to Elevator 3?"
              rows={4}
              className="w-full resize-none rounded-lg border border-zinc-300 bg-white p-3 text-sm shadow-inner focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/40 dark:border-zinc-700 dark:bg-zinc-950"
            />
            <div className="space-y-2 rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
              <div className="flex items-center justify-between text-[13px] font-medium text-zinc-800 dark:text-zinc-100">
                Additional images
                <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">
                  {uploads.length}/{MAX_UPLOAD_COUNT}
                </span>
              </div>
              <p>
                Optional session uploads (PNG/JPEG, &lt;= {MAX_UPLOAD_MB}MB each).
                Files stream to Vercel Blob storage first, then only signed URLs
                reach the model.
              </p>
              <label
                className={
                  "flex items-center justify-center rounded-md border border-dashed border-zinc-400 bg-white px-3 py-2 text-xs font-medium text-zinc-700 transition dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-200 " +
                  (isUploadingFiles
                    ? "cursor-not-allowed opacity-60"
                    : "cursor-pointer hover:border-zinc-500 dark:hover:border-zinc-400")
                }
              >
                <input
                  type="file"
                  accept=".png,.jpg,.jpeg,.webp,.tif,.tiff"
                  multiple
                  className="hidden"
                  disabled={isUploadingFiles}
                  onChange={handleUploadChange}
                />
                {isUploadingFiles ? "Uploading…" : "Upload images"}
              </label>
              {isUploadingFiles ? (
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  Large files may take a few moments while they stream to blob
                  storage.
                </p>
              ) : null}
              {uploadError ? (
                <p className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-700 dark:bg-red-950/60 dark:text-red-200">
                  {uploadError}
                </p>
              ) : null}
              {uploads.length > 0 ? (
                <ul className="space-y-2">
                  {uploads.map((upload) => (
                    <li
                      key={upload.id}
                      className="flex items-center justify-between rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-[13px] dark:border-zinc-700 dark:bg-zinc-900"
                    >
                      <span className="mr-2 truncate" title={upload.name}>
                        {upload.name}
                      </span>
                      <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                        <span>
                          {(upload.size / (1024 * 1024)).toFixed(2)}MB
                        </span>
                        <button
                          type="button"
                          onClick={() => handleRemoveUpload(upload.id)}
                          className="rounded bg-zinc-200 px-1.5 py-0.5 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <button
              type="submit"
              disabled={!canSubmit}
              className="mt-2 inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400"
            >
              {isLoading ? "Analyzing…" : "Send to Vision"}
            </button>
          </form>

          <div className="rounded-2xl border border-dashed border-zinc-300 bg-white/40 p-4 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-300">
            <p className="mb-2 font-medium text-zinc-900 dark:text-zinc-100">
              Example prompts
            </p>
            <ul className="space-y-2">
              {schematicConfig.exampleQuestions.map((question) => (
                <li key={question}>
                  <button
                    type="button"
                    onClick={() => handleExampleClick(question)}
                    className="w-full rounded-lg border border-transparent bg-zinc-100 px-3 py-2 text-left text-xs font-medium text-zinc-800 transition hover:border-zinc-300 hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
                  >
                    {question}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {schematicConfig.model.pricingUsdPerMTok ? (
            <div className="rounded-2xl border border-zinc-200 bg-white p-4 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
              <p className="font-medium text-zinc-900 dark:text-zinc-100">
                Estimated pricing (per request)
              </p>
              <p className="mt-2 text-xs leading-relaxed">
                Input tokens ≈ $
                {schematicConfig.model.pricingUsdPerMTok.input} / 1M, output
                tokens ≈ ${schematicConfig.model.pricingUsdPerMTok.output} / 1M.
                See response footer for actual usage + USD estimate.
              </p>
            </div>
          ) : null}

        </section>

        <section className="flex flex-1 flex-col gap-6">
          <div className="grid gap-4 lg:grid-cols-2">
            {schematicConfig.images.map((image) => (
              <figure
                key={image.id}
                className="flex flex-col gap-2 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="relative h-72 w-full overflow-hidden rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950">
                  <Image
                    src={`/${image.path.replace(/^\/+/, "")}`}
                    alt={image.label}
                    fill
                    sizes="(min-width: 1024px) 40vw, 90vw"
                    className="object-contain"
                    priority
                  />
                </div>
                <figcaption className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
                  {image.label}
                  {image.caption ? (
                    <span className="block text-xs font-normal text-zinc-500 dark:text-zinc-400">
                      {image.caption}
                    </span>
                  ) : null}
                </figcaption>
              </figure>
            ))}
            {uploads.length > 0
              ? uploads.map((upload) => (
                  <figure
                    key={upload.id}
                    className="flex flex-col gap-2 rounded-2xl border border-blue-200 bg-blue-50/60 p-4 shadow-sm dark:border-blue-800 dark:bg-blue-950/40"
                  >
                    <div className="relative h-72 w-full overflow-hidden rounded-xl border border-blue-200 bg-white dark:border-blue-700 dark:bg-blue-900/40">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={upload.dataUrl}
                        alt={upload.name}
                        className="h-full w-full object-contain"
                      />
                    </div>
                    <figcaption className="text-sm font-medium text-blue-900 dark:text-blue-100">
                      {upload.name}
                      <span className="block text-xs font-normal text-blue-700 dark:text-blue-200">
                        Session upload · {(
                          upload.size /
                          (1024 * 1024)
                        ).toFixed(2)}
                        MB
                      </span>
                    </figcaption>
                  </figure>
                ))
              : null}
            {schematicConfig.images.length === 0 && uploads.length === 0 ? (
              <div className="col-span-full flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-zinc-300 bg-white p-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900">
                <span className="text-base font-medium text-zinc-700 dark:text-zinc-200">
                  No schematics attached yet
                </span>
                <p>
                  Use the uploader on the left to add high-resolution floor plan
                  images for this session. They will appear here for quick
                  reference and be sent to the model with your prompt.
                </p>
              </div>
            ) : null}
          </div>

          <div className="flex flex-1 flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
                Vision response
              </h2>
              {response?.model ? (
                <code className="rounded bg-zinc-100 px-2 py-1 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                  {response.model}
                </code>
              ) : null}
            </div>

            {error ? (
              <p className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-700 dark:bg-red-950/50 dark:text-red-300">
                {error}
              </p>
            ) : null}

            {response?.output ? (
              <pre className="whitespace-pre-wrap rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm leading-relaxed text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100">
                {response.output}
              </pre>
            ) : (
              !error && (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  Submit a prompt to see the model output here.
                </p>
              )
            )}

            {response?.usage ? (
              <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-zinc-100 p-4 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
                <div className="flex flex-wrap items-center gap-4">
                  <div>
                    <span className="font-semibold">Input tokens:</span>{" "}
                    {response.usage.input_tokens ?? "—"}
                  </div>
                  <div>
                    <span className="font-semibold">Output tokens:</span>{" "}
                    {response.usage.output_tokens ?? "—"}
                  </div>
                  <div>
                    <span className="font-semibold">Total tokens:</span>{" "}
                    {response.usage.total_tokens ?? "—"}
                  </div>
                </div>
                {response.costEstimate ? (
                  <div className="flex flex-wrap items-center gap-4">
                    <div>
                      <span className="font-semibold">Input est.:</span>{" "}
                      {formatUsd(response.costEstimate.inputUsd)}
                    </div>
                    <div>
                      <span className="font-semibold">Output est.:</span>{" "}
                      {formatUsd(response.costEstimate.outputUsd)}
                    </div>
                    <div>
                      <span className="font-semibold">Total est.:</span>{" "}
                      {formatUsd(response.costEstimate.totalUsd)}
                    </div>
                  </div>
                ) : null}
                {response.uploadSummaries?.length ? (
                  <div className="flex flex-col gap-1 rounded-lg border border-zinc-200 bg-white p-3 text-[11px] text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                    <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">
                      Upload handling
                    </span>
                    {response.uploadSummaries.map((summary) => (
                      <div
                        key={summary.id}
                        className="flex flex-wrap items-center justify-between gap-2"
                      >
                        <span className="font-medium">
                          {summary.name}
                        </span>
                        <span className="uppercase tracking-wide text-[10px] text-blue-600 dark:text-blue-300">
                          {summary.strategy === "s3" ? "S3 offload" : "Inline"}
                        </span>
                        <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
                          {(summary.bytes / (1024 * 1024)).toFixed(2)}MB
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>
      </main>
    </div>
  );
}
