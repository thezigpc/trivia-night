// Bar Games: standalone stays plain; on a (fake) box the commands, status, events, hosting
// from the box and the results (teams as players, under their own names) all work.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer, setupRoom, smallSpec, answerOf } from "../harness.mjs";

const TOKEN = "test-token";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake box core: serves the venue context, records every event and result. */
async function fakeCore() {
  const events = [];
  const results = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
      if (req.url === "/internal/events") {
        events.push(JSON.parse(body));
        return void res.writeHead(204).end();
      }
      if (req.url === "/internal/results") {
        results.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end("{}");
      }
      if (req.url === "/internal/venue") {
        res.writeHead(200, { "content-type": "application/json" });
        const theme = { colors: { background: "#0b2a2a", surface: "#12403f", text: "#f2fffd", primary: "#ff4fa3", accent: "#ffd23f" } };
        return void res.end(
          JSON.stringify({
            protocol: 1,
            venue: { name: "Test Bar", theme },
            game: { id: "trivia", displayName: "Trivia at Test Bar", theme },
            standalone: false,
            generatedAt: new Date().toISOString(),
          }),
        );
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${srv.address().port}`,
    events,
    results,
    of: (type, code) => events.filter((e) => e.type === type && (!code || e.roomCode === code)),
    async waitFor(pred, label, ms = 5000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const hit = events.find(pred);
        if (hit) return hit;
        await sleep(25);
      }
      throw new Error(`no event: ${label}; got ${JSON.stringify(events.map((e) => e.type))}`);
    },
    close: () => new Promise((r) => srv.close(r)),
  };
}

describe("standalone (no BG_* env)", () => {
  let server;
  before(async () => {
    server = await startServer();
  });
  after(() => server.stop());

  test("the game's own name; venue.json standalone; status and commands refuse", async () => {
    const cfg = await (await fetch(`${server.url}/api/config`)).json();
    assert.equal(cfg.gameName, "Trivia Night");
    const venue = await (await fetch(`${server.url}/__bargames/venue.json`)).json();
    assert.equal(venue.standalone, true);
    assert.equal((await fetch(`${server.url}/__bargames/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 401);
    const cmd = await fetch(`${server.url}/__bargames/command`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ command: "start", roomCode: "ABCD" }),
    });
    assert.equal(cmd.status, 401);
  });
});

