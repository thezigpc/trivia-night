// The pure rules: questions, packs, answer matching and pack parsing (CSV or JSON).
// No I/O here, so the server, the client and the tests share one copy.

export type QuestionType = "open" | "choice" | "truefalse" | "number";
/** Where a question can go: a normal round, the wager final, or the "closest to" tie-breaker. */
export type QuestionUse = "round" | "final" | "tiebreaker";

export const QUESTION_TYPES: readonly QuestionType[] = ["open", "choice", "truefalse", "number"];
export const QUESTION_USES: readonly QuestionUse[] = ["round", "final", "tiebreaker"];

export interface Question {
  id: string;
  text: string;
  answer: string;
  /** Other spellings that count as right ("Abe Lincoln"). */
  accept: string[];
  type: QuestionType;
  /** Multiple choice (2-6) and true/false ("True", "False"); empty otherwise. */
  choices: string[];
  category: string;
  points: number;
  /** A picture: an http(s) URL, or the name of a picture uploaded in the admin. */
  image?: string;
  /** Shown to the host and co-hosts only. */
  note?: string;
  use: QuestionUse;
}

export interface Pack {
  id: string;
  name: string;
  description?: string;
  /** The sample pack that ships with the game (read-only). */
  builtIn?: boolean;
  questions: Question[];
  updatedAt: number;
}

export interface PackSummary {
  id: string;
  name: string;
  description?: string;
  builtIn: boolean;
  /** Round questions (finals and tie-breakers counted apart). */
  count: number;
  categories: { name: string; count: number }[];
  finals: number;
  tiebreakers: number;
  pictures: number;
  updatedAt: number;
}

export const LIMITS = {
  questionText: 500,
  answer: 200,
  accept: 20,
  choices: { min: 2, max: 6 },
  choiceText: 120,
  category: 60,
  note: 500,
  image: 500,
  points: { min: 0, max: 100 },
  packName: 80,
  packDescription: 300,
  questionsPerPack: 2000,
  packs: 100,
  packTextBytes: 2 * 1024 * 1024,
  teamName: 32,
  teams: 60,
} as const;

export function summarizePack(p: Pack): PackSummary {
  const cats = new Map<string, number>();
  let count = 0;
  for (const q of p.questions) {
    if (q.use !== "round") continue;
    count++;
    const c = q.category || "";
    cats.set(c, (cats.get(c) ?? 0) + 1);
  }
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    builtIn: p.builtIn === true,
    count,
    categories: [...cats].map(([name, n]) => ({ name, count: n })),
    finals: p.questions.filter((q) => q.use === "final").length,
    tiebreakers: p.questions.filter((q) => q.use === "tiebreaker").length,
    pictures: p.questions.filter((q) => q.image).length,
    updatedAt: p.updatedAt,
  };
}

// ------------------------------------------------------------------ answers

/**
 * An answer reduced to what matters: lowercase, accents and punctuation gone, "&" as
 * "and", a leading "the", "a" or "an" dropped, single spaces.
 */
export function normalizeAnswer(s: string): string {
  let t = String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s.]/gu, " ")
    // A dot between digits is a decimal point ("2.5"); every other dot goes.
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  t = t.replace(/^(the|a|an) /, "");
  return t;
}

/** Edit distance, capped: stops counting past `max` (returns max + 1). */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

export type Verdict = "correct" | "close" | "wrong";

export function parseNumber(s: string): number | undefined {
  const t = String(s ?? "").replace(/[,\s]/g, "").trim();
  if (!/^[-+]?\d*\.?\d+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Automatic marking. "correct" scores straight away; "close" (a near-miss such as "Abe
 * Lincoln", or a typo) is flagged for the host or a co-host to accept; "wrong" doesn't
 * score. Multiple choice, true/false and numbers are exact.
 */
export function checkAnswer(q: Pick<Question, "type" | "answer" | "accept">, given: string): Verdict {
  const g = normalizeAnswer(given);
  if (!g) return "wrong";
  if (q.type === "number") {
    const n = parseNumber(given);
    const want = parseNumber(q.answer);
    if (n !== undefined && want !== undefined) return n === want ? "correct" : "wrong";
  }
  const targets = [q.answer, ...q.accept].map(normalizeAnswer).filter(Boolean);
  if (targets.includes(g)) return "correct";
  if (q.type !== "open") return "wrong";
  for (const t of targets) {
    // A typo: one edit in a short answer, two in a longer one.
    const allowed = t.length >= 10 ? 2 : t.length >= 4 ? 1 : 0;
    if (allowed && editDistance(g, t, allowed) <= allowed) return "close";
    // Part of the answer ("Lincoln" for "Abraham Lincoln") or the answer plus more.
    const words = (s: string) => s.split(" ").filter((w) => w.length >= 3);
    const gw = words(g);
    const tw = words(t);
    if (gw.length && tw.length && (gw.every((w) => tw.includes(w)) || tw.every((w) => gw.includes(w)))) return "close";
  }
  return "wrong";
}

// --------------------------------------------------------------- validation

export interface ParsedPack {
  name?: string;
  description?: string;
  questions: Question[];
  /** Human-readable problems, each naming its row ("Row 4: …"). */
  errors: string[];
}

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v)).trim();
const list = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  const s = str(v);
  return s ? s.split("|").map((x) => x.trim()).filter(Boolean) : [];
};

