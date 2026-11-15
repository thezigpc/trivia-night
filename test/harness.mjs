// Test harness: every spec file gets its own throwaway server on its own port.
// Specs talk to it over real sockets, exactly like the client does.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { io } from "socket.io-client";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export async function startServer(env = {}) {
  const port = await freePort();
  // Throwaway data dir per server: admin password/settings never leak between specs.
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "trivia-test-"));
  const proc = spawn(process.execPath, [path.join(root, "server/dist/index.js")], {
    env: { ...process.env, PORT: String(port), LOG_LEVEL: "warn", CLIENT_DIST_PATH: path.join(root, "nonexistent"), DATA_DIR: dataDir, ADMIN_PASSWORD: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", (d) => (output += d));
  proc.stderr.on("data", (d) => (output += d));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const clients = [];
  return {
    url,
    dataDir,
    proc,
    port,
    get output() {
      return output;
    },
    async client() {
      const c = await connect(url);
      clients.push(c);
      return c;
    },
    async stop() {
      for (const c of clients) c.socket.close();
      proc.kill();
      await new Promise((r) => proc.once("exit", r));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A socket wrapper that remembers the latest state and lets specs await conditions. */
export async function connect(url) {
  const socket = io(url, { transports: ["websocket"], reconnection: false, forceNew: true });
  const c = {
    socket,
    state: null,
    closedReason: null,
    waiters: [],
    emit(event, ...args) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`ack timeout: ${event}`)), 5000);
        socket.emit(event, ...args, (res) => {
          clearTimeout(t);
          resolve(res);
        });
      });
    },
    /** Emits and asserts ok, returning the ack payload. */
    async ok(event, ...args) {
      const res = await c.emit(event, ...args);
      if (!res?.ok) throw new Error(`${event} failed: ${res?.error}`);
      return res;
    },
    waitFor(pred, label = "condition", ms = 5000) {
      if (c.state && pred(c.state)) return Promise.resolve(c.state);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        c.waiters.push(w);
        setTimeout(() => {
          c.waiters = c.waiters.filter((x) => x !== w);
          reject(new Error(`timed out waiting for ${label}; last state: ${JSON.stringify(c.state)?.slice(0, 500)}`));
        }, ms);
      });
    },
  };
  socket.on("state", (s) => {
    c.state = s;
    for (const w of [...c.waiters]) {
      if (w.pred(s)) {
        c.waiters = c.waiters.filter((x) => x !== w);
        w.resolve(s);
      }
    }
  });
  socket.on("closed", ({ reason }) => (c.closedReason = reason));
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return c;
}


/** A small night from the sample pack: rounds of `perRound` questions, the final and the tie-breaker. */
export function smallSpec({ rounds = 2, perRound = 3, final = true, tiebreaker = true } = {}) {
  const cats = ["General Knowledge", "Science & Nature", "Geography", "Pictures"];
  return {
    rounds: cats.slice(0, rounds).map((c) => ({ title: c, packId: "sample", category: c, count: perRound })),
    finalPackId: final ? "sample" : null,
    tiebreaker,
    shuffle: false,
  };
}

/** A host's room plus teams joining from phones (phones mode). */
export async function setupRoom(server, teamNames = ["Quizzly Bears"], opts = {}) {
  const host = await server.client();
  const created = await host.ok("createRoom", {
    name: "Host",
    settings: { mode: "phones", timerSeconds: 60, ...(opts.settings ?? {}) },
    spec: opts.spec ?? smallSpec(),
  });
  const teams = [];
  for (const name of teamNames) {
    const t = await server.client();
    const joined = await t.ok("joinRoom", { code: created.code, role: "team", name });
    t.token = joined.token;
    t.name = joined.name;
    teams.push(t);
  }
  if (teams.length) await host.waitFor((s) => s.teams.length === teamNames.length, "teams joined");
  return { code: created.code, host, teams };
}

/** The sample pack's answers, by room question id, from the host's view. */
export function answerOf(hostState, qid) {
  const h = hostState.host;
  if (qid === "final") return h.final.answer;
  if (qid === "tb") return h.tiebreak.answer;
  const m = /^r(\d+)q(\d+)$/.exec(qid);
  return h.rounds[Number(m[1]) - 1].questions[Number(m[2]) - 1].answer;
}
