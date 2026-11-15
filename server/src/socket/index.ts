import type { Server, Socket } from "socket.io";
import { ERRORS, type ClientToServerEvents, type JoinResult, type NightSpec, type RoomSettings, type ServerToClientEvents } from "@trivia/shared";
import { log } from "@bargames/gamekit/server";
import { clientIp } from "../bargames.js";
import { GameError } from "../rooms/errors.js";
import { cohostPath, type Member, type Room } from "../rooms/Room.js";
import { createRoom, HOST_CLOSE_REASON, nightFor, type Rooms } from "../rooms/registry.js";

interface SocketData {
  code?: string;
  memberId?: string;
  lastEvent?: string;
}
export type IO = Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
type S = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
type AckFn = (res: { ok: boolean; [k: string]: unknown }) => void;

// Failed join/resume attempts per IP: the room code is the only gate on the join link.
const JOIN_WINDOW_MS = 60_000;
const JOIN_FAILS_ALLOWED = 20;
const joinFails = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (joinFails.get(ip) ?? []).filter((t) => now - t < JOIN_WINDOW_MS);
  joinFails.set(ip, recent);
  return recent.length >= JOIN_FAILS_ALLOWED;
}
function noteJoinFail(ip: string): void {
  const list = joinFails.get(ip) ?? [];
  list.push(Date.now());
  joinFails.set(ip, list);
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of joinFails) if (list.every((t) => now - t >= JOIN_WINDOW_MS)) joinFails.delete(ip);
}, JOIN_WINDOW_MS).unref();

