// Paper mode: no phones. The coordinator adds the teams, marks the answer cards, types round
// totals and wagers, and sends answers and scores to the TV when they choose.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { startServer, smallSpec, answerOf } from "../harness.mjs";

let server;
before(async () => {
  server = await startServer();
});
after(() => server.stop());

async function paperRoom(spec = smallSpec({ rounds: 2, perRound: 2 })) {
  const host = await server.client();
  const { code } = await host.ok("createRoom", { name: "Host", settings: { mode: "paper" }, spec });
  const tv = await server.client();
  await tv.ok("joinRoom", { code, role: "table" });
  await tv.waitFor((v) => v.you.role === "table", "tv");
  return { code, host, tv };
}

describe("paper mode", () => {
  test("phones can't join a paper night; roomInfo says why before they type", async () => {
    const { code } = await paperRoom();
    const phone = await server.client();
    const info = await phone.ok("roomInfo", { code });
    assert.equal(info.mode, "paper");
    const r = await phone.emit("joinRoom", { code, role: "team", name: "Sneaky" });
    assert.equal(r.ok, false);
    assert.match(r.error, /paper answer cards/);
  });

  test("the coordinator runs the whole night: teams, marks, totals, wagers, tie-breaker", async () => {
    const { host, tv } = await paperRoom();
    const add = async (name) => (await host.ok("addTeam", name)).teamId;
    const red = await add("Red Herrings");
    const blue = await add("Blue Sky Thinkers");
    const dup = await host.emit("addTeam", "red  herrings");
    assert.equal(dup.ok, false);
    await host.ok("renameTeam", { teamId: blue, name: "Blue Sky" });
    let tvs = await tv.waitFor((v) => v.teams.length === 2 && v.teams[1].name === "Blue Sky", "teams on TV");
    assert.equal(tvs.timer, null);

    // No timer on paper: the question just goes up.
    await host.ok("start");
    await host.ok("ask", "r1q1");
    tvs = await tv.waitFor((v) => v.screen.kind === "question", "q1 on TV");
    assert.equal(tvs.timer, null, "no timer in paper mode");
    assert.equal(tvs.question.answer, undefined);
    let hs = await host.waitFor((v) => v.screen.kind === "question", "host q1");
    assert.equal(hs.host.next.action, "reveal", "paper: nothing to close");

    // Marking from the cards.
    await host.ok("mark", { qid: "r1q1", teamId: red, correct: true });
    await host.ok("mark", { qid: "r1q1", teamId: blue, correct: false });
    await host.ok("ask", "r1q2");
    await host.ok("mark", { qid: "r1q2", teamId: red, correct: true });
    await host.ok("mark", { qid: "r1q2", teamId: blue, correct: true });
    hs = await host.waitFor((v) => v.host.scores[blue]?.rounds[0] === 1, "marks counted");
    assert.deepEqual(hs.host.scores[red].rounds, [2, 0]);

    // Answers for the whole round at once, then scores, when the coordinator chooses.
    await host.ok("revealRound", 0);
    tvs = await tv.waitFor((v) => v.screen.kind === "roundAnswers", "round answers on TV");
    assert.deepEqual(
      tvs.roundAnswers.items.map((i) => i.answer),
      [answerOf(hs, "r1q1"), answerOf(hs, "r1q2")],
    );
    assert.equal(tvs.standings, null, "scores aren't on the TV until sent");
    await host.ok("standings");
    tvs = await tv.waitFor((v) => v.screen.kind === "standings", "scores on TV");
    assert.deepEqual(
      tvs.standings.rows.map((r) => [r.name, r.score, r.place]),
      [
        ["Red Herrings", 2, 1],
        ["Blue Sky", 1, 2],
      ],
    );

    // Round 2 by typed totals (paper cards counted by hand), then a correction cleared.
    await host.ok("intro", 1);
    await host.ok("setOverride", { teamId: blue, round: 1, score: 3 });
    await host.ok("setOverride", { teamId: red, round: 1, score: 1.5 });
    await host.ok("setOverride", { teamId: red, round: 1, score: null });
    hs = await host.waitFor((v) => v.host.scores[blue].total === 4, "override counted");
    assert.equal(hs.host.scores[red].total, 2);
    assert.equal(hs.host.overrides[blue][1], 3);
    // The TV still shows the scores last sent.
    assert.equal(tv.state.standings.rows[0].name, "Red Herrings");

    // The final: the coordinator types the wagers from the cards.
    await host.ok("wager");
    tvs = await tv.waitFor((v) => v.screen.kind === "wager", "wager screen");
    assert.ok(tvs.wager.category);
    const over = await host.emit("setWagerFor", { teamId: red, wager: 3 });
    assert.equal(over.ok, false, "no more than the team's score");
    await host.ok("setWagerFor", { teamId: red, wager: 2 });
    await host.ok("setWagerFor", { teamId: blue, wager: 2 });
    await host.ok("ask", "final");
    await host.ok("mark", { qid: "final", teamId: red, correct: true });
    await host.ok("mark", { qid: "final", teamId: blue, correct: true });
    // Before the reveal the final doesn't count yet.
    hs = await host.waitFor((v) => v.host.marks.final?.[blue] === true, "final marked");
    assert.equal(hs.host.scores[red].total, 2);
    await host.ok("reveal", "final");
    hs = await host.waitFor((v) => v.host.scores[red].total === 4, "final counted");
    assert.equal(hs.host.scores[blue].total, 6);

    // A tie the coordinator settles with the tie-breaker guesses written on the cards.
    await host.ok("setOverride", { teamId: red, round: 1, score: 2 }); // red 2 + 2 + 2 = 6
    hs = await host.waitFor((v) => v.host.scores[red].total === 6, "tie");
    assert.equal(hs.host.live[0].place, 1);
    assert.equal(hs.host.live[1].place, 1);
    await host.ok("ask", "tb");
    await host.ok("setAnswerFor", { teamId: red, qid: "tb", text: "1969" });
    await host.ok("setAnswerFor", { teamId: blue, qid: "tb", text: "1959" });
    const notNum = await host.emit("setAnswerFor", { teamId: blue, qid: "tb", text: "sixties" });
    assert.equal(notNum.ok, false);
    await host.ok("reveal", "tb");
    await host.ok("finish");
    tvs = await tv.waitFor((v) => v.screen.kind === "over", "over on TV");
    assert.deepEqual(
      tvs.standings.rows.map((r) => [r.name, r.score, r.place]),
      [
        ["Red Herrings", 6, 1],
        ["Blue Sky", 6, 2],
      ],
    );
  });

  test("removing a team (host only) drops its scores; switching to paper in the lobby lets phones go", async () => {
    const host = await server.client();
    const { code } = await host.ok("createRoom", { settings: { mode: "phones" }, spec: smallSpec() });
    const phone = await server.client();
    await phone.ok("joinRoom", { code, role: "team", name: "Phoners" });
    await host.waitFor((v) => v.teams.length === 1, "joined");
    await host.ok("updateSettings", { mode: "paper" });
    await new Promise((r) => setTimeout(r, 100));
    assert.match(phone.closedReason ?? "", /paper/);
    const hs = await host.waitFor((v) => v.settings.mode === "paper", "paper");
    assert.equal(hs.teams.length, 1, "the team stays");
    assert.equal(hs.teams[0].hasPhone, false);
    await host.ok("removeTeam", hs.teams[0].id);
    await host.waitFor((v) => v.teams.length === 0, "removed");
    await host.ok("start");
    const r = await host.emit("updateSettings", { mode: "phones" });
    assert.equal(r.ok, false, "mode is fixed once the night starts");
  });
});

