// Socket events, room views and settings shared by the server and the client.
import type { PackSummary, Question, QuestionType, Verdict } from "./trivia.js";

export const DEFAULT_GAME_NAME = "Trivia Night";

/** How teams answer: on their phones, or on paper answer cards that the coordinator marks. */
export type Mode = "phones" | "paper";
/** When answers go up on the TV: after each question, or all together after the round. */
export type RevealMode = "each" | "round";
export type Role = "host" | "cohost" | "team" | "table";

export interface RoomSettings {
  mode: Mode;
  revealMode: RevealMode;
  /** Phones mode: seconds to answer each question. */
  timerSeconds: number;
}

export const SETTINGS_LIMITS = {
  timerSeconds: { min: 10, max: 300 },
  roundsPerNight: 20,
  questionsPerRound: 50,
} as const;

export const DEFAULT_SETTINGS: RoomSettings = { mode: "phones", revealMode: "each", timerSeconds: 45 };

// ------------------------------------------------------------- the night

/** One round of the night, as the host builds it: questions drawn from a pack. */
export interface RoundSpec {
  title: string;
  packId: string;
  /** "" = any category. */
  category: string;
  count: number;
}

export interface NightSpec {
  rounds: RoundSpec[];
  /** The wager final, from this pack's "final" questions (null: no final). */
  finalPackId: string | null;
  /** A "closest to" tie-breaker ready in case of a tie at the top. */
  tiebreaker: boolean;
  /** Shuffle the questions within each round's pack/category. */
  shuffle: boolean;
}

/** Question ids inside a room: "r1q3" (round 1, question 3), "final", "tb". */
export const FINAL_ID = "final";
export const TIEBREAK_ID = "tb";

/** What the TV shows right now. The host (or a co-host) moves it. */
export type Screen =
  | { kind: "lobby" }
  | { kind: "intro"; round: number }
  | { kind: "question"; qid: string }
  | { kind: "answer"; qid: string }
  | { kind: "roundAnswers"; round: number }
  | { kind: "standings" }
  | { kind: "wager" }
  | { kind: "over" };

/** A question as everyone may see it: no answer until it's revealed, no host note. */
export interface PublicQuestion {
  qid: string;
  /** 0-based round index; -1 the final, -2 the tie-breaker. */
  round: number;
  /** 1-based number within its round. */
  number: number;
  roundTitle: string;
  text: string;
  type: QuestionType;
  choices: string[];
  category: string;
  points: number;
  image?: string;
  /** Present once revealed. */
  answer?: string;
}

export interface StandingRow {
  teamId: string;
  name: string;
  score: number;
  place: number;
  /** Placed ahead of an equal score by the tie-breaker. */
  byTiebreak?: boolean;
}

export interface Standings {
  /** "After round 2", "Final scores". */
  label: string;
  rows: StandingRow[];
}

export interface TeamSummary {
  id: string;
  name: string;
  /** Phones mode: the team's phone is connected right now. */
  connected: boolean;
  /** Phones mode: the team joined from a phone (paper teams are added by the coordinator). */
  hasPhone: boolean;
}

export interface TimerView {
  /** Answers are being taken right now. */
  open: boolean;
  /** Server time (ms) the answers close at, while running. */
  closesAt?: number;
  /** While paused: ms left. */
  remainingMs?: number;
  totalMs: number;
}

export interface PlanOutline {
  rounds: { title: string; count: number }[];
  hasFinal: boolean;
  hasTiebreak: boolean;
}

// -------------------------------------------------- the host's extra view

export interface HostQuestion extends Question {
  qid: string;
  round: number;
  number: number;
  asked: boolean;
  revealed: boolean;
}

export interface HostAnswer {
  text: string;
  verdict: Verdict;
  at: number;
}

export interface HostRound {
  title: string;
  questions: HostQuestion[];
}

