import { createSessionStore } from "@bargames/gamekit/client";
import type { Role } from "@trivia/shared";

export interface StoredSession {
  roomCode: string;
  token: string;
  name: string;
  role: Role;
}

// The kit's session store: the seat is per tab ("trivia_session:<tab id>") and kept in
// localStorage, so a reload or a backgrounded phone keeps its seat. Every key starts with
// "trivia_": on a box every game shares one origin.
export const sessions = createSessionStore<StoredSession>("trivia");

/** Last team name typed on this device, to prefill the join form. */
export const lastTeam = (): string => sessions.pref("last_team");
export const rememberTeam = (name: string): void => sessions.setPref("last_team", name);
