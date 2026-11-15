// One trivia night: the teams, tonight's questions, what the TV shows, answers, marks and
// scores. Server-authoritative: phones and screens send intents, the room decides, and every
// member gets a view cut for its role (teams and TVs never see an answer before it's revealed).
import {
  checkAnswer,
  cleanTeamName,
  FINAL_ID,
  LIMITS,
  parseNumber,
  SETTINGS_LIMITS,
  teamKey,
  TIEBREAK_ID,
  type HostAnswer,
  type HostData,
  type HostQuestion,
  type NextStep,
  type NightSpec,
  type PlanOutline,
  type PublicQuestion,
  type Role,
  type RoomSettings,
  type RoomView,
  type Screen,
  type StandingRow,
  type Standings,
  type TeamSummary,
} from "@trivia/shared";
import {
  HostSeats,
  log,
  newId,
  newToken,
  safeTimeout,
  type CloseCause,
  type KitRoom,
  type RoomOverview,
  type SessionKind,
} from "@bargames/gamekit/server";
import { bg } from "../bargames.js";
import { canonicalTeamName, recordNight } from "../content/teams.js";
import { MAX_TABLES_PER_ROOM, MAX_TEAMS_PER_ROOM } from "../config.js";
import { GameError } from "./errors.js";
import type { Night, RoomQuestion } from "./plan.js";

export interface Member {
  id: string;
  token: string;
  role: Role;
  name: string;
  socketIds: Set<string>;
  /** A team's phone: its team. */
  teamId?: string;
}

export interface Team {
  id: string;
  name: string;
  /** Phones mode: the member (phone) answering for it. */
  memberId?: string;
  createdAt: number;
}

/** How the room talks to sockets, injected so Room has no socket.io dependency. */
export interface RoomTransport {
  sendState(socketId: string, view: RoomView): void;
  sendClosed(socketId: string, reason: string): void;
  sendNotice(socketId: string, message: string): void;
}

/** The links the host key and co-host invites go in (the box's host_link / cohost_link too). */
export const hostPath = (room: { code: string }, token: string) => `/join/${room.code}?host=${encodeURIComponent(token)}`;
export const cohostPath = (room: { code: string }, token: string) => `/join/${room.code}?cohost=${encodeURIComponent(token)}`;

export const TAKEOVER_NOTICE = "Staff took over hosting. You're a co-host now: you can still run the night.";
export const COHOST_REMOVED_NOTICE = "You're not a co-host any more.";
export const TEAM_REMOVED_REASON = "The host removed your team from this trivia night.";
export const TEAM_MOVED_REASON = "Your team is answering from another phone now.";

const roundLabel = (r: number, title: string) => (r === -1 ? "Final" : r === -2 ? "Tie-breaker" : `Round ${r + 1}: ${title}`);

export class Room implements KitRoom {
  readonly members = new Map<string, Member>();
  readonly teams = new Map<string, Team>();
  hostId = "";
  settings: RoomSettings;
  spec: NightSpec;
  night: Night;
  screen: Screen = { kind: "lobby" };
  started = false;
  finished = false;
  paused = false;

  /** Questions shown on the TV at least once, and those whose answer went up. */
  readonly asked = new Set<string>();
  readonly revealed = new Set<string>();
  /** Questions whose answering has closed (phones mode). */
  readonly closedQs = new Set<string>();
  readonly introduced = new Set<number>();
  readonly roundsEnded = new Set<number>();
  /** The question on the TV or last shown, and the round last introduced. */
  lastQid: string | null = null;
  currentRound = -1;

  /** Phones mode: the question taking answers, and its timer. */
  openQid: string | null = null;
  closesAt: number | null = null;
  remainingMs: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  readonly answers = new Map<string, Map<string, HostAnswer>>();
  readonly marks = new Map<string, Map<string, boolean>>();
  /** "qid:teamId" marks the host or a co-host set by hand (a phone's new answer won't undo them). */
  private readonly manual = new Set<string>();
  readonly overrides = new Map<string, Map<number, number>>();
  readonly wagers = new Map<string, number>();
  wagerOpen = false;
  published: Standings | null = null;
  private reported = false;

  lastActivityAt = Date.now();
  readonly createdAt = Date.now();
  closed = false;
  kind: SessionKind;
  title?: string;
  /** Who may host (the kit's HostSeats): the host key, first-joiner offer, take-overs, co-host invites. */
  seats = new HostSeats();

  onFatalError: (err: unknown) => void = () => {};
  onPlayersChanged: () => void = () => {};

  constructor(
    readonly code: string,
    private readonly transport: RoomTransport,
    kind: SessionKind = "patron",
    settings: RoomSettings,
    spec: NightSpec,
    night: Night,
  ) {
    this.kind = kind;
    this.settings = settings;
    this.spec = spec;
    this.night = night;
  }

  // ------------------------------------------------------------- members

  addHost(name: string): Member {
    const m = this.newMember("host", name || "Host");
    this.hostId = m.id;
    return m;
  }

  /** "First joiner hosts" (a box room on a TV): the first phone in takes the host seat. */
  claimHostSeat(rawName: string | undefined): Member {
    const host = this.members.get(this.hostId);
    if (!host || this.seats.claimForJoiner() !== "host") throw new GameError("BAD_REQUEST");
    host.name = cleanTeamName(rawName) || "Host";
    return host;
  }