export interface HostData {
  rounds: HostRound[];
  final: HostQuestion | null;
  tiebreak: HostQuestion | null;
  /** answers[qid][teamId]: what a team's phone sent. */
  answers: Record<string, Record<string, HostAnswer>>;
  /** marks[qid][teamId]: the final say (auto-marked in phones mode; the host can change it). */
  marks: Record<string, Record<string, boolean>>;
  /** overrides[teamId][round]: a typed round total (paper), replacing the marks' sum. */
  overrides: Record<string, Record<number, number>>;
  /** Final-round wagers by team. */
  wagers: Record<string, number>;
  /** Live scores (not yet on the TV): per team, per round, plus final and total. */
  scores: Record<string, { rounds: number[]; final: number; total: number }>;
  /** Live standings, as they'd go up now. */
  live: StandingRow[];
  spec: NightSpec;
  cohosts: { memberId: string; name: string; connected: boolean }[];
  /** The next step in the usual running order, for the big "Next" button. */
  next: NextStep | null;
  tableCount: number;
}

export type NextAction =
  | { action: "start" }
  | { action: "intro"; round: number }
  | { action: "ask"; qid: string }
  | { action: "close" }
  | { action: "reveal"; qid: string }
  | { action: "revealRound"; round: number }
  | { action: "standings" }
  | { action: "wager" }
  | { action: "finish" };

export type NextStep = NextAction & { label: string };

// ------------------------------------------------------------------- views

export interface RoomView {
  code: string;
  title?: string;
  settings: RoomSettings;
  you: { role: Role; memberId: string; name: string; teamId?: string };
  screen: Screen;
  started: boolean;
  finished: boolean;
  paused: boolean;
  plan: PlanOutline;
  /** The question on the TV (or last shown), as the public may see it. */
  question: PublicQuestion | null;
  timer: TimerView | null;
  /** Phones mode: teams that answered the open question. */
  answered: number;
  teams: TeamSummary[];
  /** The scores last sent to the TV (null before the first). */
  standings: Standings | null;
  /** Round answers screen: every question and answer of that round. */
  roundAnswers: { round: number; title: string; items: { number: number; text: string; answer: string }[] } | null;
  /** The answer screen: how many teams got it (phones mode, or marked on paper). */
  answerStats: { correct: number; of: number } | null;
  /** The final's category, while wagers are taken. */
  wager: { open: boolean; category: string; teamsIn: number } | null;
  /** A team's own phone. */
  mine?: {
    answer?: { qid: string; text: string; verdict?: Verdict; correct?: boolean };
    wager?: number;
    /** Published score (what the TV shows). */
    score?: number;
    place?: number;
    maxWager?: number;
  };
  host?: HostData;
  serverTime: number;
}

// -------------------------------------------------------------- admin

export interface AdminSettings {
  roomIdleMinutes: number;
  defaultMode: Mode;
  defaultRevealMode: RevealMode;
  defaultTimerSeconds: number;
}

export const ADMIN_SETTINGS_LIMITS = {
  roomIdleMinutes: { min: 5, max: 7 * 24 * 60 },
} as const;

export interface AdminRoomSummary {
  code: string;
  kind: string;
  mode: Mode;
  teams: number;
  stage: string;
  hostConnected: boolean;
  createdAt: number;
  lastActivityAt: number;
}

export interface KnownTeam {
  name: string;
  nights: number;
  firstSeen: number;
  lastSeen: number;
}

export interface PublicConfig {
  gameName: string;
  defaults: { mode: Mode; revealMode: RevealMode; timerSeconds: number };
  packs: PackSummary[];
}

// -------------------------------------------------------------- socket

type Ack<T = object> = (res: ({ ok: true } & T) | { ok: false; error: string }) => void;

export interface JoinResult {
  code: string;
  token: string;
  memberId: string;
  role: Role;
  name: string;
}

export interface ClientToServerEvents {
  createRoom: (req: { name?: string; settings?: Partial<RoomSettings>; spec?: NightSpec; title?: string }, ack: Ack<JoinResult>) => void;
  roomInfo: (req: { code: string }, ack: Ack<{ mode: Mode; started: boolean }>) => void;
  joinRoom: (
    req: { code: string; role: "team" | "table"; name?: string; token?: string; cohost?: string },
    ack: Ack<JoinResult>,
  ) => void;
  resume: (req: { code: string; token: string }, ack: Ack<JoinResult>) => void;
  leaveRoom: (ack: Ack) => void;
  closeRoom: (ack: Ack) => void;

