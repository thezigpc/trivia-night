// The game's single connection to a Bar Games box (see BARGAMES.md).
//
// Off a box (no BG_CORE_URL / BG_GAME_TOKEN env) every call here is a no-op and the game
// runs standalone: that's guaranteed by the SDK.
import { wireBarGames } from "@bargames/gamekit/bargames";
import { createBarGames, type CommandResult } from "@bargames/sdk/server";
import type { IncomingMessage } from "node:http";
import { DEFAULT_GAME_NAME } from "@trivia/shared";
import { createVenueRoom, HOST_CLOSE_REASON, type Rooms } from "./rooms/registry.js";
import { cohostPath, hostPath, type Room } from "./rooms/Room.js";
import { GameError } from "./rooms/errors.js";

export const bg = createBarGames({
  gameId: "trivia",
  defaultName: process.env.GAME_NAME || DEFAULT_GAME_NAME,
});

/** True when running on a box. Guards anything box-only. */
export const onBox = bg.connected;

/** Real player IP for rate limits and logs (the gateway's on a box, cf-connecting-ip otherwise). */
export const clientIp = (req: IncomingMessage): string => bg.clientIp(req);

/** Display name: the venue's rename on a box, otherwise GAME_NAME. */
export async function displayName(fallback: string): Promise<string> {
  return onBox ? (await bg.venue()).game.displayName : fallback;
}

/**
 * Level 3, through the kit's wireBarGames: status, the room_created / room_closed /
 * players_changed events, create_room, the standard commands and hosting from the box.
 * Each command runs the same Room method as the host's own button, then broadcasts.
 */
export function registerBarGames(rooms: Rooms): void {
  const asHost =
    (fn: (room: Room) => void) =>
    (room: Room): CommandResult => {
      try {
        fn(room);
      } catch (err) {
        if (err instanceof GameError) return { ok: false, message: err.message };
        throw err;
      }
      room.broadcast();
      return { ok: true };
    };

  wireBarGames(bg, rooms, {
    // The box starts a room for its TVs. No host phone: the commands drive it, and hostUrl
    // opens the empty host seat (the coordinator's console) on the staff's iPad.
    // firstJoinerHosts: the first phone to join from the TV's QR code becomes the host.
    createVenueRoom: ({ kind, title, firstJoinerHosts }) => {
      const { room, hostToken } = createVenueRoom(rooms, kind ?? "venue", title, firstJoinerHosts === true);
      room.broadcast();
      return { room, hostUrl: hostPath(room, hostToken) };
    },
    commands: {
      // The host's "Start the night" (round 1 goes up on the TV).
      start: asHost((room) => room.start()),
      // Freezes the answer timer and shows "Paused" on the TV.
      pause: asHost((room) => room.setPaused(true)),
      resume: asHost((room) => room.setPaused(false)),
      // The next round's title card (after the last round: the final's wagers).
      next_round: asHost((room) => room.nextRound()),
    },
    // Hosting from the box (SDK 0.14.0, kit 0.8.0): take over, co-host invites, remove a co-host.
    seats: {
      of: (room) => room.seats,
      hostPath,
      cohostPath,
      onTakeover: (room, previous) => {
        room.takeOver(previous);
        room.broadcast();
      },
      onCohostRemoved: (room, memberId) => {
        room.demoteCohost(memberId);
        room.broadcast();
      },
    },
    // "end" closes the room like the host's own Close, with the same message and cause.
    endReason: HOST_CLOSE_REASON,
    endCause: "host",
  });
}
