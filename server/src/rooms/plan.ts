// Building a night from packs: "Round 1: General (10), Round 2: Science (8), Pictures,
// Final". The room keeps its own copy of the questions, so editing or deleting a pack later
// never changes a night that's already set up.
import { cryptoRand } from "@bargames/gamekit/server";
import {
  FINAL_ID,
  SETTINGS_LIMITS,
  TIEBREAK_ID,
  type NightSpec,
  type Pack,
  type PackSummary,
  type Question,
  type RoundSpec,
} from "@trivia/shared";
import { GameError } from "./errors.js";

/** A question in tonight's running order. round: 0-based; -1 the final; -2 the tie-breaker. */
export interface RoomQuestion extends Question {
  qid: string;
  round: number;
  number: number;
}

export interface Night {
  rounds: { title: string; questions: RoomQuestion[] }[];
  final: RoomQuestion | null;
  tiebreak: RoomQuestion | null;
}

function shuffled<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = cryptoRand(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** A spec from the client, checked and bounded. Throws GameError("BAD_SPEC"). */
export function cleanSpec(raw: unknown): NightSpec {
  const r = (raw ?? {}) as Partial<NightSpec>;
  if (!Array.isArray(r.rounds)) throw new GameError("BAD_SPEC");
  const rounds: RoundSpec[] = r.rounds.slice(0, SETTINGS_LIMITS.roundsPerNight).map((x, i) => {
    const s = (x ?? {}) as Partial<RoundSpec>;
    const count = Math.round(Number(s.count));
    if (typeof s.packId !== "string" || !Number.isFinite(count) || count < 1) throw new GameError("BAD_SPEC");
    return {
      title: String(s.title ?? "").trim().slice(0, 60) || `Round ${i + 1}`,
      packId: s.packId,
      category: String(s.category ?? "").slice(0, 60),
      count: Math.min(count, SETTINGS_LIMITS.questionsPerRound),
    };
  });
  return {
    rounds,
    finalPackId: typeof r.finalPackId === "string" && r.finalPackId ? r.finalPackId : null,
    tiebreaker: r.tiebreaker === true,
    shuffle: r.shuffle === true,
  };
}

/**
 * The questions for a spec. Each round draws questions it hasn't used yet from its pack
 * (and category); a round that finds none is refused, one that finds fewer than asked just
 * gets fewer. The final takes a "final" question from its pack, and the tie-breaker the first
 * "tiebreaker" question in the night's packs (else any pack's).
 */
export function buildNight(spec: NightSpec, getPack: (id: string) => Pack | undefined, allPacks: () => Pack[]): Night {
  const used = new Set<string>();
  const key = (p: Pack, q: Question) => `${p.id}/${q.id}`;
  const rounds: Night["rounds"] = [];
  for (const rs of spec.rounds) {
    const pack = getPack(rs.packId);
    if (!pack) continue;
    let pool = pack.questions.filter((q) => q.use === "round" && !used.has(key(pack, q)) && (!rs.category || q.category === rs.category));
    if (spec.shuffle) pool = shuffled(pool);
    const picked = pool.slice(0, rs.count);
    if (!picked.length) continue;
    picked.forEach((q) => used.add(key(pack, q)));
    const r = rounds.length;
    rounds.push({
      title: rs.title,
      questions: picked.map((q, i) => ({ ...q, qid: `r${r + 1}q${i + 1}`, round: r, number: i + 1 })),
    });
  }
  if (!rounds.length) throw new GameError("NO_ROUNDS");

  let final: RoomQuestion | null = null;
  if (spec.finalPackId) {
    const pack = getPack(spec.finalPackId);
    const pool = pack ? pack.questions.filter((q) => q.use === "final") : [];
    const q = spec.shuffle ? shuffled(pool)[0] : pool[0];
    if (q) final = { ...q, qid: FINAL_ID, round: -1, number: 1 };
  }

  let tiebreak: RoomQuestion | null = null;
  if (spec.tiebreaker) {
    const nightPacks = [...new Set([...spec.rounds.map((r) => r.packId), spec.finalPackId ?? ""])]
      .map((id) => getPack(id))
      .filter((p): p is Pack => !!p);
    const others = allPacks().filter((p) => !nightPacks.includes(p));
    for (const p of [...nightPacks, ...others]) {
      const q = p.questions.find((x) => x.use === "tiebreaker");
      if (q) {
        tiebreak = { ...q, qid: TIEBREAK_ID, round: -2, number: 1 };
        break;
      }
    }
  }
  return { rounds, final, tiebreak };
}

/**
 * A ready-made night from one pack: a round per category (up to 10 questions each), its
 * final if it has one, and a tie-breaker.
 */
export function defaultSpec(pack: PackSummary | undefined): NightSpec {
  if (!pack) return { rounds: [], finalPackId: null, tiebreaker: false, shuffle: false };
  const cats = pack.categories.length ? pack.categories : [{ name: "", count: pack.count }];
  return {
    rounds: cats.map((c, i) => ({
      title: c.name || `Round ${i + 1}`,
      packId: pack.id,
      category: c.name,
      count: Math.min(10, c.count),
    })),
    finalPackId: pack.finals ? pack.id : null,
    tiebreaker: true,
    shuffle: false,
  };
}
