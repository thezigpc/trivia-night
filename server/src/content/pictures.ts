// Pictures for picture rounds: uploaded in the admin into DATA_DIR/pictures, and the sample
// pack's own pictures in assets/pictures. A question names one by its file name.
import { existsSync } from "fs";
import { mkdir, readdir, rm, stat, writeFile } from "fs/promises";
import path from "path";
import { ASSETS_DIR, DATA_DIR, MAX_PICTURE_BYTES, MAX_PICTURES } from "../config.js";

const UPLOADS = path.join(DATA_DIR, "pictures");
const BUILT_IN = path.join(ASSETS_DIR, "pictures");

export const PICTURE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** Safe picture names only: letters, digits, dot, dash, underscore, with an image extension. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,80}\.(png|jpe?g|gif|webp|svg)$/;

/** What the bytes really are. SVG uploads are refused: an SVG can carry script. */
function sniff(b: Buffer): string | undefined {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length > 6 && (b.subarray(0, 6).toString("ascii") === "GIF87a" || b.subarray(0, 6).toString("ascii") === "GIF89a")) return "gif";
  if (b.length > 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return undefined;
}

/** A tidy file name from what was uploaded, with the extension the bytes call for. */
export function pictureName(raw: string, ext: string): string {
  const base =
    String(raw ?? "")
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/, "")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .slice(0, 60) || "picture";
  return `${base}.${ext === "jpeg" ? "jpg" : ext}`;
}

/** The file for a picture name: an upload first, then the sample pack's own. */
export function picturePath(name: string): string | undefined {
  const n = String(name ?? "").toLowerCase();
  if (!NAME.test(n)) return undefined;
  for (const dir of [UPLOADS, BUILT_IN]) {
    const p = path.join(dir, n);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export interface PictureInfo {
  name: string;
  bytes: number;
  builtIn: boolean;
}

export async function listPictures(): Promise<PictureInfo[]> {
  const out: PictureInfo[] = [];
  for (const [dir, builtIn] of [
    [UPLOADS, false],
    [BUILT_IN, true],
  ] as const) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names.sort()) {
      if (!NAME.test(name)) continue;
      const s = await stat(path.join(dir, name)).catch(() => undefined);
      if (s?.isFile()) out.push({ name, bytes: s.size, builtIn });
    }
  }
  return out;
}

/** Saves an upload (base64). Throws with a readable message. Returns the name it got. */
export async function savePicture(rawName: string, base64: string, replace = false): Promise<string> {
  const bytes = Buffer.from(String(base64 ?? ""), "base64");
  if (!bytes.length) throw new Error("The picture is empty.");
  if (bytes.length > MAX_PICTURE_BYTES) throw new Error(`Pictures can be up to ${Math.round(MAX_PICTURE_BYTES / 1024 / 1024)} MB.`);
  const ext = sniff(bytes);
  if (!ext) throw new Error("Use a PNG, JPEG, GIF or WebP picture.");
  const name = pictureName(rawName, ext);
  await mkdir(UPLOADS, { recursive: true });
  const existing = await readdir(UPLOADS).catch(() => [] as string[]);
  if (existing.includes(name) && !replace) throw new Error(`There's already a picture called ${name}. Delete it first, or rename yours.`);
  if (!existing.includes(name) && existing.length >= MAX_PICTURES) throw new Error(`There's room for ${MAX_PICTURES} pictures.`);
  await writeFile(path.join(UPLOADS, name), bytes);
  return name;
}

export async function deletePicture(name: string): Promise<boolean> {
  const n = String(name ?? "").toLowerCase();
  if (!NAME.test(n)) return false;
  const p = path.join(UPLOADS, n);
  if (!existsSync(p)) return false;
  await rm(p);
  return true;
}
