import { useEffect, useMemo, useState, type FormEvent } from "react";
import { joinUrl, type VenueContext } from "@bargames/sdk/client";
import {
  FINAL_ID,
  SETTINGS_LIMITS,
  TIEBREAK_ID,
  type HostQuestion,
  type NightSpec,
  type RoomView,
  type Screen,
} from "@trivia/shared";
import { fmtScore, ordinal, Picture, Qr, TeamNameField, useSecondsLeft } from "../components/bits";
import { NightBuilder } from "../components/NightBuilder";
import { useConfig } from "../config";
import { basePath } from "@bargames/gamekit/client";
import type { Act } from "./RoomPage";

type Tab = "run" | "scores" | "teams" | "setup";

/** What the TV shows, in words, for the console's status line. */
function describe(view: RoomView, screen: Screen): string {
  const h = view.host!;
  const q = (qid: string) =>
    qid === FINAL_ID ? "the final question" : qid === TIEBREAK_ID ? "the tie-breaker" : (() => {
      const m = /^r(\d+)q(\d+)$/.exec(qid);
      return m ? `round ${m[1]}, question ${m[2]}` : qid;
    })();
  switch (screen.kind) {
    case "lobby":
      return view.settings.mode === "phones" ? "The welcome screen with the join QR code" : "The welcome screen";
    case "intro":
      return `Round ${screen.round + 1}'s title: ${h.rounds[screen.round]?.title ?? ""}`;
    case "question":
      return `Showing ${q(screen.qid)}`;
    case "answer":
      return `The answer to ${q(screen.qid)}`;
    case "roundAnswers":
      return `All of round ${screen.round + 1}'s answers`;
    case "standings":
      return `The scores (${view.standings?.label ?? ""})`;
    case "wager":
      return "The final's category: wagers";
    case "over":
      return "Final scores and the winner";
  }
}

