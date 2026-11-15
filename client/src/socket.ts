import { io, type Socket } from "socket.io-client";
import { createCall, serverBase, serverOrigin, socketPath, SOCKET_OPTIONS } from "@bargames/gamekit/client";
import type { ClientToServerEvents, ServerToClientEvents } from "@trivia/shared";

// In dev, Vite serves the client on :5180 and the server runs on :3010. In production the
// server serves the built client (one origin). Under a path prefix (a Bar Games box's
// https://<venue>/trivia/) `serverUrl` carries it; socket.io takes the bare origin plus a path.
const dev = { vitePort: 5180, serverPort: 3010 };
export const serverUrl = serverBase(dev);

// WebSocket first (the kit's SOCKET_OPTIONS): polling-first lost early emits through tunnels.
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(serverOrigin(dev), {
  ...SOCKET_OPTIONS,
  autoConnect: false,
  path: socketPath(),
});

const kitCall = createCall(socket as unknown as Parameters<typeof createCall>[0]);

/** Emit with an ack as a promise. Rejects with the server's message. */
export function call<T = object>(event: keyof ClientToServerEvents, ...args: unknown[]): Promise<T> {
  return kitCall<T>(event, ...args);
}

/** A picture's address: an http(s) link as is, an uploaded or sample picture from the server. */
export const pictureUrl = (image: string): string =>
  /^https?:\/\//i.test(image) ? image : `${serverUrl}/api/pictures/${encodeURIComponent(image)}`;

/** Teams that have played at this venue before (for "pick an existing team"). */
export async function loadKnownTeams(): Promise<string[]> {
  try {
    const r = await fetch(`${serverUrl}/api/teams`);
    const b = (await r.json()) as { teams?: unknown };
    return Array.isArray(b.teams) ? b.teams.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}