const TRUE_WORDS = ["true", "t", "yes", "y"];
const FALSE_WORDS = ["false", "f", "no", "n"];

/** A picture reference: an http(s) URL, or an uploaded picture's file name. */
export function isPictureRef(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s) || /^[\w][\w.-]{0,80}\.(png|jpe?g|gif|webp|svg)$/i.test(s);
}

/**
 * One raw question (a CSV row or a JSON object) checked and cleaned. Returns the
 * question, or the reason it can't be used.
 */
export function cleanQuestion(raw: Record<string, unknown>, id: string): Question | string {
  const get = (...keys: string[]) => {
    for (const k of keys) if (raw[k] !== undefined && str(raw[k]) !== "") return raw[k];
    return undefined;
  };
  const text = str(get("question", "text", "q"));
  const answer = str(get("answer", "a"));
  if (!text) return "the question is empty";
  if (text.length > LIMITS.questionText) return `the question is longer than ${LIMITS.questionText} characters`;
  if (!answer) return "the answer is empty";
  if (answer.length > LIMITS.answer) return `the answer is longer than ${LIMITS.answer} characters`;

  let use = str(get("use", "slot")).toLowerCase() as QuestionUse;
  if (use === ("tiebreak" as QuestionUse) || use === ("tie-breaker" as QuestionUse)) use = "tiebreaker";
  if (!use) use = "round";
  if (!QUESTION_USES.includes(use)) return `"use" must be round, final or tiebreaker (found "${use}")`;

  let choices = list(get("choices", "options"));
  if (!choices.length) {
    choices = ["choice_a", "choice_b", "choice_c", "choice_d", "choice_e", "choice_f"].map((k) => str(raw[k])).filter(Boolean);
  }
  let type = str(get("type")).toLowerCase().replace(/[\s_-]/g, "") as string;
  if (type === "multiplechoice" || type === "mc") type = "choice";
  if (type === "tf" || type === "truefalse" || type === "boolean") type = "truefalse";
  if (type === "numeric" || type === "closest") type = "number";
  if (type === "text" || type === "openanswer") type = "open";
  if (!type) {
    if (use === "tiebreaker") type = "number";
    else if (choices.length) type = "choice";
    else if ([...TRUE_WORDS.slice(0, 1), ...FALSE_WORDS.slice(0, 1)].includes(answer.toLowerCase())) type = "truefalse";
    else type = "open";
  }
  if (!QUESTION_TYPES.includes(type as QuestionType)) {
    return `"type" must be open, choice, truefalse or number (found "${type}")`;
  }

  let finalAnswer = answer;
  let accept = list(get("accept", "alternatives", "alt", "also"));
  if (accept.length > LIMITS.accept) return `more than ${LIMITS.accept} accepted alternatives`;
  if (type === "choice") {
    if (choices.length < LIMITS.choices.min || choices.length > LIMITS.choices.max) {
      return `a multiple-choice question needs ${LIMITS.choices.min} to ${LIMITS.choices.max} choices (separate them with "|")`;
    }
    if (choices.some((c) => c.length > LIMITS.choiceText)) return `a choice is longer than ${LIMITS.choiceText} characters`;
    // The answer may be the choice's text or its letter.
    const letter = /^[a-f]$/i.test(answer) ? answer.toUpperCase().charCodeAt(0) - 65 : -1;
    const match = choices.find((c) => normalizeAnswer(c) === normalizeAnswer(answer)) ?? (letter >= 0 ? choices[letter] : undefined);
    if (!match) return `the answer "${answer}" isn't one of the choices`;
    finalAnswer = match;
    accept = [];
  } else if (type === "truefalse") {
    const a = answer.toLowerCase();
    if (TRUE_WORDS.includes(a)) finalAnswer = "True";
    else if (FALSE_WORDS.includes(a)) finalAnswer = "False";
    else return `a true/false answer must be True or False (found "${answer}")`;
    choices = ["True", "False"];
    accept = [];
  } else if (type === "number") {
    if (parseNumber(answer) === undefined) {
      return use === "tiebreaker"
        ? `a tie-breaker's answer must be a number: closest wins (found "${answer}")`
        : `a number question needs a number as its answer (found "${answer}")`;
    }
    choices = [];
  } else {
    choices = [];
  }
  if (use === "tiebreaker" && type !== "number") return "a tie-breaker must be a number question (closest wins)";

  const category = str(get("category", "cat", "round"));
  if (category.length > LIMITS.category) return `the category is longer than ${LIMITS.category} characters`;
  const pointsRaw = str(get("points", "pts"));
  const points = pointsRaw === "" ? 1 : Number(pointsRaw);
  if (!Number.isFinite(points) || points < LIMITS.points.min || points > LIMITS.points.max) {
    return `points must be a number from ${LIMITS.points.min} to ${LIMITS.points.max} (found "${pointsRaw}")`;
  }
  const image = str(get("image", "picture", "pic"));
  if (image && (image.length > LIMITS.image || !isPictureRef(image))) {
    return `the picture must be an http(s) link or an uploaded picture's file name (found "${image.slice(0, 60)}")`;
  }
  const note = str(get("note", "host_note", "hostnote", "notes"));
  if (note.length > LIMITS.note) return `the host note is longer than ${LIMITS.note} characters`;

  return {
    id,
    text,
    answer: finalAnswer,
    accept,
    type: type as QuestionType,
    choices,
    category,
    points: Math.round(points * 100) / 100,
    ...(image ? { image } : {}),
    ...(note ? { note } : {}),
    use,
  };
}

