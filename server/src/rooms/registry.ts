// The room registry (the game kit's RoomRegistry): codes, the room cap, the idle sweep (a
// box's venue room stays open while a TV shows it), close causes and players_changed.
import { HostSeats, RoomRegistry, type SessionKind } from "@bargames/gamekit/server";
import { DEFAULT_SETTINGS, type AdminRoomSummary, type NightSpec, type Pack, type RoomSettings } from "@trivia/shared";
import { getAdminSettings } from "../admin/settings.js";
import { MAX_ROOMS, ROOM_SWEEP_INTERVAL_MS } from "../config.js";
import { getPack, listPacks } from "../content/packs.js";
import { GameError } from "./errors.js";
import { buildNight, cleanSpec, defaultSpec, type Night } from "./plan.js";
import { Room, type RoomTransport } from "./Room.js";

export const IDLE_CLOSE_REASON = "This trivia night was closed after a long time with nothing happening.";
export const ADMIN_CLOSE_REASON = "An administrator closed this room.";
export const ERROR_CLOSE_REASON = "Something went wrong and this room had to close.";
export const HOST_CLOSE_REASON = "The host closed this trivia night.";

export type Rooms = RoomRegistry<Room>;

const allPacks = (): Pack[] => listPacks().map((s) => getPack(s.id)).filter((p): p is Pack => !!p);

/** A night from a spec (checked), or the default night from the first pack. */
export function nightFor(rawSpec: unknown): { spec: NightSpec; night: Night } {
  const spec = rawSpec === undefined ? defaultNightSpec() : cleanSpec(rawSpec);
  return { spec, night: buildNight(spec, getPack, allPacks) };
}

/** The ready-made night: the venue's newest uploaded pack, else the sample pack. */
export function defaultNightSpec(): NightSpec {
  const packs = listPacks();
  const own = packs.filter((p) => !p.builtIn && p.count > 0).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return defaultSpec(own ?? packs[0]);
}

/** Room settings: the admin's defaults, then what the creator asked for (checked). */
export function roomSettings(patch?: Partial<RoomSettings>): RoomSettings {
  const a = getAdminSettings();
  const s: RoomSettings = { mode: a.defaultMode, revealMode: a.defaultRevealMode, timerSeconds: a.defaultTimerSeconds ?? DEFAULT_SETTINGS.timerSeconds };
  if (patch?.mode === "phones" || patch?.mode === "paper") s.mode = patch.mode;
  if (patch?.revealMode === "each" || patch?.revealMode === "round") s.revealMode = patch.revealMode;
  const t = Math.round(Number(patch?.timerSeconds));
  if (Number.isFinite(t) && t >= 10 && t <= 300) s.timerSeconds = t;
  return s;
}

/**
 * Rooms are made with `pending` set: the registry's create() calls create(code, kind) with no
 * room-specific arguments, so the night is handed over this way, synchronously.
 */
let pending: { settings: RoomSettings; spec: NightSpec; night: Night } | null = null;

export function createRooms(transport: RoomTransport): Rooms {
  const rooms: Rooms = new RoomRegistry<Room>({
    create: (code, kind, ctx) => {
      const p = pending ?? { settings: roomSettings(), ...nightFor(undefined) };
      const room = new Room(code, transport, kind, p.settings, p.spec, p.night);
      room.onFatalError = () => ctx.close(ERROR_CLOSE_REASON, "error");
      room.onPlayersChanged = () => rooms.notePlayers(room);
      return room;
    },
    maxRooms: MAX_ROOMS,
    idleMinutes: () => getAdminSettings().roomIdleMinutes,
    sweepIntervalMs: ROOM_SWEEP_INTERVAL_MS,
    idleReason: IDLE_CLOSE_REASON,
    errorReason: ERROR_CLOSE_REASON,
    fullError: () => new GameError("ROOM_FULL"),
    // SDK 0.4.0: "Join" on the venue's games list, and the box's short room links (never private rooms).
    joinPath: (r) => `/join/${r.code}`,
  });
  return rooms;
}

/** A room with its night set up; `init` seats the creator before room_created fires. */
export function createRoom(
  rooms: Rooms,
  kind: SessionKind,
  opts: { settings?: Partial<RoomSettings>; spec?: unknown; title?: string },
  init: (room: Room) => void,
): Room {
  pending = { settings: roomSettings(opts.settings), ...nightFor(opts.spec) };
  try {
    return rooms.create(kind, (r) => {
      r.title = opts.title?.trim().slice(0, 60) || undefined;
      init(r);
    });
  } finally {
    pending = null;
  }
}

/**
 * Bar Games create_room: a room the box starts for its TVs, with no host phone. It gets an
 * empty host seat ("Venue") that staff open with the host link; with firstJoinerHosts the
 * first phone in takes it instead, until anyone attaches to it.
 */
export function createVenueRoom(
  rooms: Rooms,
  kind: SessionKind = "venue",
  title?: string,
  firstJoinerHosts = false,
): { room: Room; hostToken: string } {
  let hostToken = "";
  const room = createRoom(rooms, kind, { title }, (r) => {
    r.addHost("Venue");
    r.seats = new HostSeats({ firstJoinerHosts });
    hostToken = r.seats.hostToken;
  });
  return { room, hostToken };
}

export function listRooms(rooms: Rooms): AdminRoomSummary[] {
  return rooms
    .all()
    .map((r) => r.summary())
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}
