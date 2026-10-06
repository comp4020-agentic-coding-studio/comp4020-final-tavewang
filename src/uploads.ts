import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { uploadsDir } from "./db.ts";
import { newId } from "./ids.ts";

const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const MAX_BYTES = 5 * 1024 * 1024;

export interface UploadRejection {
  error: string;
}

// Saves a photo under DATA_DIR/uploads and returns the relative path to store
// on the item, or an explanation of why it was rejected. `value` is whatever
// FormData.get() returned for the field — undefined/null/a plain string all
// mean "no file was actually attached" (the field was empty), which is fine:
// the photo is optional.
export async function saveUploadedPhoto(value: FormDataEntryValue | null): Promise<string | null | UploadRejection> {
  if (!value || typeof value === "string") return null;
  const file = value;
  if (file.size === 0) return null;
  if (file.size > MAX_BYTES) {
    return { error: `Photo is too large (max ${MAX_BYTES / 1024 / 1024} MB).` };
  }
  const ext = ALLOWED_TYPES[file.type];
  if (!ext) {
    return { error: "Photo must be a JPEG, PNG, or WebP image." };
  }
  const filename = `${newId()}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(join(uploadsDir, filename), buffer);
  return `uploads/${filename}`;
}

export function isUploadRejection(value: unknown): value is UploadRejection {
  return typeof value === "object" && value !== null && "error" in value;
}

// Serving: only ever reads a filename of exactly this shape back out of
// DATA_DIR/uploads, so a crafted ":name" can't walk outside it.
export const SAFE_UPLOAD_NAME = /^[A-Za-z0-9_-]+\.(?:jpg|png|webp)$/;

export function contentTypeFor(filename: string): string {
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}
