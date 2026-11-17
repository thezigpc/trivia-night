import { useEffect, useState, type FormEvent } from "react";
import type { RoomView } from "@trivia/shared";
import { fmtScore, ordinal, Picture, TimerRing, NumInput } from "../components/bits";
import type { Act } from "./RoomPage";

const LETTERS = "ABCDEF";

/** A team's phone (phones mode): the question, the answer box, the timer, the team's score. */
export function TeamView({ view, skew, act }: { view: RoomView; skew: number; act: Act }) {
  const s = view.screen;
  const q = view.question;
  const mine = view.mine ?? {};
  const open = !!view.timer?.open && !!q && s.kind === "question";
  const [draft, setDraft] = useState("");
  const [wager, setWager] = useState("");
  const qid = q?.qid;
  useEffect(() => setDraft(""), [qid]);

  const send = async (text: string) => {
    if (!q || !text.trim()) return;
    const r = await act("answer", { qid: q.qid, text: text.trim() });
    if (r) setDraft("");
  };
  const submitText = (e: FormEvent) => {
    e.preventDefault();
    void send(draft);
  };
  const sendWager = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act("submitWager", Number(wager));
    if (r) setWager("");
  };

  const scoreLine =
    mine.score !== undefined ? (
      <p className="team-score">
        {view.standings?.label}: <strong>{ordinal(mine.place ?? 0)}</strong> with <strong>{fmtScore(mine.score)}</strong>
      </p>
    ) : null;

  let body: JSX.Element;
  if (!view.started || s.kind === "lobby") {
    body = (
      <div className="panel center">
        <h2>You're in as {view.you.name}</h2>
        <p className="muted">{view.started ? "Back soon: watch the TV." : "Watch the TV: the host will start soon. Answer every question from this phone."}</p>
        {scoreLine}
        <div className="chips">
          {view.teams.map((t) => (
            <span key={t.id} className={`chip ${t.id === view.you.teamId ? "chip-me" : ""}`}>
              {t.name}
            </span>
          ))}
        </div>
      </div>
    );
  } else if (s.kind === "intro") {
    const r = view.plan.rounds[s.round];
    body = (
      <div className="panel center">
        <p className="kicker">Round {s.round + 1}</p>
        <h2 className="big">{r?.title}</h2>
        <p className="muted">{r?.count} questions. Get ready!</p>
        {scoreLine}
      </div>
    );
  } else if ((s.kind === "question" || s.kind === "answer") && q) {
    const sent = mine.answer?.qid === q.qid ? mine.answer : undefined;
    const revealed = s.kind === "answer" && q.answer !== undefined;
    body = (
      <div className="panel team-q">
        <div className="team-q-head">
          <span className="kicker">
            {q.round >= 0 ? `Round ${q.round + 1} · Q${q.number}` : q.roundTitle}
            {q.category && q.round >= 0 ? ` · ${q.category}` : ""}
          </span>
          {open && <TimerRing timer={view.timer} skew={skew} paused={view.paused} />}
        </div>
        <h2 className="team-q-text">{q.text}</h2>
        <Picture image={q.image} />
        {revealed ? (
          <div className={`verdict ${sent ? (sent.correct ? "ok" : "no") : ""}`}>
            <p>
              Answer: <strong>{q.answer}</strong>
            </p>
            {sent ? (
              <p>
                You said “{sent.text}”: {sent.correct ? "right! ✓" : "not this time ✗"}
              </p>
            ) : (
              <p className="muted">Your team didn't answer.</p>
            )}
          </div>
        ) : open ? (
          <>
            {q.type === "choice" || q.type === "truefalse" ? (
              <div className={`choice-btns n${q.choices.length}`}>
                {q.choices.map((c, i) => (
                  <button key={c} className={`btn choice ${sent?.text === c ? "picked" : ""}`} onClick={() => void send(c)}>
                    {q.type === "choice" && <span className="letter">{LETTERS[i]}</span>}
                    {c}
                  </button>
                ))}
              </div>
            ) : (
              <form className="answer-form" onSubmit={submitText}>
                {q.type === "number" ? (
                  <NumInput decimal value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="A number" maxLength={20} autoFocus />
                ) : (
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Your answer"
                    inputMode="text"
                    maxLength={200}
                    autoComplete="off"
                    autoFocus
                  />
                )}
                <button className="btn btn-primary" disabled={!draft.trim()}>
                  {sent ? "Change" : "Send"}
                </button>
              </form>
            )}
            {sent && (
              <p className="sent">
                Sent: <strong>{sent.text}</strong>. You can change it until time's up.
              </p>
            )}
          </>
        ) : (
          <p className="muted">{sent ? <>Answers are closed. You said <strong>{sent.text}</strong>.</> : view.paused ? "Paused." : "Answers are closed."}</p>
        )}
      </div>
    );
  } else if (s.kind === "wager") {
    body = (
      <div className="panel center">
        <p className="kicker">Final round</p>
        <h2 className="big">{view.wager?.category}</h2>
        {view.wager?.open ? (
          <form className="answer-form" onSubmit={sendWager}>
            <NumInput
              value={wager}
              onChange={(e) => setWager(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder={`0 to ${fmtScore(mine.maxWager ?? 0)}`}
              decimal
              maxLength={8}
              autoComplete="off"
            />
            <button className="btn btn-primary" disabled={wager === ""}>
              {mine.wager !== undefined ? "Change wager" : "Wager"}
            </button>
          </form>
        ) : (
          <p className="muted">Wagers are closed.</p>
        )}
        <p className="muted small">Wager up to your score ({fmtScore(mine.maxWager ?? 0)}). Right: you win it. Wrong: you lose it.</p>
        {mine.wager !== undefined && (
          <p className="sent">
            Your wager: <strong>{fmtScore(mine.wager)}</strong>
          </p>
        )}
      </div>
    );
  } else if (s.kind === "over") {
    body = (
      <div className="panel center">
        <h2>That's the night!</h2>
        {mine.place !== undefined ? (
          <p className="big">
            {view.you.name} finished {ordinal(mine.place)} with {fmtScore(mine.score ?? 0)} points.
          </p>
        ) : null}
        <Standings view={view} />
      </div>
    );
  } else if (s.kind === "standings") {
    body = (
      <div className="panel">
        {scoreLine}
        <Standings view={view} />
      </div>
    );
  } else {
    body = (
      <div className="panel center">
        <p className="muted">Answers are on the TV.</p>
        {scoreLine}
      </div>
    );
  }

  return (
    <main className="team-view">
      {view.paused && <div className="banner">Paused: back soon.</div>}
      {body}
    </main>
  );
}

function Standings({ view }: { view: RoomView }) {
  const rows = view.standings?.rows ?? [];
  return (
    <ol className="standings-list">
      {rows.map((r) => (
        <li key={r.teamId} className={r.teamId === view.you.teamId ? "me" : ""}>
          <span>{ordinal(r.place)}</span>
          <span>{r.name}</span>
          <span>{fmtScore(r.score)}</span>
        </li>
      ))}
    </ol>
  );
}