export function HostConsole({ view, skew, act, venue }: { view: RoomView; skew: number; act: Act; venue: VenueContext | null }) {
  const h = view.host!;
  const isHost = view.you.role === "host";
  const [tab, setTab] = useState<Tab>(view.started ? "run" : "setup");
  // Starting the night brings up the questions (setup is done by then).
  useEffect(() => {
    if (view.started) setTab((t) => (t === "setup" ? "run" : t));
  }, [view.started]);
  const left = useSecondsLeft(view.timer, skew);
  const tvLink = `${location.origin}${basePath()}/room/${view.code}?role=table`;
  const phones = view.settings.mode === "phones";

  return (
    <main className="console">
      <section className="panel now">
        <div className="now-line">
          <span className="muted small">On the TV</span>
          <strong>{describe(view, view.screen)}</strong>
          {view.paused && <span className="badge badge-warn">Paused</span>}
        </div>
        {view.timer?.open && (
          <div className="now-timer">
            ⏱ {left ?? "–"} s · {view.answered} of {view.teams.length} answered
            {h.next?.action !== "close" && (
              <button className="btn btn-small" onClick={() => act("close")}>
                Close answers
              </button>
            )}
          </div>
        )}
        <div className="now-actions">
          {h.next && (
            <button className="btn btn-primary btn-big next-btn" onClick={() => act("next")}>
              ▶ {h.next.label}
            </button>
          )}
          {view.started && !view.finished && (
            <>
              <button className="btn" onClick={() => act("standings")}>
                Send scores to TV
              </button>
              <button className="btn btn-ghost" onClick={() => act("setPaused", !view.paused)}>
                {view.paused ? "Resume" : "Pause"}
              </button>
              <button className="btn btn-ghost" onClick={() => act("showLobby")}>
                Welcome screen
              </button>
            </>
          )}
          <a className="btn btn-ghost" href={tvLink} target="_blank" rel="noreferrer" title="Open the TV screen in a new tab (cast or full-screen it)">
            📺 Open TV screen
          </a>
        </div>
        {h.tableCount === 0 && <p className="muted small">No TV screen is showing this room yet. Open the TV screen on the TV's browser, or cast it.</p>}
      </section>

      <nav className="tabs" role="tablist">
        {(["run", "scores", "teams", "setup"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
            {t === "run" ? "Questions" : t === "scores" ? "Scores" : t === "teams" ? `Teams (${view.teams.length})` : "Setup"}
          </button>
        ))}
      </nav>

      {tab === "run" && <RunTab view={view} act={act} />}
      {tab === "scores" && <ScoresTab view={view} act={act} />}
      {tab === "teams" && <TeamsTab view={view} act={act} venue={venue} isHost={isHost} phones={phones} />}
      {tab === "setup" && <SetupTab view={view} act={act} />}

      {isHost && (
        <section className="panel danger-zone">
          {view.started && !view.finished && (
            <button
              className="btn"
              onClick={() => window.confirm("Finish the night now? Final scores go up on the TV and to the venue's leaderboard.") && act("finish")}
            >
              Finish the night
            </button>
          )}
          <button className="btn btn-danger" onClick={() => window.confirm("Close this room for everyone?") && act("closeRoom")}>
            Close the room
          </button>
        </section>
      )}
    </main>
  );
}

// ------------------------------------------------------------- questions

function RunTab({ view, act }: { view: RoomView; act: Act }) {
  const h = view.host!;
  const s = view.screen;
  const onTv = s.kind === "question" || s.kind === "answer" ? s.qid : null;
  const [open, setOpen] = useState<Set<string>>(() => new Set(onTv ? [onTv] : []));
  useEffect(() => {
    if (onTv) setOpen((o) => (o.has(onTv) ? o : new Set([...o, onTv])));
  }, [onTv]);
  const toggle = (qid: string) => setOpen((o) => (o.has(qid) ? new Set([...o].filter((x) => x !== qid)) : new Set([...o, qid])));

  return (
    <section className="run">
      {h.rounds.map((r, ri) => (
        <div key={ri} className="panel round-block">
          <div className="round-head">
            <h3>
              Round {ri + 1}: {r.title}
            </h3>
            <div className="round-actions">
              <button className="btn btn-small" disabled={!view.started || view.finished} onClick={() => act("intro", ri)}>
                Show title
              </button>
              <button className="btn btn-small" disabled={!view.started || view.finished || !r.questions.some((q) => q.asked)} onClick={() => act("revealRound", ri)}>
                Show all answers
              </button>
            </div>
          </div>
          <ol className="q-list">
            {r.questions.map((q) => (
              <QuestionRow key={q.qid} q={q} view={view} act={act} onTv={onTv === q.qid} expanded={open.has(q.qid)} onToggle={() => toggle(q.qid)} />
            ))}
          </ol>
        </div>
      ))}
      {h.final && (
        <div className="panel round-block">
          <div className="round-head">
            <h3>Final: wager round</h3>
            <div className="round-actions">
              <button className="btn btn-small" disabled={!view.started || view.finished || h.final.asked} onClick={() => act("wager")}>
                Take wagers
              </button>
            </div>
          </div>
          <Wagers view={view} act={act} />
          <ol className="q-list">
            <QuestionRow q={h.final} view={view} act={act} onTv={onTv === FINAL_ID} expanded={open.has(FINAL_ID)} onToggle={() => toggle(FINAL_ID)} />
          </ol>
        </div>
      )}
      {h.tiebreak && (
        <div className="panel round-block">
          <div className="round-head">
            <h3>Tie-breaker (closest wins)</h3>
          </div>
          <ol className="q-list">
            <QuestionRow q={h.tiebreak} view={view} act={act} onTv={onTv === TIEBREAK_ID} expanded={open.has(TIEBREAK_ID)} onToggle={() => toggle(TIEBREAK_ID)} />
          </ol>
        </div>
      )}
    </section>
  );
}

function QuestionRow({
  q,
  view,
  act,
  onTv,
  expanded,
  onToggle,
}: {
  q: HostQuestion;
  view: RoomView;
  act: Act;
  onTv: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const h = view.host!;
  const can = view.started && !view.finished;
  const marks = h.marks[q.qid] ?? {};
  const right = Object.entries(marks).filter(([t, ok]) => ok && view.teams.some((x) => x.id === t)).length;
  const answered = Object.keys(h.answers[q.qid] ?? {}).length;
  const label = q.round >= 0 ? `${q.number}` : q.qid === FINAL_ID ? "F" : "TB";
  return (
    <li className={`q-row ${onTv ? "on-tv" : ""} ${q.asked ? "asked" : ""}`}>
      <div className="q-line">
        <button className="q-toggle" onClick={onToggle} aria-expanded={expanded} aria-label={`Question ${label}: mark answers`}>
          <span className="q-num">{label}</span>
          <span className="q-text">
            {q.text}
            {q.image && " 🖼"}
          </span>
          <span className="q-ans">{q.answer}</span>
          <span className="q-state">
            {q.revealed ? "✓ shown" : q.asked ? "asked" : ""}
            {(q.asked || right > 0) && view.teams.length > 0 && (
              <span className="muted">
                {" "}
                {right}/{view.teams.length}
              </span>
            )}
          </span>
        </button>
        <div className="q-btns">
          <button className="btn btn-small" disabled={!can} onClick={() => act("ask", q.qid)}>
            {onTv && view.screen.kind === "question" ? "On TV" : "Show"}
          </button>
          <button className="btn btn-small" disabled={!can} onClick={() => act("reveal", q.qid)}>
            Answer
          </button>
        </div>
      </div>
      {expanded && (
        <div className="q-detail">
          <div className="q-meta">
            <span>
              Answer: <strong>{q.answer}</strong>
              {q.accept.length > 0 && <span className="muted"> (also: {q.accept.join(", ")})</span>}
            </span>
            {q.choices.length > 0 && q.type === "choice" && <span className="muted">Choices: {q.choices.join(" · ")}</span>}
            <span className="muted">
              {q.category && `${q.category} · `}
              {fmtScore(q.points)} pt{q.points === 1 ? "" : "s"}
              {view.settings.mode === "phones" && ` · ${answered} answered`}
            </span>
            {q.note && <span className="host-note">Note: {q.note}</span>}
          </div>
          <Picture image={q.image} className="q-thumb" />
          <MarkList q={q} view={view} act={act} />
        </div>
      )}
    </li>
  );
}

/** Each team's answer (phones) and ✓/✗ (the final say; on paper, from the cards). */
function MarkList({ q, view, act }: { q: HostQuestion; view: RoomView; act: Act }) {
  const h = view.host!;
  const marks = h.marks[q.qid] ?? {};
  const answers = h.answers[q.qid] ?? {};
  const needsNumber = q.qid === TIEBREAK_ID;
  if (!view.teams.length) return <p className="muted small">No teams yet.</p>;
  return (
    <table className="marks">
      <tbody>
        {view.teams.map((t) => {
          const a = answers[t.id];
          const m = marks[t.id];
          return (
            <tr key={t.id} className={a?.verdict === "close" && m !== true ? "close" : ""}>
              <th>{t.name}</th>
              <td className="m-answer">
                {needsNumber ? (
                  <GuessInput value={a?.text ?? ""} disabled={!view.started} onSave={(text) => act("setAnswerFor", { teamId: t.id, qid: q.qid, text })} />
                ) : a ? (
                  <>
                    “{a.text}”{a.verdict === "close" && <span className="badge badge-warn">close?</span>}
                  </>
                ) : (
                  <span className="muted">{view.settings.mode === "phones" ? "no answer" : ""}</span>
                )}
              </td>
              {!needsNumber && (
                <td className="m-btns">
                  <button
                    className={`mk ok ${m === true ? "on" : ""}`}
                    disabled={!view.started}
                    onClick={() => act("mark", { qid: q.qid, teamId: t.id, correct: true })}
                    aria-label={`${t.name} right`}
                    aria-pressed={m === true}
                  >
                    ✓
                  </button>
                  <button
                    className={`mk no ${m === false ? "on" : ""}`}
                    disabled={!view.started}
                    onClick={() => act("mark", { qid: q.qid, teamId: t.id, correct: false })}
                    aria-label={`${t.name} wrong`}
                    aria-pressed={m === false}
                  >
                    ✗
                  </button>
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function GuessInput({ value, onSave, disabled }: { value: string; onSave: (v: string) => void; disabled?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className="small-input"
      inputMode="decimal"
      value={v}
      disabled={disabled}
      placeholder="guess"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onSave(v)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function Wagers({ view, act }: { view: RoomView; act: Act }) {
  const h = view.host!;
  if (!view.teams.length) return null;
  return (
    <div className="wagers">
      <p className="muted small">
        Wagers{view.wager?.open ? " (open)" : ""}: up to each team's score before the final.
        {view.settings.mode === "phones" ? " Teams wager on their phones; you can type one in." : " Type each team's wager from its card."}
      </p>
      <table className="marks">
        <tbody>
          {view.teams.map((t) => {
            const before = (h.scores[t.id]?.total ?? 0) - (h.scores[t.id]?.final ?? 0);
            return (
              <tr key={t.id}>
                <th>{t.name}</th>
                <td className="muted small">max {fmtScore(Math.max(0, before))}</td>
                <td>
                  <GuessInput
                    value={h.wagers[t.id] !== undefined ? String(h.wagers[t.id]) : ""}
                    disabled={!view.started || !!h.final?.revealed}
                    onSave={(v) => v !== "" && act("setWagerFor", { teamId: t.id, wager: Number(v) })}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------- scores

function ScoresTab({ view, act }: { view: RoomView; act: Act }) {
  const h = view.host!;
  const rank = useMemo(() => new Map(h.live.map((r) => [r.teamId, r])), [h.live]);
  const teams = [...view.teams].sort((a, b) => (rank.get(a.id)?.place ?? 99) - (rank.get(b.id)?.place ?? 99));
  return (
    <section className="panel scores">
      <div className="scores-head">
        <p className="muted small">
          Live scores (the TV shows them when you send them). Round totals come from the ✓ marks; type a number to set a round's
          total by hand (paper cards), clear it to go back to the marks.
        </p>
        <button className="btn btn-primary" disabled={!view.started || view.finished} onClick={() => act("standings")}>
          Send scores to TV
        </button>
      </div>
      {view.standings && <p className="muted small">On the TV last: {view.standings.label}.</p>}
      <div className="grid-wrap">
        <table className="score-grid">
          <thead>
            <tr>
              <th>#</th>
              <th>Team</th>
              {h.rounds.map((_, i) => (
                <th key={i}>R{i + 1}</th>
              ))}
              {h.final && <th>Final</th>}
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => {
              const sc = h.scores[t.id];
              const r = rank.get(t.id);
              return (
                <tr key={t.id}>
                  <td>{r ? ordinal(r.place) : ""}</td>
                  <th>
                    {t.name}
                    {r?.byTiebreak && " ★"}
                  </th>
                  {h.rounds.map((_, ri) => (
                    <td key={ri}>
                      <ScoreCell
                        value={h.overrides[t.id]?.[ri]}
                        fromMarks={sc?.rounds[ri] ?? 0}
                        disabled={!view.started}
                        onSave={(score) => act("setOverride", { teamId: t.id, round: ri, score })}
                      />
                    </td>
                  ))}
                  {h.final && <td>{fmtScore(sc?.final ?? 0)}</td>}
                  <td className="total">{fmtScore(sc?.total ?? 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!view.teams.length && <p className="muted">No teams yet: {view.settings.mode === "phones" ? "they join from their phones, or add them on the Teams tab." : "add them on the Teams tab."}</p>}
    </section>
  );
}

function ScoreCell({
  value,
  fromMarks,
  onSave,
  disabled,
}: {
  value: number | undefined;
  fromMarks: number;
  onSave: (v: number | null) => void;
  disabled?: boolean;
}) {
  const shown = value !== undefined ? String(value) : "";
  const [v, setV] = useState(shown);
  useEffect(() => setV(shown), [shown]);
  return (
    <input
      className={`score-input ${value !== undefined ? "override" : ""}`}
      inputMode="decimal"
      value={v}
      placeholder={fmtScore(fromMarks)}
      disabled={disabled}
      title={value !== undefined ? "Typed by hand (clear to use the marks)" : "From the marks"}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v === shown) return;
        if (v.trim() === "") onSave(null);
        else if (Number.isFinite(Number(v))) onSave(Number(v));
        else setV(shown);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

// ------------------------------------------------------------- teams & staff

function TeamsTab({ view, act, venue, isHost, phones }: { view: RoomView; act: Act; venue: VenueContext | null; isHost: boolean; phones: boolean }) {
  const h = view.host!;
  const [name, setName] = useState("");
  const [invite, setInvite] = useState<{ url: string; expiresAt: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const r = await act("addTeam", name.trim());
    if (r) setName("");
  };
  const makeInvite = async () => {
    const r = await act<{ path: string; expiresAt: string }>("cohostInvite");
    if (r) setInvite({ url: joinUrl(venue, r.path), expiresAt: r.expiresAt });
  };
  const playUrl = joinUrl(venue, `/join/${view.code}`);
  return (
    <section className="teams-tab">
      {phones && (
        <div className="panel">
          <p>
            Teams join at <strong>{playUrl.replace(/^https?:\/\//, "")}</strong> (code <strong>{view.code}</strong>), or from the QR code on the TV.
          </p>
        </div>
      )}
      <form className="panel add-team" onSubmit={add}>
        <h3>Add a team</h3>
        <p className="muted small">
          {phones ? "For a team without a phone: you mark its answers here." : "Each team with an answer card. Returning teams: pick their usual name, so season standings keep them together."}
        </p>
        <TeamNameField value={name} onChange={setName} exclude={view.teams.map((t) => t.name)} />
        <button className="btn btn-primary" disabled={!name.trim()}>
          Add team
        </button>
      </form>
      <div className="panel">
        <h3>Teams</h3>
        {!view.teams.length && <p className="muted">No teams yet.</p>}
        <ul className="team-list">
          {view.teams.map((t) => (
            <li key={t.id}>
              {phones && <span className={`dot ${t.connected ? "on" : ""}`} title={t.hasPhone ? (t.connected ? "Phone connected" : "Phone offline") : "No phone"} />}
              {editing === t.id ? (
                <form
                  className="inline-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await act("renameTeam", { teamId: t.id, name: newName })) setEditing(null);
                  }}
                >
                  <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={32} autoFocus />
                  <button className="btn btn-small">Save</button>
                  <button type="button" className="btn btn-small btn-ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <span className="team-name">{t.name}</span>
                  {phones && !t.hasPhone && <span className="muted small">no phone</span>}
                  <button
                    className="btn btn-small btn-ghost"
                    onClick={() => {
                      setEditing(t.id);
                      setNewName(t.name);
                    }}
                  >
                    Rename
                  </button>
                  {isHost && (
                    <button className="btn btn-small btn-ghost" onClick={() => window.confirm(`Remove ${t.name} and its scores?`) && act("removeTeam", t.id)}>
                      Remove
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div className="panel">
        <h3>Co-hosts</h3>
        <p className="muted small">A co-host marks answers and runs the screens from their own phone or tablet. Only the host can close the room or remove people.</p>
        <ul className="team-list">
          {h.cohosts.map((c) => (
            <li key={c.memberId}>
              <span className={`dot ${c.connected ? "on" : ""}`} />
              <span className="team-name">{c.name}</span>
              {isHost && (
                <button className="btn btn-small btn-ghost" onClick={() => act("removeCohost", c.memberId)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        {isHost && (
          <>
            <button className="btn" onClick={makeInvite}>
              Add a co-host
            </button>
            {invite && (
              <div className="invite">
                <Qr url={invite.url} size={220} />
                <p className="small">
                  Scan, or open: <a href={invite.url}>{invite.url}</a>
                  <br />
                  <span className="muted">Works once, until {new Date(invite.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</span>
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------- setup

function SetupTab({ view, act }: { view: RoomView; act: Act }) {
  const config = useConfig();
  const [spec, setSpec] = useState<NightSpec>(view.host!.spec);
  const [dirty, setDirty] = useState(false);
  const save = async () => {
    if (await act("setSpec", spec)) setDirty(false);
  };
  return (
    <section className="setup-tab">
      <div className="panel">
        <h3>Settings</h3>
        <div className="setup-row">
          <label>
            Teams answer
            <select value={view.settings.mode} disabled={view.started} onChange={(e) => act("updateSettings", { mode: e.target.value })}>
              <option value="phones">On their phones</option>
              <option value="paper">On paper answer cards</option>
            </select>
          </label>
          <label>
            Answers go up on the TV
            <select value={view.settings.revealMode} onChange={(e) => act("updateSettings", { revealMode: e.target.value })}>
              <option value="each">After each question</option>
              <option value="round">After the round</option>
            </select>
          </label>
          {view.settings.mode === "phones" && (
            <label>
              Seconds to answer
              <input
                type="number"
                min={SETTINGS_LIMITS.timerSeconds.min}
                max={SETTINGS_LIMITS.timerSeconds.max}
                defaultValue={view.settings.timerSeconds}
                onBlur={(e) => Number(e.target.value) !== view.settings.timerSeconds && act("updateSettings", { timerSeconds: Number(e.target.value) })}
              />
            </label>
          )}
        </div>
        {view.started && <p className="muted small">The night has started: phones or paper can't change now.</p>}
      </div>
      <div className="panel">
        <h3>Rounds</h3>
        {view.started ? (
          <ol className="plan-list">
            {view.plan.rounds.map((r, i) => (
              <li key={i}>
                {r.title} ({r.count})
              </li>
            ))}
            {view.plan.hasFinal && <li>Final (wager)</li>}
            {view.plan.hasTiebreak && <li>Tie-breaker ready</li>}
          </ol>
        ) : config ? (
          <>
            <NightBuilder
              packs={config.packs}
              spec={spec}
              onChange={(s) => {
                setSpec(s);
                setDirty(true);
              }}
            />
            <button className="btn btn-primary" disabled={!dirty} onClick={save}>
              Save rounds
            </button>
          </>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </div>
      {!view.started && (
        <div className="panel">
          <h3>Tonight's running order</h3>
          <ol className="plan-list">
            {view.host!.rounds.map((r, i) => (
              <li key={i}>
                {r.title}: {r.questions.length} question{r.questions.length === 1 ? "" : "s"}
              </li>
            ))}
            {view.host!.final && <li>Final: {view.host!.final.category || "wager question"}</li>}
            {view.host!.tiebreak && <li>Tie-breaker ready</li>}
          </ol>
        </div>
      )}
    </section>
  );
}