  // host and co-hosts: running the night
  updateSettings: (patch: Partial<RoomSettings>, ack: Ack) => void;
  setSpec: (spec: NightSpec, ack: Ack) => void;
  start: (ack: Ack) => void;
  intro: (round: number, ack: Ack) => void;
  ask: (qid: string, ack: Ack) => void;
  close: (ack: Ack) => void;
  reveal: (qid: string, ack: Ack) => void;
  revealRound: (round: number, ack: Ack) => void;
  standings: (ack: Ack) => void;
  wager: (ack: Ack) => void;
  finish: (ack: Ack) => void;
  showLobby: (ack: Ack) => void;
  setPaused: (paused: boolean, ack: Ack) => void;
  next: (ack: Ack) => void;
  mark: (req: { qid: string; teamId: string; correct: boolean }, ack: Ack) => void;
  setOverride: (req: { teamId: string; round: number; score: number | null }, ack: Ack) => void;
  setWagerFor: (req: { teamId: string; wager: number }, ack: Ack) => void;
  setAnswerFor: (req: { teamId: string; qid: string; text: string }, ack: Ack) => void;
  addTeam: (name: string, ack: Ack<{ teamId: string; name: string }>) => void;
  renameTeam: (req: { teamId: string; name: string }, ack: Ack) => void;
  // host only
  removeTeam: (teamId: string, ack: Ack) => void;
  cohostInvite: (ack: Ack<{ path: string; expiresAt: string }>) => void;
  removeCohost: (memberId: string, ack: Ack) => void;

  // a team's phone
  answer: (req: { qid: string; text: string }, ack: Ack) => void;
  submitWager: (wager: number, ack: Ack) => void;
}

export interface ServerToClientEvents {
  state: (view: RoomView) => void;
  closed: (p: { reason: string }) => void;
  notice: (p: { message: string }) => void;
}

// ------------------------------------------------------------- errors

export const ERRORS = {
  BAD_REQUEST: "That request wasn't valid.",
  ROOM_NOT_FOUND: "There's no room with that code. Check it and try again.",
  ROOM_FULL: "This room is full.",
  NOT_IN_ROOM: "You're not in a room. Rejoin with the room code.",
  BAD_TOKEN: "That seat isn't in this room any more. Join again.",
  NAME_REQUIRED: "Enter your team's name.",
  NAME_TAKEN: "A team with that name is already playing here (on another phone).",
  NOT_HOST: "Only the host can do that.",
  NOT_RUNNER: "Only the host or a co-host can do that.",
  PAPER_ROOM: "This trivia night is played on paper answer cards: no phones needed. Ask the host for a card.",
  NOT_STARTED: "The night hasn't started yet.",
  ALREADY_STARTED: "The night has already started.",
  FINISHED: "This trivia night is over.",
  NO_QUESTION: "There's no question by that number tonight.",
  ANSWERS_CLOSED: "Answers are closed for that question.",
  NO_TIMER: "There's no timer running to pause.",
  NOT_PAUSED: "The night isn't paused.",
  NO_FINAL: "Tonight has no final round.",
  WAGERS_CLOSED: "Wagers are closed.",
  BAD_WAGER: "Wager between 0 and your score.",
  NO_TEAM: "There's no team by that name in this room.",
  NO_ROUNDS: "Add at least one round with questions.",
  BAD_SPEC: "That night setup couldn't be used.",
  NO_NEXT: "There's nothing more to do: finish the night or close the room.",
  BAD_INVITE: "That co-host invite has been used or has expired. Ask the host for a new one.",
  RATE_LIMITED: "Too many attempts. Wait a minute and try again.",
  LAST_ROUND: "This is the last round.",
} as const;
