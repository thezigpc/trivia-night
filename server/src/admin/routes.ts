import express from "express";
import { adminRouter as kitAdminRouter, bearerToken, createAdminAuth, log } from "@bargames/gamekit/server";
import { LIMITS, packToCsv, parsePack, type AdminSettings } from "@trivia/shared";
import { ADMIN_PASSWORD, store } from "../config.js";
import { ADMIN_CLOSE_REASON, listRooms, type Rooms } from "../rooms/registry.js";
import { bg, clientIp, onBox } from "../bargames.js";
import { getAdminSettings, updateAdminSettings } from "./settings.js";
import { deletePack, getPack, listPacks, savePack } from "../content/packs.js";
import { deletePicture, listPictures, savePicture } from "../content/pictures.js";
import { knownTeams, removeKnownTeam, renameKnownTeam } from "../content/teams.js";

/**
 * The admin password (the kit's admin auth): ADMIN_PASSWORD, or a scrypt hash set once on
 * the /admin setup screen (DATA_DIR/admin.json). On a box the venue's own admin password
 * opens it too, and staff signed in to the box get in without one.
 */
export const adminAuth = createAdminAuth({
  store,
  envPassword: ADMIN_PASSWORD,
  saltFormat: "bytes",
  // Standalone behind Cloudflare a venue's Wi-Fi shares one public IP: no per-IP lockout
  // there (the kit's global cap and delay still slow guessing). On a box each device has its own.
  failsAllowed: onBox ? undefined : Infinity,
  venuePassword: (password, ip) => bg.checkVenuePassword(password, ip),
  onBox: bg.connected,
});

const errorText = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");

/**
 * Uploads (packs and pictures): their own JSON limit, since the kit's admin router reads
 * bodies of 16 KB at most. Mounted at /api/admin/upload, before the kit's router.
 */
export function uploadRouter(): express.Router {
  const r = express.Router();
  r.use(express.json({ limit: "6mb" }));
  r.use((req, res, next) => {
    if (!adminAuth.isValidSession(bearerToken(req))) return void res.status(401).json({ ok: false, error: "Sign in again." });
    next();
  });
  /** Checks a pack without saving it: what was read and every problem, by row. */
  r.post("/packs/preview", (req, res) => {
    const text = String(req.body?.text ?? "");
    if (Buffer.byteLength(text) > LIMITS.packTextBytes) return void res.status(413).json({ ok: false, error: "That file is too big (2 MB at most)." });
    const parsed = parsePack(text);
    res.json({ ok: true, name: parsed.name, description: parsed.description, questions: parsed.questions, errors: parsed.errors });
  });
  /** Saves a pack (all of it must be valid), new or replacing `id`. */
  r.post("/packs", async (req, res) => {
    try {
      const text = String(req.body?.text ?? "");
      if (Buffer.byteLength(text) > LIMITS.packTextBytes) throw new Error("That file is too big (2 MB at most).");
      const parsed = parsePack(text);
      if (parsed.errors.length) return void res.status(400).json({ ok: false, error: "Fix the problems listed first.", errors: parsed.errors });
      const pack = await savePack({
        id: typeof req.body?.id === "string" && req.body.id ? req.body.id : undefined,
        name: String(req.body?.name ?? "") || parsed.name || "",
        description: String(req.body?.description ?? "") || parsed.description,
        questions: parsed.questions,
      });
      log.info("admin", "pack saved", { id: pack.id, questions: pack.questions.length });
      res.json({ ok: true, id: pack.id });
    } catch (err) {
      res.status(400).json({ ok: false, error: errorText(err) });
    }
  });
  r.post("/pictures", async (req, res) => {
    try {
      const name = await savePicture(String(req.body?.name ?? ""), String(req.body?.data ?? ""), req.body?.replace === true);
      log.info("admin", "picture saved", { name });
      res.json({ ok: true, name });
    } catch (err) {
      res.status(400).json({ ok: false, error: errorText(err) });
    }
  });
  return r;
}

/** /api/admin/*: the kit's status, setup, login and logout, then the game's own pages. */
export function adminRouter(rooms: Rooms): express.Router {
  const r = kitAdminRouter({ auth: adminAuth, clientIp, trusted: (req) => bg.isStaff(req) });

  // Everything below needs a signed-in admin (the kit's router checks it).
  r.get("/overview", async (_req, res) => {
    res.json({
      rooms: listRooms(rooms),
      settings: getAdminSettings(),
      packs: listPacks(),
      pictures: await listPictures(),
      teams: knownTeams(),
      serverTime: Date.now(),
    });
  });

  r.get("/packs/:id", (req, res) => {
    const pack = getPack(String(req.params.id));
    if (!pack) return void res.status(404).json({ ok: false, error: "That pack is gone." });
    if (req.query.format === "csv") {
      res.type("text/csv").attachment(`${pack.name.replace(/[^\w.-]+/g, "-")}.csv`).send(packToCsv(pack));
      return;
    }
    res.json({ ok: true, pack });
  });

  r.delete("/packs/:id", async (req, res) => {
    const ok = await deletePack(String(req.params.id));
    log.info("admin", "pack deleted", { id: req.params.id, ok });
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { ok: false, error: "That pack is gone (the sample pack can't be deleted)." });
  });

  r.delete("/pictures/:name", async (req, res) => {
    const ok = await deletePicture(String(req.params.name));
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { ok: false, error: "That picture is gone (the sample pictures can't be deleted)." });
  });

  r.post("/teams/rename", async (req, res) => {
    try {
      const team = await renameKnownTeam(String(req.body?.from ?? ""), String(req.body?.to ?? ""));
      res.json({ ok: true, team });
    } catch (err) {
      res.status(400).json({ ok: false, error: errorText(err) });
    }
  });

  r.post("/teams/remove", async (req, res) => {
    const ok = await removeKnownTeam(String(req.body?.name ?? ""));
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { ok: false, error: "That team isn't on the list." });
  });

  r.post("/rooms/:code/close", (req, res) => {
    const code = String(req.params.code).toUpperCase();
    const ok = rooms.closeRoom(code, ADMIN_CLOSE_REASON, "admin");
    log.info("admin", "closed room", { code, ok });
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { ok: false, error: "That room is already gone." });
  });

  r.put("/settings", async (req, res) => {
    try {
      const settings = await updateAdminSettings((req.body ?? {}) as Partial<AdminSettings>);
      rooms.sweepIdle();
      res.json({ ok: true, settings });
    } catch (err) {
      res.status(400).json({ ok: false, error: errorText(err) });
    }
  });

  return r;
}