  /** A member's own token, or the host link's key (the host seat). */
  seatFor(token: unknown): Member | undefined {
    if (typeof token !== "string" || !token) return undefined;
    return this.findByToken(token) ?? (this.seats.isHostToken(token) ? this.members.get(this.hostId) : undefined);
  }

  noteAttached(member: Member): void {
    if (member.role === "host") this.seats.hostAttached(member.id);
  }

  cohosts(): Member[] {
    return [...this.members.values()].filter((m) => m.role === "cohost");
  }

  /** A co-host invite redeemed: a new co-host, or this phone (a team's) promoted. */
  seatCohost(existing: Member | undefined, rawName: string | undefined): Member {
    if (existing && existing.role !== "team") return existing;
    let m = existing;
    if (m) {
      // A team's phone becomes a co-host; its team stays in the night with no phone.
      const team = m.teamId ? this.teams.get(m.teamId) : undefined;
      if (team) team.memberId = undefined;
      m.teamId = undefined;
      m.role = "cohost";
    } else {
      const name = cleanTeamName(rawName);
      if (!name) throw new GameError("NAME_REQUIRED");
      if (this.cohosts().length >= 20) throw new GameError("ROOM_FULL");
      m = this.newMember("cohost", name);
    }
    this.seats.addCohost(m.id);
    return m;
  }

  /** Staff took over (host_link): the previous host's phone stays on as a co-host. */
  takeOver(previous: string | undefined): void {
    const old = previous ? this.members.get(previous) : undefined;
    if (!old || old.role !== "host") return;
    old.role = "cohost";
    this.hostId = this.newMember("host", "Venue").id;
    this.notify(old, TAKEOVER_NOTICE);
  }

  /** remove_cohost: they're off the staff. A co-host has no team, so the phone just watches. */
  demoteCohost(memberId: string): void {
    const m = this.members.get(memberId);
    this.seats.removeCohost(memberId);
    if (!m || m.role !== "cohost") return;
    this.notify(m, COHOST_REMOVED_NOTICE);
    for (const sid of m.socketIds) this.transport.sendClosed(sid, COHOST_REMOVED_NOTICE);
    this.members.delete(m.id);
  }

  private notify(m: Member, message: string): void {
    for (const sid of m.socketIds) this.transport.sendNotice(sid, message);
  }

  private newMember(role: Role, name: string): Member {
    const m: Member = { id: newId(), token: newToken(), role, name, socketIds: new Set() };
    this.members.set(m.id, m);
    return m;
  }

  findByToken(token: string): Member | undefined {
    for (const m of this.members.values()) if (m.token === token) return m;
    return undefined;
  }

  attachSocket(member: Member, socketId: string): void {
    member.socketIds.add(socketId);
  }

  detachSocket(memberId: string, socketId: string): void {
    this.members.get(memberId)?.socketIds.delete(socketId);
  }

  addTable(): Member {
    const tables = [...this.members.values()].filter((m) => m.role === "table").length;
    if (tables >= MAX_TABLES_PER_ROOM) throw new GameError("ROOM_FULL");
    return this.newMember("table", "TV");
  }

  private findTeamByName(name: string): Team | undefined {
    const k = teamKey(name);
    return [...this.teams.values()].find((t) => teamKey(t.name) === k);
  }

  /**
   * Phones mode: a team joins from a phone. A name matching a team already here (ignoring case
   * and spacing) whose phone is offline moves the team to this phone (a dead battery, a new
   * phone); one whose phone is online is refused.
   */
  joinAsTeam(rawName: string | undefined): Member {
    if (this.settings.mode === "paper") throw new GameError("PAPER_ROOM");
    const name = canonicalTeamName(rawName);
    if (!name) throw new GameError("NAME_REQUIRED");
    const existing = this.findTeamByName(name);
    if (existing) {
      const phone = existing.memberId ? this.members.get(existing.memberId) : undefined;
      if (phone && phone.socketIds.size > 0) throw new GameError("NAME_TAKEN");
      if (phone) {
        for (const sid of phone.socketIds) this.transport.sendClosed(sid, TEAM_MOVED_REASON);
        this.members.delete(phone.id);
      }
      const m = this.newMember("team", existing.name);
      m.teamId = existing.id;
      existing.memberId = m.id;
      return m;
    }
    const team = this.createTeam(name);
    const m = this.newMember("team", team.name);
    m.teamId = team.id;
    team.memberId = m.id;
    return m;
  }

  private createTeam(name: string): Team {
    if (this.teams.size >= Math.min(MAX_TEAMS_PER_ROOM, LIMITS.teams)) throw new GameError("ROOM_FULL");
    const team: Team = { id: newId(), name, createdAt: Date.now() };
    this.teams.set(team.id, team);
    this.onPlayersChanged();
    return team;
  }

  /** The coordinator adds a team (paper cards, or a phones-mode team without a phone). */
  addTeam(rawName: unknown): Team {
    const name = canonicalTeamName(rawName);
    if (!name) throw new GameError("NAME_REQUIRED");
    if (this.findTeamByName(name)) throw new GameError("NAME_TAKEN");
    return this.createTeam(name);
  }

  renameTeam(teamId: string, rawName: unknown): void {
    const team = this.teams.get(teamId);
    if (!team) throw new GameError("NO_TEAM");
    const name = canonicalTeamName(rawName);
    if (!name) throw new GameError("NAME_REQUIRED");
    const other = this.findTeamByName(name);
    if (other && other !== team) throw new GameError("NAME_TAKEN");
    team.name = name;
    const phone = team.memberId ? this.members.get(team.memberId) : undefined;
    if (phone) phone.name = name;
  }

