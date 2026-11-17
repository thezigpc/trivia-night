import { createServer } from "http";
import { existsSync } from "fs";
import path from "path";
import express from "express";
import { Server } from "socket.io";
import { DEFAULT_GAME_NAME, type PublicConfig } from "@trivia/shared";
import { installShutdown, log, serveSpa, SOCKET_SERVER_OPTIONS } from "@bargames/gamekit/server";
import { CLIENT_DIST_PATH, PORT } from "./config.js";
import { createRooms, defaultNightSpec } from "./rooms/registry.js";
import { adminAuth, adminRouter } from "./admin/routes.js";
import { getAdminSettings, initAdminSettings } from "./admin/settings.js";
import { registerSocketHandlers, type IO } from "./socket/index.js";
import { bg, displayName, registerBarGames } from "./bargames.js";
import { initPacks, listPacks } from "./content/packs.js";
import { picturePath, PICTURE_TYPES } from "./content/pictures.js";
import { initTeams, knownTeams } from "./content/teams.js";

await initAdminSettings();
await adminAuth.init();
await initPacks();
await initTeams();

const app = express();
app.disable("x-powered-by");
const httpServer = createServer(app);
const io: IO = new Server(httpServer, { ...SOCKET_SERVER_OPTIONS, maxHttpBufferSize: 64 * 1024 });

const rooms = createRooms({
  sendState: (socketId, view) => io.to(socketId).emit("state", view),
  sendClosed: (socketId, reason) => io.to(socketId).emit("closed", { reason }),
  sendNotice: (socketId, message) => io.to(socketId).emit("notice", { message }),
});

// Bar Games: /__bargames/* (venue.json, theme.css, command, status), before the SPA catch-all.
app.use(bg.middleware());
registerBarGames(rooms);

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});
app.use("/api/admin", adminRouter(rooms));

/** The game's name (the venue's on a box), the defaults, and the packs (no answers). */
app.get("/api/config", async (_req, res) => {
  const a = getAdminSettings();
  const body: PublicConfig = {
    gameName: await displayName(process.env.GAME_NAME || DEFAULT_GAME_NAME),
    defaults: { mode: a.defaultMode, revealMode: a.defaultRevealMode, timerSeconds: a.defaultTimerSeconds },
    packs: listPacks(),
  };
  res.json(body);
});
app.get("/api/default-night", (_req, res) => {
  res.json({ ok: true, spec: defaultNightSpec() });
});

/** Teams that have played here before, newest first, for "pick an existing team". */
app.get("/api/teams", (_req, res) => {
  res.set("cache-control", "no-store").json({ teams: knownTeams().map((t) => t.name) });
});

/** Pictures for picture rounds (uploads, then the sample pack's). */
app.get("/api/pictures/:name", (req, res) => {
  const file = picturePath(String(req.params.name));
  if (!file) return void res.status(404).end();
  const ext = path.extname(file).slice(1).toLowerCase();
  res.set({
    "content-type": PICTURE_TYPES[ext] ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
    // A picture is only ever shown in an <img>; nothing in it may run.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "cache-control": "public, max-age=300",
  });
  res.sendFile(file);
});

if (existsSync(CLIENT_DIST_PATH)) {
  serveSpa(app, { dist: CLIENT_DIST_PATH });
} else {
  log.warn("boot", "client build not found; serving API only", { path: CLIENT_DIST_PATH });
}

registerSocketHandlers(io, rooms);

httpServer.listen(PORT, () => {
  log.info("boot", "listening", { port: PORT });
});

installShutdown(rooms, {
  restartReason: "The server is restarting for an update. Please rejoin in a minute.",
  crashReason: "The server hit an unexpected error and had to restart. Please rejoin in a minute.",
  drainMs: 500,
  flush: () => bg.flush(),
  beforeExit: () => void io.close(),
});