describe("co-hosts", () => {
  test("a co-host marks and runs screens; only the host removes people or closes the room", async () => {
    const host = await server.client();
    const { code } = await host.ok("createRoom", { settings: { mode: "paper" }, spec: smallSpec() });
    const team = (await host.ok("addTeam", "Marked Men")).teamId;
    const inv = await host.ok("cohostInvite");
    const token = new URL(inv.path, "http://x").searchParams.get("cohost");
    const co = await server.client();
    const joined = await co.ok("joinRoom", { code, role: "team", name: "Sam", cohost: token });
    assert.equal(joined.role, "cohost");
    const again = await (await server.client()).emit("joinRoom", { code, role: "team", name: "Sneak", cohost: token });
    assert.equal(again.ok, false, "invites are single use");

    let cs = await co.waitFor((v) => v.you.role === "cohost" && v.host, "co-host view");
    assert.ok(cs.host.rounds.length > 0, "co-hosts see the answers");
    await co.ok("start");
    await co.ok("ask", "r1q1");
    await co.ok("mark", { qid: "r1q1", teamId: team, correct: true });
    await co.ok("standings");
    cs = await co.waitFor((v) => v.screen.kind === "standings", "standings by co-host");
    for (const [ev, arg] of [
      ["removeTeam", team],
      ["cohostInvite", undefined],
      ["closeRoom", undefined],
    ]) {
      const r = arg === undefined ? await co.emit(ev) : await co.emit(ev, arg);
      assert.equal(r.ok, false, ev);
      assert.match(r.error, /Only the host/);
    }
    const hs = await host.waitFor((v) => v.host.cohosts.length === 1, "host sees the co-host");
    await host.ok("removeCohost", hs.host.cohosts[0].memberId);
    await new Promise((r) => setTimeout(r, 100));
    assert.match(co.closedReason ?? "", /not a co-host/);
  });
});