  removeTeam(teamId: string): void {
    const team = this.teams.get(teamId);
    if (!team) throw new GameError("NO_TEAM");
    const phone = team.memberId ? this.members.get(team.memberId) : undefined;
    if (phone) {
      for (const sid of phone.socketIds) this.transport.sendClosed(sid, TEAM_REMOVED_REASON);
      this.members.delete(phone.id);
    }
    this.teams.delete(teamId);
    for (const m of [this.answers, this.marks]) for (const byTeam of m.values()) byTeam.delete(teamId);
    this.overrides.delete(teamId);
    this.wagers.delete(teamId);
    this.onPlayersChanged();
  }

  /** A team's phone leaves (or is replaced): the team stays in the night, phone-less. */
  removeMember(memberId: string): void {
    const m = this.members.get(memberId);
    if (!m) return;
    if (m.teamId) {
      const team = this.teams.get(m.teamId);
      if (team?.memberId === m.id) team.memberId = undefined;
    }
    this.seats.removeCohost(memberId);
    this.members.delete(memberId);
  }

  // --------------------------------------------------------- permissions

  requireHost(memberId: string): void {
    if (memberId !== this.hostId) throw new GameError("NOT_HOST");
  }

  requireRunner(memberId: string): void {
    const m = this.members.get(memberId);
    if (!m || (m.role !== "host" && m.role !== "cohost")) throw new GameError("NOT_RUNNER");
  }

  private requirePlaying(): void {
    if (!this.started) throw new GameError("NOT_STARTED");
    if (this.finished) throw new GameError("FINISHED");
  }

  // ------------------------------------------------------------- questions

  allQuestions(): RoomQuestion[] {
    const qs = this.night.rounds.flatMap((r) => r.questions);
    if (this.night.final) qs.push(this.night.final);
    if (this.night.tiebreak) qs.push(this.night.tiebreak);
    return qs;
  }

  findQ(qid: string): RoomQuestion | undefined {
    if (qid === FINAL_ID) return this.night.final ?? undefined;
    if (qid === TIEBREAK_ID) return this.night.tiebreak ?? undefined;
    const m = /^r(\d+)q(\d+)$/.exec(String(qid));
    if (!m) return undefined;
    return this.night.rounds[Number(m[1]) - 1]?.questions[Number(m[2]) - 1];
  }

  private requireQ(qid: unknown): RoomQuestion {
    const q = this.findQ(String(qid ?? ""));
    if (!q) throw new GameError("NO_QUESTION");
    return q;
  }

  private titleOf(q: RoomQuestion): string {
    return q.round >= 0 ? this.night.rounds[q.round].title : q.round === -1 ? "Final" : "Tie-breaker";
  }

  // ------------------------------------------------------------- settings

  updateSettings(patch: Partial<RoomSettings>): void {
    if (patch.mode !== undefined) {
      if (patch.mode !== "phones" && patch.mode !== "paper") throw new GameError("BAD_REQUEST");
      if (patch.mode !== this.settings.mode) {
        if (this.started) throw new GameError("ALREADY_STARTED");
        this.settings.mode = patch.mode;
        // To paper: teams' phones are no longer needed; their teams stay.
        if (patch.mode === "paper") {
          for (const m of [...this.members.values()]) {
            if (m.role !== "team") continue;
            for (const sid of m.socketIds) this.transport.sendClosed(sid, "The host switched this trivia night to paper answer cards.");
            this.removeMember(m.id);
          }
        }
      }
    }
    if (patch.revealMode !== undefined) {
      if (patch.revealMode !== "each" && patch.revealMode !== "round") throw new GameError("BAD_REQUEST");
      this.settings.revealMode = patch.revealMode;
    }
    if (patch.timerSeconds !== undefined) {
      const n = Math.round(Number(patch.timerSeconds));
      const { min, max } = SETTINGS_LIMITS.timerSeconds;
      if (!Number.isFinite(n) || n < min || n > max) throw new GameError("BAD_REQUEST");
      this.settings.timerSeconds = n;
    }
    this.touch();
  }

  /** A new night setup, in the lobby only. */
  setNight(spec: NightSpec, night: Night): void {
    if (this.started) throw new GameError("ALREADY_STARTED");
    this.spec = spec;
    this.night = night;
    this.touch();
  }

  // ------------------------------------------------------------- the flow

  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  private emit(type: string, data: Record<string, unknown>): void {
    bg.emit({ type: type as Parameters<typeof bg.emit>[0]["type"], roomCode: this.code, sessionKind: this.kind, data });
  }

  start(): void {
    if (this.started) throw new GameError("ALREADY_STARTED");
    if (!this.night.rounds.length) throw new GameError("NO_ROUNDS");
    this.started = true;
    log.info("room", "night started", { code: this.code, mode: this.settings.mode, rounds: this.night.rounds.length });
    this.intro(0);
  }

  intro(round: number): void {
    this.requirePlaying();
    const r = this.night.rounds[Number(round)];
    if (!r) throw new GameError("NO_QUESTION");
    this.closeAnswers();
    this.wagerOpen = false;
    this.screen = { kind: "intro", round: Number(round) };
    this.currentRound = Number(round);
    if (!this.introduced.has(this.currentRound)) {
      this.introduced.add(this.currentRound);
      this.emit("round_started", { round: this.currentRound + 1, title: r.title, questions: r.questions.length, mode: this.settings.mode });
    }
    this.touch();
  }

