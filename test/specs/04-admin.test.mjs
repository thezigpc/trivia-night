// The admin: sign-in, question packs (CSV/JSON upload with per-row errors), pictures,
// the venue's known teams (pick an existing team; rename/merge), settings.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { startServer, smallSpec } from "../harness.mjs";

let server;
let token;
before(async () => {
  server = await startServer({ ADMIN_PASSWORD: "letmein-trivia" });
  const r = await fetch(`${server.url}/api/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "letmein-trivia" }),
  });
  token = (await r.json()).token;
});
after(() => server.stop());

const api = async (path, { method = "GET", body, auth = true } = {}) => {
  const r = await fetch(`${server.url}/api/admin${path}`, {
    method,
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, body: json };
};

/** Polls until fn() is true (background saves). */
async function until(fn, label, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out: ${label}`);
}

// A 1x1 PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("admin", () => {
  test("signed out: nothing but status", async () => {
    assert.equal((await api("/overview", { auth: false })).status, 401);
    assert.equal((await api("/upload/packs/preview", { method: "POST", body: { text: "x" }, auth: false })).status, 401);
    const s = await api("/status", { auth: false });
    assert.equal(s.body.authenticated, false);
  });

  test("packs: preview reports rows; only a clean pack saves; it can be played and downloaded", async () => {
    const bad = "question,answer,type,choices\nOK?,yes,,\nBroken,Z,choice,a|b\n";
    const prev = await api("/upload/packs/preview", { method: "POST", body: { text: bad } });
    assert.equal(prev.status, 200);
    assert.equal(prev.body.questions.length, 1);
    assert.match(prev.body.errors[0], /^Row 3:/);
    const refused = await api("/upload/packs", { method: "POST", body: { text: bad, name: "Bad" } });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.errors.length, 1);

    const csv = [
      "question,answer,accept,category,use",
      "Q one,A one,,Music,",
      "Q two,A two,alt two,Music,",
      "Q three,A three,,Film,",
      "Last one,Fin,,Finale,final",
    ].join("\n");
    const saved = await api("/upload/packs", { method: "POST", body: { text: csv, name: "Pub Pack" } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const id = saved.body.id;

    const o = await api("/overview");
    const pack = o.body.packs.find((p) => p.id === id);
    assert.equal(pack.count, 3);
    assert.deepEqual(
      pack.categories.map((c) => [c.name, c.count]),
      [
        ["Music", 2],
        ["Film", 1],
      ],
    );
    assert.equal(pack.finals, 1);
    // Public config lists packs without answers.
    const cfg = await (await fetch(`${server.url}/api/config`)).json();
    assert.ok(cfg.packs.some((p) => p.id === id));
    assert.ok(!JSON.stringify(cfg).includes("A one"));
    // The newest uploaded pack becomes the default night.
    const dn = await (await fetch(`${server.url}/api/default-night`)).json();
    assert.equal(dn.spec.rounds[0].packId, id);
    assert.equal(dn.spec.finalPackId, id);

    // A night built from it by round.
    const host = await server.client();
    await host.ok("createRoom", {
      settings: { mode: "paper" },
      spec: {
        rounds: [
          { title: "Music", packId: id, category: "Music", count: 5 },
          { title: "Mixed", packId: "sample", category: "", count: 2 },
        ],
        finalPackId: id,
        tiebreaker: true,
        shuffle: false,
      },
    });
    const hs = await host.waitFor((v) => v.host, "host view");
    assert.deepEqual(
      hs.host.rounds.map((r) => r.questions.map((q) => q.text)),
      [["Q one", "Q two"], ["How many sides does a hexagon have?", "Without jokers, how many cards are in a standard deck of playing cards?"]],
    );
    assert.equal(hs.host.final.text, "Last one");
    assert.equal(hs.host.tiebreak.type, "number", "the tie-breaker comes from another pack when this one has none");

    const dl = await api(`/packs/${id}?format=csv`);
    assert.match(dl.body, /^question,answer,accept,type,choices,category,points,image,note,use\r\n/);
    assert.match(dl.body, /Q two,A two,alt two,open/);

    const replaced = await api("/upload/packs", { method: "POST", body: { text: "question,answer\nOnly,One", name: "Pub Pack v2", id } });
    assert.equal(replaced.status, 200);
    assert.equal((await api("/overview")).body.packs.find((p) => p.id === id).name, "Pub Pack v2");

    assert.equal((await api("/packs/sample", { method: "DELETE" })).status, 404, "the sample pack stays");
    assert.equal((await api(`/packs/${id}`, { method: "DELETE" })).status, 200);
    assert.ok(!(await api("/overview")).body.packs.some((p) => p.id === id));
  });

  test("a big pack (well over 16 KB) uploads through the kit's admin router (bodyLimit)", async () => {
    const rows = ["question,answer,category"];
    for (let i = 1; i <= 400; i++) rows.push(`Big question number ${i} with some padding text to make it longer?,Answer ${i},Bulk`);
    const text = rows.join("\n");
    assert.ok(Buffer.byteLength(text) > 30_000);
    const saved = await api("/upload/packs", { method: "POST", body: { text, name: "Bulk Pack" } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 200));
    const pack = (await api("/overview")).body.packs.find((p) => p.id === saved.body.id);
    assert.equal(pack.count, 400);
    assert.equal((await api(`/packs/${saved.body.id}`, { method: "DELETE" })).status, 200);
  });

  test("pictures: images upload and serve safely; SVG and junk are refused", async () => {
    const up = await api("/upload/pictures", { method: "POST", body: { name: "My Photo.PNG", data: PNG } });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.name, "my-photo.png");
    const r = await fetch(`${server.url}/api/pictures/my-photo.png`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "image/png");
    assert.match(r.headers.get("content-security-policy"), /sandbox/);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64");
    const refused = await api("/upload/pictures", { method: "POST", body: { name: "x.svg", data: svg } });
    assert.equal(refused.status, 400);
    const dupe = await api("/upload/pictures", { method: "POST", body: { name: "my photo.png", data: PNG } });
    assert.equal(dupe.status, 400);
    assert.equal((await fetch(`${server.url}/api/pictures/..%2Fadmin.json`)).status, 404);
    assert.equal((await fetch(`${server.url}/api/pictures/sample-flag.svg`)).status, 200);
    const list = (await api("/overview")).body.pictures;
    assert.ok(list.some((p) => p.name === "my-photo.png" && !p.builtIn));
    assert.ok(list.some((p) => p.name === "sample-flag.svg" && p.builtIn));
    assert.equal((await api("/pictures/my-photo.png", { method: "DELETE" })).status, 200);
    assert.equal((await api("/pictures/sample-flag.svg", { method: "DELETE" })).status, 404);
  });

  test("known teams: a returning team keeps its spelling; staff merge a misspelt duplicate", async () => {
    // Play a night so the teams are known.
    const host = await server.client();
    const { code } = await host.ok("createRoom", { settings: { mode: "paper" }, spec: smallSpec({ rounds: 1, perRound: 1, final: false, tiebreaker: false }) });
    await host.ok("addTeam", "Quiz Khalifa");
    await host.ok("addTeam", "Trivia Newton John");
    await host.ok("start");
    await host.ok("finish");
    // The night's teams are saved in the background after finishing.
    await until(async () => (await (await fetch(`${server.url}/api/teams`)).json()).teams.length === 2, "teams saved");
    const known = await (await fetch(`${server.url}/api/teams`)).json();
    assert.deepEqual(known.teams.sort(), ["Quiz Khalifa", "Trivia Newton John"]);

    // Next week, typed differently: the saved spelling wins (phones and paper).
    const host2 = await server.client();
    const r2 = await host2.ok("createRoom", { settings: { mode: "phones" }, spec: smallSpec() });
    const phone = await server.client();
    const joined = await phone.ok("joinRoom", { code: r2.code, role: "team", name: "quiz   KHALIFA" });
    assert.equal(joined.name, "Quiz Khalifa");
    const added = await host2.ok("addTeam", "triviaNewtonJohn");
    assert.equal(added.name, "Trivia Newton John");

    // A misspelt team, merged by renaming it onto the right one.
    const host3 = await server.client();
    await host3.ok("createRoom", { settings: { mode: "paper" }, spec: smallSpec({ rounds: 1, perRound: 1, final: false, tiebreaker: false }) });
    await host3.ok("addTeam", "Quiz Kalifa");
    await host3.ok("start");
    await host3.ok("finish");
    await until(async () => (await api("/overview")).body.teams.some((t) => t.name === "Quiz Kalifa"), "Quiz Kalifa saved");
    let teams = (await api("/overview")).body.teams;
    assert.ok(teams.some((t) => t.name === "Quiz Kalifa"));
    const merged = await api("/teams/rename", { method: "POST", body: { from: "Quiz Kalifa", to: "quiz khalifa" } });
    assert.equal(merged.status, 200);
    teams = (await api("/overview")).body.teams;
    assert.ok(!teams.some((t) => t.name === "Quiz Kalifa"));
    const qk = teams.filter((t) => t.name.toLowerCase() === "quiz khalifa");
    assert.equal(qk.length, 1);
    assert.equal(qk[0].nights, 2);
    assert.equal((await api("/teams/remove", { method: "POST", body: { name: "Trivia Newton John" } })).status, 200);
    void code;
  });

  test("settings: defaults for new rooms, checked", async () => {
    const bad = await api("/settings", { method: "PUT", body: { defaultTimerSeconds: 3 } });
    assert.equal(bad.status, 400);
    const ok = await api("/settings", { method: "PUT", body: { defaultMode: "paper", defaultTimerSeconds: 30, defaultRevealMode: "round" } });
    assert.equal(ok.status, 200);
    const host = await server.client();
    await host.ok("createRoom", { spec: smallSpec() });
    const hs = await host.waitFor((v) => v.host, "room");
    assert.deepEqual(hs.settings, { mode: "paper", revealMode: "round", timerSeconds: 30 });
    const cfg = await (await fetch(`${server.url}/api/config`)).json();
    assert.deepEqual(cfg.defaults, { mode: "paper", revealMode: "round", timerSeconds: 30 });
  });
});
