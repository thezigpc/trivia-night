// Question packs: the sample pack that ships with the game (read-only), plus the venue's
// own packs uploaded in the admin, kept in DATA_DIR/packs.json.
import { readFileSync } from "fs";
import path from "path";
import { log, newSerial } from "@bargames/gamekit/server";
import { LIMITS, parsePack, summarizePack, type Pack, type PackSummary, type Question } from "@trivia/shared";
import { ASSETS_DIR, store } from "../config.js";

const FILE = "packs.json";
export const SAMPLE_PACK_ID = "sample";

interface PackFile {
  packs: Pack[];
}
const isPackFile = (v: unknown): v is PackFile =>
  !!v && typeof v === "object" && Array.isArray((v as PackFile).packs);

let sample: Pack;
let packs: Pack[] = [];

function loadSample(): Pack {
  const parsed = parsePack(readFileSync(path.join(ASSETS_DIR, "sample-pack.json"), "utf8"));
  if (parsed.errors.length) throw new Error(`sample pack: ${parsed.errors.join(" ")}`);
  return {
    id: SAMPLE_PACK_ID,
    name: parsed.name ?? "Sample pack",
    description: parsed.description,
    builtIn: true,
    questions: parsed.questions,
    updatedAt: 0,
  };
}

/** A saved pack, re-checked question by question (a hand-edited file never stops the server). */
function revive(p: Pack): Pack | undefined {
  if (!p || typeof p.id !== "string" || typeof p.name !== "string" || !Array.isArray(p.questions)) return undefined;
  const parsed = parsePack(JSON.stringify({ questions: p.questions }), (i) => p.questions[i]?.id || `q${i + 1}`);
  if (parsed.errors.length) log.warn("packs", "dropped bad questions from a saved pack", { id: p.id, errors: parsed.errors.length });
  return { ...p, builtIn: false, questions: parsed.questions };
}

export async function initPacks(): Promise<void> {
  sample = loadSample();
  const file = await store.read<PackFile>(FILE, isPackFile);
  packs = (file?.packs ?? []).map(revive).filter((p): p is Pack => !!p);
}

const all = (): Pack[] => [sample, ...packs];

export function listPacks(): PackSummary[] {
  return [summarizePack(sample), ...[...packs].sort((a, b) => a.name.localeCompare(b.name)).map(summarizePack)];
}

export const getPack = (id: string): Pack | undefined => all().find((p) => p.id === id);

/** Saves a new pack, or replaces one by id. Throws with a readable message. */
export async function savePack(input: {
  id?: string;
  name: string;
  description?: string;
  questions: Question[];
}): Promise<Pack> {
  const name = String(input.name ?? "").trim().slice(0, LIMITS.packName);
  if (!name) throw new Error("Give the pack a name.");
  if (!input.questions.length) throw new Error("The pack has no questions.");
  if (input.id === SAMPLE_PACK_ID) throw new Error("The sample pack can't be changed. Upload your own pack instead.");
  if (input.id && !packs.some((p) => p.id === input.id)) throw new Error("That pack is gone. Upload it as a new pack.");
  if (!input.id && packs.length >= LIMITS.packs) throw new Error(`There's room for ${LIMITS.packs} packs. Delete one first.`);
  const pack: Pack = {
    id: input.id ?? newSerial(8).toLowerCase(),
    name,
    description: String(input.description ?? "").trim().slice(0, LIMITS.packDescription) || undefined,
    questions: input.questions.map((q, i) => ({ ...q, id: `q${i + 1}` })),
    updatedAt: Date.now(),
  };
  const next = input.id ? packs.map((p) => (p.id === pack.id ? pack : p)) : [...packs, pack];
  await store.write(FILE, { packs: next } satisfies PackFile);
  packs = next;
  return pack;
}

export async function deletePack(id: string): Promise<boolean> {
  if (!packs.some((p) => p.id === id)) return false;
  const next = packs.filter((p) => p.id !== id);
  await store.write(FILE, { packs: next } satisfies PackFile);
  packs = next;
  return true;
}
