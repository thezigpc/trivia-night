import { useGameName as kitUseGameName, usePublicConfig } from "@bargames/gamekit/client";
import { DEFAULT_GAME_NAME, type PublicConfig } from "@trivia/shared";
import { serverUrl } from "./socket";

/** The game's name (GAME_NAME; the venue's rename on a box). Sets document.title. */
export const useGameName = (): string => kitUseGameName(serverUrl, DEFAULT_GAME_NAME);

const parse = (raw: unknown): PublicConfig => {
  const r = (raw ?? {}) as Partial<PublicConfig>;
  return {
    gameName: typeof r.gameName === "string" ? r.gameName : DEFAULT_GAME_NAME,
    defaults: r.defaults ?? { mode: "phones", revealMode: "each", timerSeconds: 45 },
    packs: Array.isArray(r.packs) ? r.packs : [],
  };
};

/** /api/config: name, defaults and the packs (no answers). */
export const useConfig = (): PublicConfig | null => usePublicConfig(serverUrl, parse);
