// Phones mode: teams join from phones, answer before the timer, auto-marking with the host
// accepting near-misses, reveals, standings, the wager final and the tie-breaker.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { startServer, setupRoom, smallSpec, answerOf } from "../harness.mjs";

let server;
before(async () => {
  server = await startServer();
});
after(() => server.stop());

describe("phones mode", () => {
  test("joining: teams by name, a TV with no name, the same name refused while its phone is on", async () => {
    const { code, host, teams } = await setupRoom(server, ["Quizzly Bears", "Les Quizerables"]);
    const s = await host.waitFor((v) => v.teams.length === 2, "two teams");
    assert.equal(s.you.role, "host");
    assert.equal(s.screen.kind, "lobby");
    assert.deepEqual(
      s.teams.map((t) => t.name),
      ["Quizzly Bears", "Les Quizerables"],
    );
    const tv = await server.client();
    const joined = await tv.ok("joinRoom", { code, role: "table" });
    assert.equal(joined.role, "table");
    const tvState = await tv.waitFor((v) => v.you.role === "table", "tv view");
    assert.equal(tvState.host, undefined, "a TV never gets the host's data");

    const dup = await server.client();
    const res = await dup.emit("joinRoom", { code, role: "team", name: "quizzly  bears" });
    assert.equal(res.ok, false);
    assert.match(res.error, /already playing/);

    // The team's phone dies: the same name on a new phone takes the team over.
    teams[0].socket.close();
    await host.waitFor((v) => v.teams.find((t) => t.name === "Quizzly Bears")?.connected === false, "phone offline");
    const again = await dup.ok("joinRoom", { code, role: "team", name: "QUIZZLY BEARS" });
    assert.equal(again.name, "Quizzly Bears");
    const s2 = await host.waitFor((v) => v.teams.find((t) => t.name === "Quizzly Bears")?.connected === true, "team back");
    assert.equal(s2.teams.length, 2);
  });

  test("a full night: answers, marks, reveals, scores, the final and the results", async () => {
    const { code, host, teams } = await setupRoom(server, ["Alpha", "Bravo", "Charlie"], { spec: smallSpec({ rounds: 2, perRound: 2 }) });
    const [a, b, c] = teams;

    // Teams never see an answer before it's revealed; the host does.
    await host.ok("start");
    let hs = await host.waitFor((v) => v.screen.kind === "intro", "round 1 intro");
    assert.equal(hs.host.next.action, "ask");
    assert.equal(hs.host.rounds.length, 2);
    assert.ok(hs.host.final);
    assert.ok(hs.host.tiebreak);

    await host.ok("next"); // question 1
    const q1 = await a.waitFor((v) => v.screen.kind === "question" && v.timer?.open, "q1 open on a team phone");
    assert.equal(q1.question.qid, "r1q1");
    assert.equal(q1.question.answer, undefined);
    assert.equal(q1.host, undefined);
    hs = await host.waitFor((v) => v.screen.kind === "question", "q1 on host");
    const right1 = answerOf(hs, "r1q1"); // "6" (a hexagon)

    await a.ok("answer", { qid: "r1q1", text: right1 });
    await b.ok("answer", { qid: "r1q1", text: "five" });
    await c.ok("answer", { qid: "r1q1", text: "Six" }); // an accepted alternative
    hs = await host.waitFor((v) => Object.keys(v.host.answers.r1q1 ?? {}).length === 3, "three answers");
    assert.equal(hs.answered, 3);
    const marks = hs.host.marks.r1q1;
    assert.equal(marks[a.state.you.teamId], true);
    assert.equal(marks[b.state.you.teamId], false);
    assert.equal(marks[c.state.you.teamId], true);

    // Changing an answer while open re-marks it.
    await b.ok("answer", { qid: "r1q1", text: "6" });
    hs = await host.waitFor((v) => v.host.marks.r1q1[b.state.you.teamId] === true, "re-marked");

    // Next closes answers, then reveals (answers after each question).
    assert.equal(hs.host.next.action, "close");
    await host.ok("next");
    const closed = await a.waitFor((v) => v.screen.kind === "question" && v.timer && !v.timer.open, "closed");
    assert.equal(closed.mine.answer.text, right1);
    const late = await c.emit("answer", { qid: "r1q1", text: "7" });
    assert.equal(late.ok, false);
    assert.match(late.error, /closed/);

    await host.ok("next"); // reveal
    const revealed = await a.waitFor((v) => v.screen.kind === "answer", "answer screen");
    assert.equal(revealed.question.answer, right1);
    assert.equal(revealed.mine.answer.correct, true);
    assert.deepEqual(revealed.answerStats, { correct: 3, of: 3 });

    // Question 2: a near-miss the host accepts by hand.
    await host.ok("next");
    hs = await host.waitFor((v) => v.screen.kind === "question" && v.question.qid === "r1q2", "q2");
    await a.ok("answer", { qid: "r1q2", text: "fifty two" }); // "fifty-two" normalises the same way
    await b.ok("answer", { qid: "r1q2", text: "54" });
    hs = await host.waitFor((v) => Object.keys(v.host.answers.r1q2 ?? {}).length === 2, "q2 answers");
    assert.equal(hs.host.marks.r1q2[a.state.you.teamId], true);
    await host.ok("mark", { qid: "r1q2", teamId: b.state.you.teamId, correct: true });
    // A team changing its answer after a hand mark doesn't undo the host's call.
    await b.ok("answer", { qid: "r1q2", text: "55" });
    hs = await host.waitFor((v) => v.host.answers.r1q2[b.state.you.teamId].text === "55", "b changed");
    assert.equal(hs.host.marks.r1q2[b.state.you.teamId], true);

    await host.ok("next"); // close
    await host.ok("next"); // reveal
    hs = await host.waitFor((v) => v.screen.kind === "answer" && v.question.qid === "r1q2", "q2 revealed");
    assert.equal(hs.host.next.action, "standings");

    // Scores go to the TV only when sent.
    assert.equal(a.state.standings, null);
    await host.ok("next");
    const st = await a.waitFor((v) => v.screen.kind === "standings", "standings");
    assert.equal(st.standings.label, "After round 1");
    const byName = Object.fromEntries(st.standings.rows.map((r) => [r.name, r]));
    assert.equal(byName.Alpha.score, 2);
    assert.equal(byName.Bravo.score, 2);
    assert.equal(byName.Charlie.score, 1);
    assert.equal(byName.Alpha.place, 1);
    assert.equal(byName.Bravo.place, 1, "equal scores share a place");
    assert.equal(byName.Charlie.place, 3);
    assert.equal(st.mine.score, 2);

    // Round 2: nobody answers; the next button walks through it.
    hs = await host.waitFor((v) => v.host.next?.action === "intro", "next: round 2");
    await host.ok("next"); // intro r2
    for (let i = 0; i < 2; i++) {
      await host.ok("next"); // ask
      await host.ok("next"); // close
      await host.ok("next"); // reveal
    }
    await host.ok("next"); // standings after round 2
    hs = await host.waitFor((v) => v.screen.kind === "standings" && v.standings.label === "After round 2", "after round 2");
    assert.equal(hs.host.next.action, "wager");

    // The final: wagers up to each team's score.
    await host.ok("next");
    const w = await a.waitFor((v) => v.screen.kind === "wager" && v.wager?.open, "wagers open");
    assert.equal(w.mine.maxWager, 2);
    const tooMuch = await a.emit("submitWager", 3);
    assert.equal(tooMuch.ok, false);
    await a.ok("submitWager", 2);
    await b.ok("submitWager", 1);
    await c.ok("submitWager", 1);
    await host.waitFor((v) => v.wager?.teamsIn === 3, "three wagers");

    await host.ok("next"); // final question (closes wagers)
    hs = await host.waitFor((v) => v.screen.kind === "question" && v.question.qid === "final", "final asked");
    const finalAnswer = answerOf(hs, "final");
    const lateWager = await a.emit("submitWager", 1);
    assert.equal(lateWager.ok, false);
    await a.ok("answer", { qid: "final", text: finalAnswer });
    await b.ok("answer", { qid: "final", text: "Nile" });
    await host.ok("next"); // close
    await host.ok("next"); // reveal
    hs = await host.waitFor((v) => v.screen.kind === "answer" && v.question.qid === "final", "final revealed");
    // Alpha 2 + 2 = 4; Bravo 2 - 1 = 1; Charlie (no answer) 1 - 1 = 0.
    const live = Object.fromEntries(hs.host.live.map((r) => [r.name, r.score]));
    assert.deepEqual(live, { Alpha: 4, Bravo: 1, Charlie: 0 });
    assert.equal(hs.host.next.action, "standings");
    await host.ok("next");
    hs = await host.waitFor((v) => v.screen.kind === "standings" && v.standings.label === "After the final", "after final");
    assert.equal(hs.host.next.action, "finish", "no tie at the top: no tie-breaker");

    await host.ok("next"); // finish
    const over = await c.waitFor((v) => v.screen.kind === "over", "over");
    assert.equal(over.finished, true);
    assert.equal(over.standings.label, "Final scores");
    assert.deepEqual(
      over.standings.rows.map((r) => [r.name, r.score, r.place]),
      [
        ["Alpha", 4, 1],
        ["Bravo", 1, 2],
        ["Charlie", 0, 3],
      ],
    );
    assert.equal(over.mine.place, 3);
    hs = await host.waitFor((v) => v.finished, "host finished");
    assert.equal(hs.host.next, null);
    const after = await host.emit("ask", "r1q1");
    assert.equal(after.ok, false);

    // The night's teams are now known at this venue.
    const known = await (await fetch(`${server.url}/api/teams`)).json();
    assert.deepEqual(known.teams.sort(), ["Alpha", "Bravo", "Charlie"]);
    void code;
  });

  test("a tie at the top: the tie-breaker (closest wins) decides the order", async () => {
    const { host, teams } = await setupRoom(server, ["Xenon", "Yttrium"], { spec: smallSpec({ rounds: 1, perRound: 1, final: false }) });
    const [x, y] = teams;
    await host.ok("start");
    await host.ok("next"); // q1
    let hs = await host.waitFor((v) => v.screen.kind === "question", "q1");
    await x.ok("answer", { qid: "r1q1", text: answerOf(hs, "r1q1") });
    await y.ok("answer", { qid: "r1q1", text: answerOf(hs, "r1q1") });
    await host.ok("next"); // close
    await host.ok("next"); // reveal
    await host.ok("next"); // standings
    hs = await host.waitFor((v) => v.screen.kind === "standings", "standings");
    assert.equal(hs.host.next.action, "ask");
    assert.equal(hs.host.next.qid, "tb");
    await host.ok("next"); // tie-breaker
    const tb = await x.waitFor((v) => v.screen.kind === "question" && v.question.qid === "tb", "tb asked");
    assert.equal(tb.question.type, "number");
    const bad = await x.emit("answer", { qid: "tb", text: "around 1970" });
    assert.equal(bad.ok, false, "a tie-breaker answer must be a number");
    await x.ok("answer", { qid: "tb", text: "1971" });
    await y.ok("answer", { qid: "tb", text: "1965" });
    await host.ok("next"); // close
    await host.ok("next"); // reveal
    hs = await host.waitFor((v) => v.screen.kind === "answer" && v.question.qid === "tb", "tb revealed");
    assert.equal(hs.host.next.action, "finish");
    await host.ok("next");
    const over = await x.waitFor((v) => v.screen.kind === "over", "over");
    assert.deepEqual(
      over.standings.rows.map((r) => [r.name, r.place, r.byTiebreak === true]),
      [
        ["Xenon", 1, true],
        ["Yttrium", 2, true],
      ],
    );
  });

  test("answers after the round: the next button holds answers back, then shows them together", async () => {
    const { host, teams } = await setupRoom(server, ["Solo"], { settings: { revealMode: "round" }, spec: smallSpec({ rounds: 1, perRound: 2, final: false, tiebreaker: false }) });
    await host.ok("start");
    await host.ok("next"); // q1
    await host.ok("next"); // close
    let hs = await host.waitFor((v) => v.screen.kind === "question" && !v.timer.open, "q1 closed");
    assert.equal(hs.host.next.action, "ask", "no reveal after each question");
    await host.ok("next"); // q2
    await host.ok("next"); // close
    hs = await host.waitFor((v) => v.screen.kind === "question" && v.question.qid === "r1q2" && !v.timer.open, "q2 closed");
    assert.equal(hs.host.next.action, "revealRound");
    await host.ok("next");
    const ra = await teams[0].waitFor((v) => v.screen.kind === "roundAnswers", "round answers");
    assert.equal(ra.roundAnswers.items.length, 2);
    assert.ok(ra.roundAnswers.items.every((i) => i.answer));
    hs = await host.waitFor((v) => v.host.next?.action === "standings", "then standings");
    await host.ok("next");
    hs = await host.waitFor((v) => v.host.next?.action === "finish", "then finish");
  });

  test("pause freezes the answer timer; resume picks it up", async () => {
    const { host } = await setupRoom(server, ["Pausers"], { spec: smallSpec({ rounds: 1, perRound: 1 }) });
    await host.ok("start");
    await host.ok("next");
    let hs = await host.waitFor((v) => v.timer?.open && v.timer.closesAt, "timer running");
    await host.ok("setPaused", true);
    hs = await host.waitFor((v) => v.paused, "paused");
    assert.equal(hs.timer.closesAt, undefined);
    assert.ok(hs.timer.remainingMs > 50_000 && hs.timer.remainingMs <= 60_000);
    const twice = await host.emit("setPaused", true);
    assert.equal(twice.ok, false);
    await host.ok("setPaused", false);
    hs = await host.waitFor((v) => !v.paused && v.timer?.closesAt, "resumed");
    assert.ok(hs.timer.closesAt - hs.serverTime > 50_000);
  });

  test("teams can't run the night", async () => {
    const { teams } = await setupRoom(server, ["Rascals"]);
    for (const ev of ["start", "next", "standings", "finish"]) {
      const r = await teams[0].emit(ev);
      assert.equal(r.ok, false, ev);
      assert.match(r.error, /host or a co-host/);
    }
    const r = await teams[0].emit("mark", { qid: "r1q1", teamId: teams[0].state.you.teamId, correct: true });
    assert.equal(r.ok, false);
  });
});
