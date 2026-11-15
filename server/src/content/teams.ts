// The venue's known teams (DATA_DIR/teams.json): every team that finished a night here.
// Teams come back week after week, so creating a team offers these names, and a typed name
// that matches one (ignoring case and spacing) takes its saved spelling. Season standings
// (Tournament & Leaderboard) join nights by team name, so a stable spelling keeps a team's
// season in one piece.
import { cleanTeamName, teamKey, type KnownTeam } from "@trivia/shared";
import { store } from "../config.js";

const FILE = "teams.json";
const MAX_KNOWN = 2000;

interface TeamFile {
  teams: KnownTeam[];
}
const isTeamFile = (v: unknown): v is TeamFile => !!v && typeof v === "object" && Array.isArray((v as TeamFile).teams);

let teams: KnownTeam[] = [];

export async function initTeams(): Promise<void> {
  const file = await store.read<TeamFile>(FILE, isTeamFile);
  teams = (file?.teams ?? []).filter((t) => t && typeof t.name === "string" && cleanTeamName(t.name));
}

/** Most recent first. */
export const knownTeams = (): KnownTeam[] => [...teams].sort((a, b) => b.lastSeen - a.lastSeen || a.name.localeCompare(b.name));

/** The saved spelling of a typed team name, or the typed name tidied. "" when blank. */
export function canonicalTeamName(raw: unknown): string {
  const name = cleanTeamName(raw);
  if (!name) return "";
  const key = teamKey(name);
  return teams.find((t) => teamKey(t.name) === key)?.name ?? name;
}

const save = async (next: KnownTeam[]) => {
  await store.write(FILE, { teams: next } satisfies TeamFile);
  teams = next;
};

/** A night finished: these teams played. */
export async function recordNight(names: string[], now = Date.now()): Promise<void> {
  const next = teams.map((t) => ({ ...t }));
  for (const raw of names) {
    const name = cleanTeamName(raw);
    if (!name) continue;
    const t = next.find((x) => teamKey(x.name) === teamKey(name));
    if (t) {
      t.nights++;
      t.lastSeen = now;
    } else next.push({ name, nights: 1, firstSeen: now, lastSeen: now });
  }
  next.sort((a, b) => b.lastSeen - a.lastSeen);
  await save(next.slice(0, MAX_KNOWN));
}

/**
 * Renames a known team. Renaming onto another known team merges the two (nights added up),
 * which is how staff fix a misspelt duplicate. Throws with a readable message.
 */
export async function renameKnownTeam(from: string, to: string): Promise<KnownTeam> {
  const name = cleanTeamName(to);
  if (!name) throw new Error("Enter the team's name.");
  const src = teams.find((t) => teamKey(t.name) === teamKey(from));
  if (!src) throw new Error("That team isn't on the list any more.");
  const other = teams.find((t) => t !== src && teamKey(t.name) === teamKey(name));
  let next: KnownTeam[];
  let result: KnownTeam;
  if (other) {
    result = {
      name,
      nights: other.nights + src.nights,
      firstSeen: Math.min(other.firstSeen, src.firstSeen),
      lastSeen: Math.max(other.lastSeen, src.lastSeen),
    };
    next = teams.filter((t) => t !== src && t !== other).concat(result);
  } else {
    result = { ...src, name };
    next = teams.map((t) => (t === src ? result : t));
  }
  await save(next);
  return result;
}

export async function removeKnownTeam(name: string): Promise<boolean> {
  const next = teams.filter((t) => teamKey(t.name) !== teamKey(name));
  if (next.length === teams.length) return false;
  await save(next);
  return true;
}
