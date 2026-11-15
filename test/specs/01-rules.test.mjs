// The pure rules: answer matching, pack parsing (CSV and JSON), team-name keys.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkAnswer,
  normalizeAnswer,
  packToCsv,
  parseCsv,
  parsePack,
  teamKey,
  cleanTeamName,
  summarizePack,
} from "@trivia/shared";

const open = (answer, accept = []) => ({ type: "open", answer, accept });

describe("answers", () => {
  test("normalizing drops case, accents, punctuation and a leading article", () => {
    assert.equal(normalizeAnswer("  The Beatles! "), "beatles");
    assert.equal(normalizeAnswer("Pokémon"), "pokemon");
    assert.equal(normalizeAnswer("Rock & Roll"), "rock and roll");
    assert.equal(normalizeAnswer("Mt. Everest"), "mt everest");
    assert.equal(normalizeAnswer("2.5"), "2.5");
  });

  test("exact and accepted answers are right; near-misses are close; others wrong", () => {
    const lincoln = open("Abraham Lincoln", ["Abe Lincoln"]);
    assert.equal(checkAnswer(lincoln, "abraham lincoln"), "correct");
    assert.equal(checkAnswer(lincoln, "Abe Lincoln"), "correct");
    assert.equal(checkAnswer(lincoln, "Lincoln"), "close");
    assert.equal(checkAnswer(lincoln, "Abraham Lincon"), "close");
    assert.equal(checkAnswer(lincoln, "George Washington"), "wrong");
    assert.equal(checkAnswer(lincoln, ""), "wrong");
    assert.equal(checkAnswer(open("Mount Everest"), "Mount Fuji"), "wrong");
    // Short answers need to be exact: one letter off is another word.
    assert.equal(checkAnswer(open("Au"), "Ag"), "wrong");
  });

  test("multiple choice, true/false and numbers are exact", () => {
    assert.equal(checkAnswer({ type: "choice", answer: "Ottawa", accept: [] }, "Ottawa"), "correct");
    assert.equal(checkAnswer({ type: "choice", answer: "Ottawa", accept: [] }, "Ottowa"), "wrong");
    assert.equal(checkAnswer({ type: "truefalse", answer: "True", accept: [] }, "False"), "wrong");
    assert.equal(checkAnswer({ type: "number", answer: "1969", accept: [] }, "1,969"), "correct");
    assert.equal(checkAnswer({ type: "number", answer: "1969", accept: [] }, "1968"), "wrong");
  });
});

describe("packs", () => {
  test("CSV with quotes, commas, newlines, a BOM and CRLF", () => {
    const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\r\n');
    assert.deepEqual(rows, [
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
    ]);
  });

  test("a CSV pack: types inferred, choices by letter, problems reported by row", () => {
    const csv = [
      "question,answer,accept,type,choices,category,points,image,note,use",
      "Capital of France?,Paris,,,,Geo,1,,,",
      "Pick the even number,B,,,1|2|3,Maths,2,,,",
      "Bats are mammals,true,,,,,,,,",
      "Moon landing year?,1969,,,,,,,,tiebreaker",
      ",No question,,,,,,,,",
      "Bad choice,Z,,choice,a|b,,,,,",
      "Bad points,x,,,,,lots,,,",
      "Bad picture,x,,,,,,javascript:alert(1),,",
    ].join("\n");
    const p = parsePack(csv);
    assert.equal(p.questions.length, 4);
    const [paris, even, bats, moon] = p.questions;
    assert.equal(paris.type, "open");
    assert.equal(paris.category, "Geo");
    assert.equal(even.type, "choice");
    assert.equal(even.answer, "2");
    assert.equal(even.points, 2);
    assert.equal(bats.type, "truefalse");
    assert.equal(bats.answer, "True");
    assert.deepEqual(bats.choices, ["True", "False"]);
    assert.equal(moon.type, "number");
    assert.equal(moon.use, "tiebreaker");
    assert.equal(p.errors.length, 4);
    assert.match(p.errors[0], /^Row 6: the question is empty/);
    assert.match(p.errors[1], /^Row 7: the answer "Z" isn't one of the choices/);
    assert.match(p.errors[2], /^Row 8: points must be a number/);
    assert.match(p.errors[3], /^Row 9: the picture must be/);
  });

  test("a JSON pack, and CSV round-trips through packToCsv", () => {
    const json = JSON.stringify({
      name: "Pub Pack",
      questions: [
        { question: "Q1", answer: "A1", accept: ["a one"], category: "C", note: "say it slowly" },
        { question: "Q2, with a comma", answer: "Yes", type: "choice", choices: ["Yes", "No"] },
        { question: "Final?", answer: "F", use: "final" },
      ],
    });
    const p = parsePack(json);
    assert.equal(p.name, "Pub Pack");
    assert.deepEqual(p.errors, []);
    const again = parsePack(packToCsv(p));
    assert.deepEqual(again.errors, []);
    assert.deepEqual(
      again.questions.map(({ id, ...q }) => q),
      p.questions.map(({ id, ...q }) => q),
    );
    const s = summarizePack({ id: "x", name: "Pub Pack", questions: p.questions, updatedAt: 0 });
    assert.equal(s.count, 2);
    assert.equal(s.finals, 1);
  });

  test("a tie-breaker must be a number; junk is refused with a reason", () => {
    assert.match(parsePack("question,answer,use\nWho?,Me,tiebreaker").errors[0] ?? "", /must be a number/);
    assert.match(parsePack("{nope").errors[0], /isn't valid JSON/);
    assert.match(parsePack("just,a,header").errors[0], /header row and at least one question/);
    assert.match(parsePack("").errors[0], /empty/);
  });

  test("the sample pack is valid: four rounds, a final, a tie-breaker, pictures", () => {
    const raw = readFileSync(new URL("../../server/assets/sample-pack.json", import.meta.url), "utf8");
    const p = parsePack(raw);
    assert.deepEqual(p.errors, []);
    const s = summarizePack({ id: "sample", name: p.name, questions: p.questions, updatedAt: 0 });
    assert.deepEqual(
      s.categories.map((c) => c.name),
      ["General Knowledge", "Science & Nature", "Geography", "Pictures"],
    );
    assert.equal(s.finals, 1);
    assert.equal(s.tiebreakers, 1);
    assert.equal(s.pictures, 4);
  });
});

describe("team names", () => {
  test("the same team ignoring case and spacing; names tidied", () => {
    assert.equal(teamKey("Quiz Khalifa"), teamKey("quiz  khalifa"));
    assert.equal(teamKey("QuizKhalifa"), teamKey("Quiz Khalifa"));
    assert.notEqual(teamKey("Quiz Khalifa"), teamKey("Quiz Khalifa 2"));
    assert.equal(cleanTeamName("  The   Know-It-Alls \n"), "The Know-It-Alls");
    assert.equal(cleanTeamName("x".repeat(50)).length, 32);
  });
});