  /** Puts a question on the TV. Phones mode: opens answering with the timer, the first time. */
  ask(qid: unknown): void {
    this.requirePlaying();
    const q = this.requireQ(qid);
    if (this.openQid && this.openQid !== q.qid) this.closeAnswers();
    if (q.round >= 0) this.currentRound = q.round;
    if (q.qid === FINAL_ID) this.wagerOpen = false;
    this.screen = { kind: "question", qid: q.qid };
    this.lastQid = q.qid;
    if (!this.asked.has(q.qid)) {
      this.asked.add(q.qid);
      this.emit("x-trivia-question", { round: q.round >= 0 ? q.round + 1 : q.round === -1 ? "final" : "tiebreaker", number: q.number, category: q.category });
    }
    if (this.settings.mode === "phones" && !this.closedQs.has(q.qid) && !this.revealed.has(q.qid) && this.openQid !== q.qid) {
      this.openQid = q.qid;
      const ms = this.settings.timerSeconds * 1000;
      if (this.paused) {
        this.remainingMs = ms;
        this.closesAt = null;
      } else {
        this.closesAt = Date.now() + ms;
        this.remainingMs = null;
        this.armTimer(ms);
      }
    }
    this.touch();
  }

  private armTimer(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = safeTimeout(
      "answer timer",
      ms,
      () => {
        this.timer = null;
        this.closeAnswers();
        this.broadcast();
      },
      (err) => this.onFatalError(err),
    );
  }