describe("on a box", () => {
  let core;
  let server;
  before(async () => {
    core = await fakeCore();
    server = await startServer({ BG_GAME_ID: "trivia", BG_CORE_URL: core.url, BG_GAME_TOKEN: TOKEN });
  });
  after(async () => {
    await server.stop();
    await core.close();
  });

  const command = async (command, roomCode, args) => {
    const res = await fetch(`${server.url}/__bargames/command`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ command, roomCode, ...(args ? { args } : {}) }),
    });
    return { status: res.status, ...(await res.json()) };
  };
  const status = async () =>
    (await (await fetch(`${server.url}/__bargames/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).rooms;

  test("the venue's name; status lists rooms with teams as players and a join path", async () => {
    const cfg = await (await fetch(`${server.url}/api/config`)).json();
    assert.equal(cfg.gameName, "Trivia at Test Bar");
    const { code } = await setupRoom(server, ["One", "Two"]);
    const mine = (await status()).find((r) => r.code === code);
    assert.equal(mine.kind, "patron");
    assert.equal(mine.players, 2);
    assert.equal(mine.phase, "lobby");
    assert.equal(mine.joinPath, `/join/${code}`);
    assert.equal(mine.hostName, "Host");
    assert.match(mine.title, /Lobby \(phones\)/);
    await core.waitFor((e) => e.type === "room_created" && e.roomCode === code, "room_created");
    await core.waitFor((e) => e.type === "players_changed" && e.roomCode === code && e.data.players === 2, "players_changed");
  });

  test("commands drive the night like the host's buttons; refusals say why", async () => {
    const { code, host } = await setupRoom(server, ["Cmd Team"], { spec: smallSpec({ rounds: 2, perRound: 1 }) });
    assert.equal((await command("start", "ZZZZ")).ok, false);
    const pauseEarly = await command("pause", code);
    assert.equal(pauseEarly.ok, false);
    assert.match(pauseEarly.message, /hasn't started/);

    assert.equal((await command("start", code)).ok, true);
    await host.waitFor((v) => v.screen.kind === "intro" && v.screen.round === 0, "round 1");
    const again = await command("start", code);
    assert.equal(again.ok, false);
    assert.match(again.message, /already started/);
    await core.waitFor((e) => e.type === "round_started" && e.roomCode === code && e.data.round === 1, "round_started");

    assert.equal((await command("pause", code)).ok, true);
    await host.waitFor((v) => v.paused, "paused");
    assert.equal((await command("pause", code)).ok, false);
    assert.equal((await command("resume", code)).ok, true);
    const notPaused = await command("resume", code);
    assert.match(notPaused.message, /isn't paused/);

    assert.equal((await command("next_round", code)).ok, true);
    await host.waitFor((v) => v.screen.kind === "intro" && v.screen.round === 1, "round 2");
    assert.equal((await command("next_round", code)).ok, true, "after the last round: the final's wagers");
    await host.waitFor((v) => v.screen.kind === "wager", "wager");
    const last = await command("next_round", code);
    assert.equal(last.ok, false);
    assert.match(last.message, /last round/);

    const s = (await status()).find((r) => r.code === code);
    assert.equal(s.phase, "playing");
    assert.match(s.title, /Final: wagers/);

    assert.equal((await command("end", code)).ok, true);
    await sleep(50);
    assert.match(host.closedReason, /host closed/);
    assert.ok(!(await status()).some((r) => r.code === code), "closed means gone");
    const closed = await core.waitFor((e) => e.type === "room_closed" && e.roomCode === code, "room_closed");
    assert.equal(closed.data.reason, "host");
  });

  test("results: teams as players under their own names, with places and scores; winner and game_over", async () => {
    const { code, host, teams } = await setupRoom(server, ["The Smarty Pints", "Quizteama Aguilera"], {
      spec: smallSpec({ rounds: 1, perRound: 1, final: false, tiebreaker: false }),
    });
    await host.ok("start");
    await host.ok("next");
    const hs = await host.waitFor((v) => v.screen.kind === "question", "q1");
    await teams[0].ok("answer", { qid: "r1q1", text: answerOf(hs, "r1q1") });
    await host.ok("next"); // close
    await host.ok("next"); // reveal
    await core.waitFor((e) => e.type === "x-trivia-answer-revealed" && e.roomCode === code, "answer revealed");
    await host.ok("next"); // standings
    const st = await core.waitFor((e) => e.type === "x-trivia-standings" && e.roomCode === code, "standings");
    assert.equal(st.data.top[0].name, "The Smarty Pints");
    await core.waitFor((e) => e.type === "round_ended" && e.roomCode === code, "round_ended");
    await host.ok("finish");

    const result = await core.waitFor((e) => e.type === "game_result" && e.roomCode === code, "game_result");
    assert.deepEqual(result.data.results, [
      { player: { name: "The Smarty Pints" }, place: 1, score: 1 },
      { player: { name: "Quizteama Aguilera" }, place: 2, score: 0 },
    ]);
    const winner = await core.waitFor((e) => e.type === "winner" && e.roomCode === code, "winner");
    assert.equal(winner.data.name, "The Smarty Pints");
    const over = await core.waitFor((e) => e.type === "game_over" && e.roomCode === code, "game_over");
    assert.deepEqual(over.data.winners, ["The Smarty Pints"]);
    assert.ok(core.results.some((r) => r.roomCode === code));
    // Finishing twice never reports twice.
    assert.equal(core.of("game_result", code).length, 1);

    // Privacy: events carry only names people typed: no tokens, socket ids or IPs.
    const all = JSON.stringify(core.events);
    for (const t of teams) assert.ok(!all.includes(t.token));
    assert.ok(!/127\.0\.0\.1/.test(all));
  });

  test("create_room: a venue room the box drives; hostUrl opens the host seat; first joiner hosts", async () => {
    const created = await command("create_room", undefined, { kind: "venue", purpose: "display", title: "Tuesday Quiz" });
    assert.equal(created.ok, true, created.message);
    const { roomCode: code, hostUrl } = created.data;
    assert.match(hostUrl, new RegExp(`^/join/${code}\\?host=`));
    const s = (await status()).find((r) => r.code === code);
    assert.equal(s.kind, "venue");
    assert.equal(s.hostConnected, false);
    assert.match(s.title, /^Tuesday Quiz · /);

    // A team joins as a team (no first-joiner offer without the flag).
    const team = await server.client();
    const tj = await team.ok("joinRoom", { code, role: "team", name: "Early Birds" });
    assert.equal(tj.role, "team");
    // Staff open the host link: the host seat, with its own token back.
    const staff = await server.client();
    const key = new URL(hostUrl, "http://x").searchParams.get("host");
    const res = await staff.ok("resume", { code, token: key });
    assert.equal(res.role, "host");
    assert.notEqual(res.token, key, "the seat's own token, so a take-over leaves this device seated");

    // First joiner hosts: the first phone becomes the host, the next is a team.
    const fj = await command("create_room", undefined, { kind: "venue", firstJoinerHosts: true });
    const p1 = await server.client();
    const first = await p1.ok("joinRoom", { code: fj.data.roomCode, role: "team", name: "Pat" });
    assert.equal(first.role, "host");
    const p2 = await server.client();
    const second = await p2.ok("joinRoom", { code: fj.data.roomCode, role: "team", name: "Lee's Team" });
    assert.equal(second.role, "team");
  });

  test("hosting from the box: take over, co-host invite, remove co-host", async () => {
    const { code, host } = await setupRoom(server, []);
    const notices = [];
    host.socket.on("notice", (n) => notices.push(n.message));
    const t1 = await command("host_link", code);
    assert.equal(t1.ok, true, t1.message);
    const t2 = await command("host_link", code);
    assert.notEqual(t1.data.url, t2.data.url, "a new link each time");
    await sleep(100);
    assert.ok(notices.some((m) => /Staff took over/.test(m)));
    let hs = await host.waitFor((v) => v.you.role === "cohost", "old host is a co-host");
    assert.ok(hs.host, "a co-host still runs the night");

    // The new host link works; the old one doesn't.
    const staff = await server.client();
    const key2 = new URL(t2.data.url, "http://x").searchParams.get("host");
    assert.equal((await staff.ok("resume", { code, token: key2 })).role, "host");
    const key1 = new URL(t1.data.url, "http://x").searchParams.get("host");
    const stale = await (await server.client()).emit("resume", { code, token: key1 });
    assert.equal(stale.ok, false);

    const inv = await command("cohost_link", code, { minutes: 5 });
    assert.equal(inv.ok, true);
    assert.ok(inv.data.expiresAt);
    const invite = new URL(inv.data.url, "http://x").searchParams.get("cohost");
    const helper = await server.client();
    assert.equal((await helper.ok("joinRoom", { code, role: "team", name: "Helper", cohost: invite })).role, "cohost");
    const h = await helper.waitFor((v) => v.you.role === "cohost", "helper view");
    const rm = await command("remove_cohost", code, { memberId: h.you.memberId });
    assert.equal(rm.ok, true, rm.message);
    await sleep(100);
    assert.match(helper.closedReason ?? "", /not a co-host/);
  });
});
