import path from "path";
import { createJsonStore } from "@bargames/gamekit/server";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const PORT = num("PORT", 3010);
/** Built client, served by this process (one origin). */
export const CLIENT_DIST_PATH = process.env.CLIENT_DIST_PATH ?? path.resolve(here, "../../client/dist");
/** Files that ship with the game: the sample pack and its pictures. */
export const ASSETS_DIR = path.resolve(here, "../assets");
/**
 * Everything the server writes: the admin password hash, settings, question packs, uploaded
 * pictures and the venue's known teams. On a Bar Games box: the /data volume.
 */
export const DATA_DIR = process.env.DATA_DIR ?? path.resolve(here, "../../data");
export const store = createJsonStore(DATA_DIR);
export const DEFAULT_ROOM_IDLE_MINUTES = num("ROOM_IDLE_MINUTES", 240);
export const ROOM_SWEEP_INTERVAL_MS = num("ROOM_SWEEP_INTERVAL_MS", 60 * 1000);
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
export const MAX_ROOMS = num("MAX_ROOMS", 50);
export const MAX_TEAMS_PER_ROOM = num("MAX_TEAMS_PER_ROOM", 60);
export const MAX_TABLES_PER_ROOM = num("MAX_TABLES_PER_ROOM", 8);
/** Uploaded pictures: at most this many bytes each. */
export const MAX_PICTURE_BYTES = num("MAX_PICTURE_BYTES", 3 * 1024 * 1024);
export const MAX_PICTURES = num("MAX_PICTURES", 500);