  /** Stops taking answers for the open question (the timer ran out, or the host closed it). */
  closeAnswers(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.openQid) this.closedQs.add(this.openQid);
    this.openQid = null;
    this.closesAt = null;
    this.remainingMs = null;
  }

  closeNow(): void {
    this.requirePlaying();
    this.closeAnswers();
    this.touch();
  }

  reveal(qid: unknown): void {
    this.requirePlaying();
    const q = this.requireQ(qid);
    if (this.openQid === q.qid) this.closeAnswers();
    this.closedQs.add(q.qid);
    this.asked.add(q.qid);
    this.screen = { kind: "answer", qid: q.qid };
    this.lastQid = q.qid;
    if (!this.revealed.has(q.qid)) {
      this.revealed.add(q.qid);
      this.emit("x-trivia-answer-revealed", {
        round: q.round >= 0 ? q.round + 1 : q.round === -1 ? "final" : "tiebreaker",
        number: q.number,
        answer: q.answer,
        correct: this.correctCount(q.qid),
        teams: this.teams.size,
      });
    }
    this.touch();
  }

  /** Every answer of a round at once (the round's questions that have been asked). */
  revealRound(round: unknown): void {
    this.requirePlaying();
    const r = Number(round);
    const rd = this.night.rounds[r];
    if (!rd) throw new GameError("NO_QUESTION");
    if (this.openQid && this.findQ(this.openQid)?.round === r) this.closeAnswers();
    const fresh: number[] = [];
    for (const q of rd.questions) {
      if (!this.asked.has(q.qid)) continue;
      this.closedQs.add(q.qid);
      if (!this.revealed.has(q.qid)) {
        this.revealed.add(q.qid);
        fresh.push(q.number);
      }
    }
    this.screen = { kind: "roundAnswers", round: r };
    this.currentRound = r;
    if (fresh.length) this.emit("x-trivia-round-answers", { round: r + 1, questions: fresh.length });
    this.touch();
  }

  /** Sends the current scores to the TV. */
  showStandings(): void {
    this.requirePlaying();
    this.closeAnswers();
    this.wagerOpen = false;
    this.published = { label: this.standingsLabel(), rows: this.ranking() };
    this.screen = { kind: "standings" };
    this.emit("x-trivia-standings", {
      label: this.published.label,
      top: this.published.rows.slice(0, 3).map((r) => ({ name: r.name, score: r.score, place: r.place })),
    });
    // A round whose every question has been asked ends when its scores go up.
    const r = this.currentRound;
    const rd = this.night.rounds[r];
    if (rd && !this.roundsEnded.has(r) && rd.questions.every((q) => this.asked.has(q.qid))) {
      this.roundsEnded.add(r);
      const leader = this.published.rows[0];
      this.emit("round_ended", { round: r + 1, title: rd.title, leader: leader ? { name: leader.name, score: leader.score } : undefined });
    }
    this.touch();
  }

  private standingsLabel(): string {
    if (this.finished) return "Final scores";
    if (this.revealed.has(FINAL_ID)) return "After the final";
    const done = this.night.rounds.map((rd, i) => (rd.questions.every((q) => this.asked.has(q.qid)) ? i : -1)).filter((i) => i >= 0);
    const r = this.currentRound;
    if (r >= 0 && done.includes(r)) return `After round ${r + 1}`;
    if (r >= 0) return `During round ${r + 1}`;
    return "Scores";
  }

  /** The final: shows its category and takes wagers. */
  openWagers(): void {
    this.requirePlaying();
    if (!this.night.final) throw new GameError("NO_FINAL");
    if (this.asked.has(FINAL_ID)) throw new GameError("WAGERS_CLOSED");
    this.closeAnswers();
    this.screen = { kind: "wager" };
    this.wagerOpen = true;
    this.touch();
  }

  /** The most a team may wager: its score before the final (never below 0). */
  maxWager(teamId: string): number {
    return Math.max(0, this.scoreOf(teamId, false).total);
  }

  private setWager(teamId: string, raw: unknown): void {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > this.maxWager(teamId) || Math.round(n * 100) !== n * 100) throw new GameError("BAD_WAGER");
    this.wagers.set(teamId, n);
  }

  submitWager(member: Member, raw: unknown): void {
    if (!member.teamId) throw new GameError("BAD_REQUEST");
    if (!this.wagerOpen) throw new GameError("WAGERS_CLOSED");
    this.setWager(member.teamId, raw);
    this.touch();
  }

  setWagerFor(teamId: string, raw: unknown): void {
    this.requirePlaying();
    if (!this.night.final) throw new GameError("NO_FINAL");
    if (!this.teams.has(teamId)) throw new GameError("NO_TEAM");
    if (this.revealed.has(FINAL_ID)) throw new GameError("WAGERS_CLOSED");
    this.setWager(teamId, raw);
    this.touch();
  }

  setPaused(paused: boolean): void {
    this.requirePlaying();
    if (paused) {
      if (this.paused) throw new GameError("BAD_REQUEST");
      this.paused = true;
      if (this.openQid && this.closesAt !== null) {
        this.remainingMs = Math.max(0, this.closesAt - Date.now());
        this.closesAt = null;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
      }
    } else {
      if (!this.paused) throw new GameError("NOT_PAUSED");
      this.paused = false;
      if (this.openQid && this.remainingMs !== null) {
        this.closesAt = Date.now() + this.remainingMs;
        this.armTimer(this.remainingMs);
        this.remainingMs = null;
      }
    }
    this.touch();
  }

  showLobby(): void {
    this.closeAnswers();
    this.screen = { kind: "lobby" };
    this.touch();
  }

  /** The box's next_round: on to the next round (or, after the last, the final's wagers). */
  nextRound(): void {
    this.requirePlaying();
    const next = this.currentRound + 1;
    if (this.night.rounds[next]) return this.intro(next);
    if (this.night.final && !this.asked.has(FINAL_ID) && !this.wagerOpen) return this.openWagers();
    throw new GameError("LAST_ROUND");
  }

  /** Ends the night: final scores on the TV, results to the venue's leaderboard. */
  finish(): void {
    this.requirePlaying();
    this.closeAnswers();
    this.wagerOpen = false;
    this.finished = true;
    this.paused = false;
    this.published = { label: "Final scores", rows: this.ranking() };
    this.screen = { kind: "over" };
    this.touch();
    this.reportResults();
  }

  /**
   * Teams as players, under their own names (stable week to week: the venue's saved spelling),
   * for the box's leaderboards and Tournament & Leaderboard's seasons.
   */
  private reportResults(): void {
    if (this.reported || !this.published) return;
    this.reported = true;
    const rows = this.published.rows;
    if (!rows.length) return;
    const winners = rows.filter((r) => r.place === 1);
    void bg
      .reportResults({
        roomCode: this.code,
        results: rows.map((r) => ({ player: { name: r.name }, place: r.place, score: r.score })),
      })
      .catch(() => undefined);
    this.emit("winner", {
      name: winners.map((w) => w.name).join(" & "),
      teams: winners.map((w) => w.name),
      score: winners[0].score,
    });
    this.emit("game_over", { winners: winners.map((w) => w.name), teams: rows.length });
    recordNight(rows.map((r) => r.name)).catch((err) => log.warn("teams", "couldn't save the night's teams", { err: String(err) }));
    log.info("room", "night finished", { code: this.code, teams: rows.length, winner: winners.map((w) => w.name).join(" & ") });
  }

  /** The big "Next" button: the usual next step from where the night is. */
  suggestNext(): NextStep | null {
    if (!this.started) return { action: "start", label: "Start the night" };
    if (this.finished) return null;
    if (this.openQid) return { action: "close", label: "Close answers" };
    const s = this.screen;
    const rounds = this.night.rounds;
    const firstUnasked = (r: number) => rounds[r]?.questions.find((q) => !this.asked.has(q.qid));
    const askLabel = (q: RoomQuestion) => `Question ${q.number}`;
    const afterRound = (): NextStep => {
      const r = this.currentRound;
      const left = firstUnasked(r);
      if (left) return { action: "ask", qid: left.qid, label: askLabel(left) };
      if (rounds[r + 1]) return { action: "intro", round: r + 1, label: `Round ${r + 2}: ${rounds[r + 1].title}` };
      if (this.night.final && !this.asked.has(FINAL_ID)) return { action: "wager", label: "Final: take wagers" };
      if (this.night.tiebreak && !this.asked.has(TIEBREAK_ID) && this.tieAtTop()) return { action: "ask", qid: TIEBREAK_ID, label: "Tie-breaker" };
      return { action: "finish", label: "Finish the night" };
    };
    switch (s.kind) {
      case "lobby":
      case "intro": {
        const r = s.kind === "intro" ? s.round : Math.max(0, this.currentRound);
        if (s.kind === "lobby" && this.currentRound < 0) return { action: "intro", round: 0, label: `Round 1: ${rounds[0].title}` };
        const q = firstUnasked(r);
        return q ? { action: "ask", qid: q.qid, label: askLabel(q) } : afterRound();
      }
      case "wager":
        return { action: "ask", qid: FINAL_ID, label: "Final question" };
      case "question":
      case "answer": {
        const q = this.findQ(s.qid);
        if (!q) return afterRound();
        if (s.kind === "question" && (q.round < 0 || this.settings.revealMode === "each") && !this.revealed.has(q.qid)) {
          return { action: "reveal", qid: q.qid, label: "Show the answer" };
        }
        if (q.qid === FINAL_ID) return { action: "standings", label: "Show the scores" };
        if (q.qid === TIEBREAK_ID) return { action: "finish", label: "Finish the night" };
        const next = rounds[q.round].questions[q.number];
        if (next) return { action: "ask", qid: next.qid, label: askLabel(next) };
        if (this.settings.revealMode === "round" && rounds[q.round].questions.some((x) => !this.revealed.has(x.qid))) {
          return { action: "revealRound", round: q.round, label: `Show round ${q.round + 1} answers` };
        }
        return { action: "standings", label: "Show the scores" };
      }
      case "roundAnswers":
        return { action: "standings", label: "Show the scores" };
      case "standings":
        if (this.revealed.has(FINAL_ID) || (this.night.final === null && this.currentRound === rounds.length - 1 && !firstUnasked(this.currentRound))) {
          if (this.night.tiebreak && !this.asked.has(TIEBREAK_ID) && this.tieAtTop()) return { action: "ask", qid: TIEBREAK_ID, label: "Tie-breaker" };
          return { action: "finish", label: "Finish the night" };
        }
        return afterRound();
      case "over":
        return null;
    }
  }

  /** Runs the suggested next step. */
  next(): void {
    const step = this.suggestNext();
    if (!step) throw new GameError("NO_NEXT");
    switch (step.action) {
      case "start":
        return this.start();
      case "intro":
        return this.intro(step.round);
      case "ask":
        return this.ask(step.qid);
      case "close":
        return this.closeNow();
      case "reveal":
        return this.reveal(step.qid);
      case "revealRound":
        return this.revealRound(step.round);
      case "standings":
        return this.showStandings();
      case "wager":
        return this.openWagers();
      case "finish":
        return this.finish();
    }
  }

  // ------------------------------------------------------------- answers

  /** A team's phone answers the open question (it may change its answer until answers close). */
  answer(member: Member, qid: unknown, rawText: unknown): void {
    if (!member.teamId) throw new GameError("BAD_REQUEST");
    if (!this.openQid || this.openQid !== qid) throw new GameError("ANSWERS_CLOSED");
    const q = this.requireQ(qid);
    const text = String(rawText ?? "").replace(/\s+/g, " ").trim().slice(0, LIMITS.answer);
    if (!text) throw new GameError("BAD_REQUEST");
    if (q.type === "number" && parseNumber(text) === undefined) throw new GameError("BAD_REQUEST");
    this.recordAnswer(member.teamId, q, text);
    this.touch();
  }

  private recordAnswer(teamId: string, q: RoomQuestion, text: string): void {
    const verdict = checkAnswer(q, text);
    let byTeam = this.answers.get(q.qid);
    if (!byTeam) this.answers.set(q.qid, (byTeam = new Map()));
    byTeam.set(teamId, { text, verdict, at: Date.now() });
    if (!this.manual.has(`${q.qid}:${teamId}`)) this.setMark(q.qid, teamId, verdict === "correct");
  }

  /** The coordinator types a team's answer (paper: the tie-breaker's number, say). */
  setAnswerFor(teamId: string, qid: unknown, rawText: unknown): void {
    this.requirePlaying();
    if (!this.teams.has(teamId)) throw new GameError("NO_TEAM");
    const q = this.requireQ(qid);
    const text = String(rawText ?? "").replace(/\s+/g, " ").trim().slice(0, LIMITS.answer);
    if (!text) {
      this.answers.get(q.qid)?.delete(teamId);
      return;
    }
    if (q.type === "number" && parseNumber(text) === undefined) throw new GameError("BAD_REQUEST");
    this.recordAnswer(teamId, q, text);
    this.touch();
  }

  private setMark(qid: string, teamId: string, correct: boolean): void {
    let byTeam = this.marks.get(qid);
    if (!byTeam) this.marks.set(qid, (byTeam = new Map()));
    byTeam.set(teamId, correct);
  }

  /** The host or a co-host marks a team right or wrong (accepting a near-miss, or a paper card). */
  mark(qid: unknown, teamId: string, correct: boolean): void {
    if (!this.started) throw new GameError("NOT_STARTED");
    const q = this.requireQ(qid);
    if (!this.teams.has(teamId)) throw new GameError("NO_TEAM");
    this.setMark(q.qid, teamId, correct === true);
    this.manual.add(`${q.qid}:${teamId}`);
    this.touch();
  }

  /** Paper: a typed round total for a team, replacing the per-question marks (null clears it). */
  setOverride(teamId: string, round: unknown, score: unknown): void {
    if (!this.started) throw new GameError("NOT_STARTED");
    if (!this.teams.has(teamId)) throw new GameError("NO_TEAM");
    const r = Number(round);
    if (!this.night.rounds[r]) throw new GameError("NO_QUESTION");
    let byRound = this.overrides.get(teamId);
    if (score === null || score === undefined || score === "") {
      byRound?.delete(r);
      return;
    }
    const n = Number(score);
    if (!Number.isFinite(n) || n < -1000 || n > 10000) throw new GameError("BAD_REQUEST");
    if (!byRound) this.overrides.set(teamId, (byRound = new Map()));
    byRound.set(r, Math.round(n * 100) / 100);
    this.touch();
  }

  private correctCount(qid: string): number {
    let n = 0;
    for (const [teamId, ok] of this.marks.get(qid) ?? []) if (ok && this.teams.has(teamId)) n++;
    return n;
  }

  // ------------------------------------------------------------- scores

  /** A team's live score. withFinal false: before the final (the wager cap). */
  scoreOf(teamId: string, withFinal = true): { rounds: number[]; final: number; total: number } {
    const rounds = this.night.rounds.map((rd, r) => {
      const o = this.overrides.get(teamId)?.get(r);
      if (o !== undefined) return o;
      let sum = 0;
      for (const q of rd.questions) if (this.marks.get(q.qid)?.get(teamId)) sum += q.points;
      return Math.round(sum * 100) / 100;
    });
    let final = 0;
    if (withFinal && this.night.final && this.revealed.has(FINAL_ID)) {
      const w = this.wagers.get(teamId) ?? 0;
      final = this.marks.get(FINAL_ID)?.get(teamId) ? w : -w;
    }
    const total = Math.round((rounds.reduce((a, b) => a + b, 0) + final) * 100) / 100;
    return { rounds, final, total };
  }

  /** How far a team's tie-breaker guess was (Infinity: none, or not revealed yet). */
  private tiebreakDistance(teamId: string): number {
    const q = this.night.tiebreak;
    if (!q || !this.revealed.has(TIEBREAK_ID)) return Infinity;
    const guess = parseNumber(this.answers.get(TIEBREAK_ID)?.get(teamId)?.text ?? "");
    const want = parseNumber(q.answer);
    return guess === undefined || want === undefined ? Infinity : Math.abs(guess - want);
  }

  /** Highest score first; on equal scores, the closest tie-breaker guess (once revealed). */
  ranking(): StandingRow[] {
    const rows = [...this.teams.values()].map((t) => ({
      teamId: t.id,
      name: t.name,
      score: this.scoreOf(t.id).total,
      dist: this.tiebreakDistance(t.id),
      created: t.createdAt,
    }));
    rows.sort((a, b) => b.score - a.score || a.dist - b.dist || a.created - b.created);
    const out: StandingRow[] = [];
    rows.forEach((r, i) => {
      const prev = rows[i - 1];
      const tiedScore = !!prev && prev.score === r.score;
      const place = tiedScore && prev.dist === r.dist ? out[i - 1].place : i + 1;
      const row: StandingRow = { teamId: r.teamId, name: r.name, score: r.score, place };
      if (tiedScore && prev.dist !== r.dist) {
        row.byTiebreak = true;
        out[i - 1].byTiebreak = true;
      }
      out.push(row);
    });
    return out;
  }

  tieAtTop(): boolean {
    const r = this.ranking();
    return r.length > 1 && r[0].place === 1 && r[1].place === 1;
  }

  // ------------------------------------------------------------- views

  private publicQuestion(q: RoomQuestion): PublicQuestion {
    return {
      qid: q.qid,
      round: q.round,
      number: q.number,
      roundTitle: this.titleOf(q),
      text: q.text,
      type: q.type,
      choices: q.choices,
      category: q.category,
      points: q.points,
      ...(q.image ? { image: q.image } : {}),
      ...(this.revealed.has(q.qid) ? { answer: q.answer } : {}),
    };
  }

  private hostQuestion(q: RoomQuestion): HostQuestion {
    return { ...q, asked: this.asked.has(q.qid), revealed: this.revealed.has(q.qid) };
  }

  plan(): PlanOutline {
    return {
      rounds: this.night.rounds.map((r) => ({ title: r.title, count: r.questions.length })),
      hasFinal: !!this.night.final,
      hasTiebreak: !!this.night.tiebreak,
    };
  }

  private teamList(): TeamSummary[] {
    return [...this.teams.values()].map((t) => {
      const phone = t.memberId ? this.members.get(t.memberId) : undefined;
      return { id: t.id, name: t.name, connected: (phone?.socketIds.size ?? 0) > 0, hasPhone: !!phone };
    });
  }

  private hostData(): HostData {
    const mapOf = <V>(m: Map<string, Map<string, V>>) =>
      Object.fromEntries([...m].map(([k, v]) => [k, Object.fromEntries(v)])) as Record<string, Record<string, V>>;
    const scores: HostData["scores"] = {};
    for (const t of this.teams.values()) scores[t.id] = this.scoreOf(t.id);
    return {
      rounds: this.night.rounds.map((r) => ({ title: r.title, questions: r.questions.map((q) => this.hostQuestion(q)) })),
      final: this.night.final ? this.hostQuestion(this.night.final) : null,
      tiebreak: this.night.tiebreak ? this.hostQuestion(this.night.tiebreak) : null,
      answers: mapOf(this.answers),
      marks: mapOf(this.marks),
      overrides: Object.fromEntries([...this.overrides].map(([t, m]) => [t, Object.fromEntries(m)])),
      wagers: Object.fromEntries(this.wagers),
      scores,
      live: this.ranking(),
      spec: this.spec,
      cohosts: this.cohosts().map((m) => ({ memberId: m.id, name: m.name, connected: m.socketIds.size > 0 })),
      next: this.suggestNext(),
      tableCount: this.tableCount(),
    };
  }

  viewFor(m: Member): RoomView {
    const s = this.screen;
    const shownQid = s.kind === "question" || s.kind === "answer" ? s.qid : null;
    const shown = shownQid ? this.findQ(shownQid) : undefined;
    const runner = m.role === "host" || m.role === "cohost";
    const answeredOpen = this.openQid ? (this.answers.get(this.openQid)?.size ?? 0) : 0;
    const view: RoomView = {
      code: this.code,
      title: this.title,
      settings: { ...this.settings },
      you: { role: m.role, memberId: m.id, name: m.name, teamId: m.teamId },
      screen: s,
      started: this.started,
      finished: this.finished,
      paused: this.paused,
      plan: this.plan(),
      question: shown ? this.publicQuestion(shown) : null,
      timer:
        this.openQid || (shownQid && this.settings.mode === "phones")
          ? {
              open: !!this.openQid && this.openQid === shownQid,
              closesAt: this.openQid === shownQid ? (this.closesAt ?? undefined) : undefined,
              remainingMs: this.openQid === shownQid ? (this.remainingMs ?? undefined) : undefined,
              totalMs: this.settings.timerSeconds * 1000,
            }
          : null,
      answered: answeredOpen,
      teams: this.teamList(),
      standings: this.published,
      roundAnswers:
        s.kind === "roundAnswers"
          ? {
              round: s.round,
              title: this.night.rounds[s.round]?.title ?? "",
              items: (this.night.rounds[s.round]?.questions ?? [])
                .filter((q) => this.revealed.has(q.qid))
                .map((q) => ({ number: q.number, text: q.text, answer: q.answer })),
            }
          : null,
      answerStats:
        s.kind === "answer" && this.marks.get(s.qid)?.size ? { correct: this.correctCount(s.qid), of: this.teams.size } : null,
      wager:
        s.kind === "wager" || this.wagerOpen
          ? { open: this.wagerOpen, category: this.night.final?.category || "Final", teamsIn: this.wagers.size }
          : null,
      serverTime: Date.now(),
    };
    if (m.role === "team" && m.teamId) {
      const tid = m.teamId;
      const row = this.published?.rows.find((r) => r.teamId === tid);
      const a = shownQid ? this.answers.get(shownQid)?.get(tid) : undefined;
      const revealedShown = !!shownQid && this.revealed.has(shownQid);
      view.mine = {
        ...(a && shownQid
          ? {
              answer: {
                qid: shownQid,
                text: a.text,
                ...(revealedShown ? { correct: this.marks.get(shownQid)?.get(tid) === true } : {}),
              },
            }
          : {}),
        ...(this.wagers.has(tid) ? { wager: this.wagers.get(tid) } : {}),
        ...(row ? { score: row.score, place: row.place } : {}),
        ...(this.wagerOpen ? { maxWager: this.maxWager(tid) } : {}),
      };
    }
    if (runner) view.host = this.hostData();
    return view;
  }

  broadcast(): void {
    for (const m of this.members.values()) {
      if (!m.socketIds.size) continue;
      const v = this.viewFor(m);
      for (const sid of m.socketIds) this.transport.sendState(sid, v);
    }
  }

  // ---------------------------------------------- the game kit's KitRoom

  /** Teams (with or without a phone). */
  playerCount(): number {
    return this.teams.size;
  }

  tableCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.role === "table" && m.socketIds.size > 0) n++;
    return n;
  }

  phase(): string {
    return this.finished ? "over" : this.started ? "playing" : "lobby";
  }

  round(): number | undefined {
    return this.currentRound >= 0 ? this.currentRound + 1 : undefined;
  }

  hostConnected(): boolean {
    return (this.members.get(this.hostId)?.socketIds.size ?? 0) > 0;
  }

  hostName(): string | undefined {
    return this.members.get(this.hostId)?.name;
  }

  maxPlayers(): number {
    return Math.min(MAX_TEAMS_PER_ROOM, LIMITS.teams);
  }

  /** Status title: "Friday Quiz · Round 2: Science · Q3 of 8" (paper / phones). */
  overviewExtra(): Partial<RoomOverview> {
    const parts: string[] = [];
    if (this.title) parts.push(this.title);
    const s = this.screen;
    if (this.finished) parts.push("Finished");
    else if (!this.started) parts.push(`Lobby (${this.settings.mode === "paper" ? "paper" : "phones"})`);
    else if (s.kind === "wager") parts.push("Final: wagers");
    else {
      const q = this.lastQid ? this.findQ(this.lastQid) : undefined;
      if ((s.kind === "question" || s.kind === "answer") && q) {
        parts.push(q.round >= 0 ? `${roundLabel(q.round, this.titleOf(q))} · Q${q.number} of ${this.night.rounds[q.round].questions.length}` : roundLabel(q.round, ""));
      } else if (this.currentRound >= 0) parts.push(roundLabel(this.currentRound, this.night.rounds[this.currentRound].title));
    }
    return { title: parts.join(" · ") };
  }

  close(reason: string, _cause?: CloseCause): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const m of this.members.values()) for (const sid of m.socketIds) this.transport.sendClosed(sid, reason);
  }

  summary() {
    return {
      code: this.code,
      kind: this.kind,
      mode: this.settings.mode,
      teams: this.teams.size,
      stage: this.overviewExtra().title ?? "",
      hostConnected: this.hostConnected(),
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
    };
  }
}
