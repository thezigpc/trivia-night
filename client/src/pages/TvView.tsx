import { JoinBox } from "@bargames/gamekit/client";
import { joinDisplay, type VenueContext } from "@bargames/sdk/client";
import type { RoomView, StandingRow } from "@trivia/shared";
import { fmtScore, ordinal, Picture, Qr, TimerRing } from "../components/bits";

const LETTERS = "ABCDEF";

/** Question text size by length: short questions fill the screen, long ones still fit. */
const textSize = (s: string) => (s.length < 70 ? "tv-q-xl" : s.length < 140 ? "tv-q-l" : s.length < 240 ? "tv-q-m" : "tv-q-s");

/**
 * The TV (the box's table route). Seen from across the room: big text, no hover, no buttons;
 * the host or a co-host (or the box's iPad) moves it from screen to screen.
 */
export function TvView({
  view,
  skew,
  gameName,
  venue,
  onBox,
}: {
  view: RoomView;
  skew: number;
  gameName: string;
  venue: VenueContext | null;
  onBox: boolean;
}) {
  const phones = view.settings.mode === "phones";
  const s = view.screen;
  const join = joinDisplay(venue, `/join/${view.code}`, view.code);
  const logo = onBox ? venue?.game.theme.logoUrl : undefined;
  const q = view.question;

  const header = (
    <header className="tv-top">
      <div className="tv-brand" hidden={s.kind === "lobby"}>
        {logo && <img className="tv-logo" src={logo} alt="" />}
        <span className="tv-name">{gameName}</span>
      </div>
      <div className="tv-where">
        {q && (s.kind === "question" || s.kind === "answer") && (
          <span>
            {q.round >= 0 ? `Round ${q.round + 1} · Question ${q.number} of ${view.plan.rounds[q.round]?.count ?? "?"}` : q.roundTitle}
          </span>
        )}
        {phones && s.kind !== "lobby" && (
          <span className="tv-code" aria-label="Room code">
            {view.code}
          </span>
        )}
      </div>
    </header>
  );

  let body: JSX.Element;
  switch (s.kind) {
    case "lobby":
      body = (
        <div className={`tv-lobby ${phones ? "" : "tv-lobby-paper"}`}>
          <div className="tv-lobby-main">
            <h1 className="tv-title">{view.title || gameName}</h1>
            {phones ? (
              <p className="tv-sub">Join with your phone: one phone per team.</p>
            ) : (
              <p className="tv-sub">Grab an answer card and a pen. Write your team name at the top!</p>
            )}
            <div className="tv-plan">
              {view.plan.rounds.map((r, i) => (
                <span key={i}>
                  Round {i + 1}: {r.title}
                </span>
              ))}
              {view.plan.hasFinal && <span>Final: wager round</span>}
            </div>
            {view.teams.length > 0 && (
              <div className="tv-teams">
                <span className="tv-teams-label">{view.teams.length} team{view.teams.length === 1 ? "" : "s"} in:</span>
                {view.teams.map((t) => (
                  <span key={t.id} className="tv-chip">
                    {t.name}
                  </span>
                ))}
              </div>
            )}
          </div>
          {phones && (
            <div className="tv-join">
              <JoinBox
                qr={<Qr url={join.url} size={480} className="tv-qr" />}
                url={join.roomShort ?? join.short}
                code={<span className="tv-join-code">{view.code}</span>}
              />
            </div>
          )}
        </div>
      );
      break;

    case "intro": {
      const r = view.plan.rounds[s.round];
      body = (
        <div className="tv-center">
          <p className="tv-kicker">Round {s.round + 1}</p>
          <h1 className="tv-hero">{r?.title}</h1>
          <p className="tv-sub">
            {r?.count} question{r?.count === 1 ? "" : "s"}
            {phones ? ": answer on your team's phone" : ": write your answers on the card"}
          </p>
        </div>
      );
      break;
    }

    case "question":
    case "answer": {
      if (!q) {
        body = <div className="tv-center" />;
        break;
      }
      const revealed = s.kind === "answer" && q.answer !== undefined;
      body = (
        <div className={`tv-question ${q.image ? "with-pic" : ""}`}>
          <div className="tv-q-main">
            <p className="tv-kicker">
              {q.round === -1 ? "Final question" : q.round === -2 ? "Tie-breaker: closest wins" : q.category || q.roundTitle}
              {q.points !== 1 && q.round >= 0 ? ` · ${fmtScore(q.points)} points` : ""}
            </p>
            <h2 className={`tv-q-text ${textSize(q.text)} ${revealed ? "dim" : ""}`}>{q.text}</h2>
            {q.choices.length > 0 && (
              <ol className={`tv-choices n${q.choices.length}`}>
                {q.choices.map((c, i) => (
                  <li key={c} className={revealed ? (c === q.answer ? "right" : "wrong") : ""}>
                    <span className="letter">{q.type === "truefalse" ? "" : LETTERS[i]}</span>
                    <span>{c}</span>
                  </li>
                ))}
              </ol>
            )}
            {revealed && (
              <div className="tv-answer">
                <span className="tv-answer-label">Answer</span>
                <span className="tv-answer-text">{q.answer}</span>
                {view.answerStats && (
                  <span className="tv-answer-stats">
                    {view.answerStats.correct} of {view.answerStats.of} team{view.answerStats.of === 1 ? "" : "s"} got it
                  </span>
                )}
              </div>
            )}
          </div>
          {q.image && <Picture image={q.image} className="tv-picture" />}
          {!revealed && phones && view.timer && (
            <div className="tv-timer">
              {view.timer.open ? (
                <>
                  <TimerRing timer={view.timer} skew={skew} paused={view.paused} />
                  <span className="tv-answered">
                    {view.answered} of {view.teams.length} answered
                  </span>
                </>
              ) : (
                <span className="tv-closed-tag">Answers closed</span>
              )}
            </div>
          )}
        </div>
      );
      break;
    }

    case "roundAnswers": {
      const ra = view.roundAnswers;
      const n = ra?.items.length ?? 0;
      body = (
        <div className="tv-round-answers">
          <h2 className="tv-section">Round {(ra?.round ?? 0) + 1} answers{ra?.title ? `: ${ra.title}` : ""}</h2>
          <ol className={`tv-ra-list ${n > 8 ? "two-col" : ""} ${n > 16 ? "dense" : ""}`}>
            {ra?.items.map((it) => (
              <li key={it.number}>
                <span className="ra-num">{it.number}</span>
                <span className="ra-q">{it.text}</span>
                <span className="ra-a">{it.answer}</span>
              </li>
            ))}
          </ol>
        </div>
      );
      break;
    }

    case "standings":
      body = <StandingsBoard label={view.standings?.label ?? "Scores"} rows={view.standings?.rows ?? []} />;
      break;

    case "wager":
      body = (
        <div className="tv-center">
          <p className="tv-kicker">Final round</p>
          <h1 className="tv-hero">{view.wager?.category}</h1>
          <p className="tv-sub">
            {phones ? "Wager up to your score on your phone." : "Write your wager on your card: up to your score."} Right: you win it. Wrong: you lose it.
          </p>
          {phones && view.wager && (
            <p className="tv-sub">
              {view.wager.teamsIn} of {view.teams.length} team{view.teams.length === 1 ? "" : "s"} have wagered
            </p>
          )}
        </div>
      );
      break;

    case "over": {
      const rows = view.standings?.rows ?? [];
      const winners = rows.filter((r) => r.place === 1);
      body = (
        <div className="tv-over">
          <p className="tv-kicker">{winners.length > 1 ? "Tonight's winners" : "Tonight's winner"}</p>
          <h1 className="tv-hero tv-winner">{winners.map((w) => w.name).join(" & ") || "Thanks for playing!"}</h1>
          {winners[0] && <p className="tv-sub">{fmtScore(winners[0].score)} point{winners[0].score === 1 ? "" : "s"}</p>}
          <StandingsBoard label="Final scores" rows={rows} compact />
        </div>
      );
      break;
    }
  }

  return (
    <div className={`tv screen-${s.kind}`}>
      {header}
      <div className="tv-body">{body}</div>
      {view.paused && (
        <div className="tv-paused" role="status">
          <span>Paused</span>
        </div>
      )}
    </div>
  );
}

/** The scoreboard: top three highlighted; as many rows as fit (two columns for a big night). */
function StandingsBoard({ label, rows, compact }: { label: string; rows: StandingRow[]; compact?: boolean }) {
  const max = compact ? 10 : 20;
  const shown = rows.slice(0, max);
  return (
    <div className={`tv-standings ${compact ? "compact" : ""}`}>
      {!compact && <h2 className="tv-section">{label}</h2>}
      {rows.length === 0 ? (
        <p className="tv-sub">No teams yet.</p>
      ) : (
        <ol className={`tv-rows ${shown.length > 10 ? "two-col" : ""}`}>
          {shown.map((r) => (
            <li key={r.teamId} className={`place-${r.place <= 3 ? r.place : "n"}`}>
              <span className="st-place">{ordinal(r.place)}</span>
              <span className="st-name">
                {r.name}
                {r.byTiebreak && <span className="st-tb" title="Placed by the tie-breaker"> ★</span>}
              </span>
              <span className="st-score">{fmtScore(r.score)}</span>
            </li>
          ))}
        </ol>
      )}
      {rows.length > max && <p className="tv-more">…and {rows.length - max} more</p>}
    </div>
  );
}