/** RFC 4180 CSV: quoted fields, doubled quotes, commas/newlines inside quotes, CRLF, a BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const headerKey = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");

/**
 * A pack from an upload: JSON ({ name, questions: [...] } or a bare array) or CSV (a
 * header row naming the columns). Every problem is reported with its row, and only clean
 * questions are returned.
 */
export function parsePack(text: string, makeId: (i: number) => string = (i) => `q${i + 1}`): ParsedPack {
  const t = String(text ?? "").replace(/^﻿/, "").trim();
  if (!t) return { questions: [], errors: ["The file is empty."] };
  const errors: string[] = [];
  const questions: Question[] = [];
  let name: string | undefined;
  let description: string | undefined;
  let raws: { row: string; raw: Record<string, unknown> }[] = [];

  if (t.startsWith("{") || t.startsWith("[")) {
    let data: unknown;
    try {
      data = JSON.parse(t);
    } catch (e) {
      return { questions: [], errors: [`That isn't valid JSON: ${(e as Error).message}`] };
    }
    const obj = (Array.isArray(data) ? { questions: data } : data) as { name?: unknown; description?: unknown; questions?: unknown };
    if (!obj || typeof obj !== "object" || !Array.isArray(obj.questions)) {
      return { questions: [], errors: ['JSON packs need a "questions" array (or are an array of questions).'] };
    }
    name = str(obj.name) || undefined;
    description = str(obj.description) || undefined;
    raws = obj.questions.map((q, i) => ({
      row: `Question ${i + 1}`,
      raw: q && typeof q === "object" ? (q as Record<string, unknown>) : { question: "" },
    }));
  } else {
    const rows = parseCsv(t);
    if (rows.length < 2) return { questions: [], errors: ["A CSV pack needs a header row and at least one question."] };
    const head = rows[0].map(headerKey);
    if (!head.includes("question") && !head.includes("text")) {
      return { questions: [], errors: ['The CSV header row needs a "question" column (and "answer").'] };
    }
    raws = rows.slice(1).map((r, i) => ({
      row: `Row ${i + 2}`,
      raw: Object.fromEntries(head.map((h, j) => [h, r[j] ?? ""])),
    }));
  }

  if (raws.length > LIMITS.questionsPerPack) {
    errors.push(`A pack holds at most ${LIMITS.questionsPerPack} questions; only the first ${LIMITS.questionsPerPack} were read.`);
    raws = raws.slice(0, LIMITS.questionsPerPack);
  }
  raws.forEach(({ row, raw }, i) => {
    const q = cleanQuestion(raw, makeId(i));
    if (typeof q === "string") errors.push(`${row}: ${q}.`);
    else questions.push(q);
  });
  if (name && name.length > LIMITS.packName) name = name.slice(0, LIMITS.packName);
  if (description && description.length > LIMITS.packDescription) description = description.slice(0, LIMITS.packDescription);
  return { name, description, questions, errors };
}

const csvField = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export const CSV_COLUMNS = ["question", "answer", "accept", "type", "choices", "category", "points", "image", "note", "use"] as const;

/** A pack as CSV, in the same columns the upload reads. */
export function packToCsv(p: Pick<Pack, "questions">): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const q of p.questions) {
    lines.push(
      [
        q.text,
        q.answer,
        q.accept.join("|"),
        q.type,
        q.type === "choice" ? q.choices.join("|") : "",
        q.category,
        String(q.points),
        q.image ?? "",
        q.note ?? "",
        q.use,
      ]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

// ------------------------------------------------------------- team names

/**
 * The key two team names share when they're the same team: case and spacing ignored,
 * which is how Tournament & Leaderboard joins nights into a season.
 */
export const teamKey = (name: string): string => String(name ?? "").toLowerCase().replace(/\s+/g, "");

/** A typed team name, tidied: trimmed, single spaces, at most LIMITS.teamName characters. */
export const cleanTeamName = (name: unknown): string =>
  String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LIMITS.teamName);
