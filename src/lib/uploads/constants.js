import path from "path";

export const MIME_LOOKUP = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

export const EXT_LOOKUP_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/tiff": "tiff",
};

export const MAX_UPLOAD_BYTES = 45 * 1024 * 1024; // 45 MB hard cap per image
export const MAX_UPLOAD_COUNT = 6;

export const sanitizeEnv = (value) =>
  typeof value === "string" ? value.trim().replace(/^['"]|['"]$/g, "") : undefined;

export const trimSlashes = (value) =>
  typeof value === "string" ? value.replace(/^\/+|\/+$/g, "") : value;

export const deduceMimeFromName = (filename) => {
  if (typeof filename !== "string" || filename.length === 0) {
    return undefined;
  }

  const ext = path.extname(filename).toLowerCase();
  return MIME_LOOKUP[ext];
};