export function registerSocketHandlers(io: IO, rooms: Rooms): void {
  io.on("connection", (socket: S) => {
    const ip = clientIp(socket.request);
    socket.onAny((event: string) => {
      socket.data.lastEvent = event;
    });

    const fail = (ack: AckFn | undefined, err: unknown) => {
      if (!(err instanceof GameError)) log.error("socket", "handler threw", { event: socket.data.lastEvent, err: String(err) });
      log.warn("socket", "rejected", {
        event: socket.data.lastEvent,
        code: socket.data.code,
        member: socket.data.memberId,
        error: err instanceof GameError ? err.code : "INTERNAL",
      });
      if (typeof ack === "function") ack({ ok: false, error: err instanceof GameError ? err.message : ERRORS.BAD_REQUEST });
    };

    const unbind = () => {
      const { code, memberId } = socket.data;
      socket.data.code = undefined;
      socket.data.memberId = undefined;
      if (code && memberId) {
        const room = rooms.get(code);
        if (room) {
          room.detachSocket(memberId, socket.id);
          room.broadcast();
        }
      }
    };

    const bind = (room: Room, member: Member): JoinResult => {
      if (socket.data.code !== room.code || socket.data.memberId !== member.id) unbind();
      room.attachSocket(member, socket.id);
      // "First joiner hosts": any attach to the host seat closes the offer (kit HostSeats).
      room.noteAttached(member);
      socket.data.code = room.code;
      socket.data.memberId = member.id;
      return { code: room.code, token: member.token, memberId: member.id, role: member.role, name: member.name };
    };

    /** A room-scoped intent, then a broadcast to everyone in the room. */
    function on<A>(event: keyof ClientToServerEvents, fn: (room: Room, member: Member, arg: A) => object | void) {
      (socket.on as (e: string, h: (...args: unknown[]) => void) => void)(event, (...args: unknown[]) => {
        const ack = args[args.length - 1] as AckFn;
        const arg = (args.length > 1 ? args[0] : undefined) as A;
        try {
          const { code, memberId } = socket.data;
          const room = code ? rooms.get(code) : undefined;
          const member = room && memberId ? room.members.get(memberId) : undefined;
          if (!room || !member) throw new GameError("NOT_IN_ROOM");
          const result = fn(room, member, arg) ?? {};
          room.broadcast();
          if (typeof ack === "function") ack({ ok: true, ...result });
        } catch (err) {
          fail(ack, err);
        }
      });
    }
    /** Host or co-host: running the night. */
    function runner<A>(event: keyof ClientToServerEvents, fn: (room: Room, member: Member, arg: A) => object | void) {
      on<A>(event, (room, m, arg) => {
        room.requireRunner(m.id);
        return fn(room, m, arg);
      });
    }

    socket.on("createRoom", (req, ack) => {
      try {
        let host: Member | undefined;
        const room = createRoom(
          rooms,
          "patron",
          { settings: req?.settings, spec: req?.spec, title: typeof req?.title === "string" ? req.title : undefined },
          (r) => {
            host = r.addHost(String(req?.name ?? "").trim().slice(0, 32));
          },
        );
        const result = bind(room, host!);
        log.info("room", "created", { code: room.code, mode: room.settings.mode, rounds: room.night.rounds.length });
        ack({ ok: true, ...result });
        room.broadcast();
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    socket.on("roomInfo", (req, ack) => {
      try {
        if (rateLimited(ip)) throw new GameError("RATE_LIMITED");
        const room = rooms.get(String(req?.code ?? ""));
        if (!room) {
          noteJoinFail(ip);
          throw new GameError("ROOM_NOT_FOUND");
        }
        ack({ ok: true, mode: room.settings.mode, started: room.started });
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    socket.on("joinRoom", (req, ack) => {
      try {
        if (rateLimited(ip)) throw new GameError("RATE_LIMITED");
        const room = rooms.get(String(req?.code ?? ""));
        if (!room) {
          noteJoinFail(ip);
          throw new GameError("ROOM_NOT_FOUND");
        }
        if (req.role !== "team" && req.role !== "table") throw new GameError("BAD_REQUEST");
        // A known token (or the host link's key) means "same seat again", never a second seat.
        const existing = room.seatFor(req.token);
        let member: Member;
        if (req.cohost !== undefined) {
          if (req.role !== "team" || !room.seats.redeem(req.cohost)) throw new GameError("BAD_INVITE");
          member = room.seatCohost(existing, req.name);
        } else if (existing) {
          member = existing;
        } else if (req.role === "table") {
          member = room.addTable();
        } else if (room.seats.offerOpen) {
          // A box room nobody hosts yet ("first joiner hosts"): the first phone takes the host seat.
          member = room.claimHostSeat(req.name);
        } else {
          member = room.joinAsTeam(req.name);
        }
        const result = bind(room, member);
        log.info("room", existing ? "rejoined" : "joined", { code: room.code, role: member.role, name: member.name });
        ack({ ok: true, ...result });
        room.broadcast();
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    // Sent by the client on EVERY socket connect: socket.io's reconnect is a new socket with
    // no room binding (the CAHDigitalGame reconnect-desync bug).
    socket.on("resume", (req, ack) => {
      try {
        if (rateLimited(ip)) throw new GameError("RATE_LIMITED");
        const room = rooms.get(String(req?.code ?? ""));
        if (!room) {
          noteJoinFail(ip);
          throw new GameError("ROOM_NOT_FOUND");
        }
        const member = room.seatFor(req?.token);
        if (!member) {
          noteJoinFail(ip);
          throw new GameError("BAD_TOKEN");
        }
        const result = bind(room, member);
        ack({ ok: true, ...result });
        room.broadcast();
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    socket.on("leaveRoom", (ack) => {
      const { code, memberId } = socket.data;
      const room = code ? rooms.get(code) : undefined;
      socket.data.code = undefined;
      socket.data.memberId = undefined;
      if (room && memberId) {
        room.detachSocket(memberId, socket.id);
        // The host's seat stays (the room runs on; close it with Close). Others leave.
        if (memberId !== room.hostId) room.removeMember(memberId);
        room.broadcast();
      }
      ack({ ok: true });
    });

    socket.on("closeRoom", (ack) => {
      try {
        const { code, memberId } = socket.data;
        const room = code ? rooms.get(code) : undefined;
        if (!room || !memberId) throw new GameError("NOT_IN_ROOM");
        room.requireHost(memberId);
        rooms.closeRoom(room.code, HOST_CLOSE_REASON, "host");
        ack({ ok: true });
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    // ------------------------------------------------- host and co-hosts
    runner<Partial<RoomSettings>>("updateSettings", (room, _m, patch) => room.updateSettings(patch ?? {}));
    runner<NightSpec>("setSpec", (room, _m, spec) => {
      if (room.started) throw new GameError("ALREADY_STARTED");
      const { spec: clean, night } = nightFor(spec ?? {});
      room.setNight(clean, night);
    });
    runner("start", (room) => room.start());
    runner<number>("intro", (room, _m, r) => room.intro(Number(r)));
    runner<string>("ask", (room, _m, qid) => room.ask(qid));
    runner("close", (room) => room.closeNow());
    runner<string>("reveal", (room, _m, qid) => room.reveal(qid));
    runner<number>("revealRound", (room, _m, r) => room.revealRound(r));
    runner("standings", (room) => room.showStandings());
    runner("wager", (room) => room.openWagers());
    runner("finish", (room) => room.finish());
    runner("showLobby", (room) => room.showLobby());
    runner<boolean>("setPaused", (room, _m, p) => room.setPaused(Boolean(p)));
    runner("next", (room) => room.next());
    runner<{ qid: string; teamId: string; correct: boolean }>("mark", (room, _m, req) =>
      room.mark(req?.qid, String(req?.teamId ?? ""), req?.correct === true),
    );
    runner<{ teamId: string; round: number; score: number | null }>("setOverride", (room, _m, req) =>
      room.setOverride(String(req?.teamId ?? ""), req?.round, req?.score),
    );
    runner<{ teamId: string; wager: number }>("setWagerFor", (room, _m, req) => room.setWagerFor(String(req?.teamId ?? ""), req?.wager));
    runner<{ teamId: string; qid: string; text: string }>("setAnswerFor", (room, _m, req) =>
      room.setAnswerFor(String(req?.teamId ?? ""), req?.qid, req?.text),
    );
    runner<string>("addTeam", (room, _m, name) => {
      const t = room.addTeam(name);
      log.info("room", "team added", { code: room.code, team: t.name });
      return { teamId: t.id, name: t.name };
    });
    runner<{ teamId: string; name: string }>("renameTeam", (room, _m, req) => room.renameTeam(String(req?.teamId ?? ""), req?.name));

    // ------------------------------------------------------- host only
    on<string>("removeTeam", (room, m, teamId) => {
      room.requireHost(m.id);
      room.removeTeam(String(teamId ?? ""));
    });
    on("cohostInvite", (room, m) => {
      room.requireHost(m.id);
      const inv = room.seats.invite();
      log.info("room", "co-host invite", { code: room.code, expiresAt: inv.expiresAt });
      return { path: cohostPath(room, inv.token), expiresAt: inv.expiresAt };
    });
    on<string>("removeCohost", (room, m, target) => {
      room.requireHost(m.id);
      if (!room.seats.isCohost(String(target))) throw new GameError("BAD_REQUEST");
      room.demoteCohost(String(target));
    });

    // ------------------------------------------------------ team phones
    on<{ qid: string; text: string }>("answer", (room, m, req) => room.answer(m, req?.qid, req?.text));
    on<number>("submitWager", (room, m, w) => room.submitWager(m, w));

    socket.on("disconnect", () => unbind());
  });
}
