import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { SETTINGS_LIMITS, type JoinResult, type Mode, type NightSpec, type RevealMode } from "@trivia/shared";
import { EnterForm, NumInput } from "../components/bits";
import { NightBuilder } from "../components/NightBuilder";
import { useConfig, useGameName } from "../config";
import { call, serverUrl, socket } from "../socket";
import { sessions } from "../session";

/** /host: the coordinator sets up tonight (phones or paper, the rounds) and opens the room. */
export function HostPage() {
  const navigate = useNavigate();
  const gameName = useGameName();
  const config = useConfig();
  const [mode, setMode] = useState<Mode | null>(null);
  const [reveal, setReveal] = useState<RevealMode | null>(null);
  /** The timer as typed (null: the default). Clamped to the allowed range when it's used. */
  const [timer, setTimer] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState<NightSpec | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    socket.connect();
    fetch(`${serverUrl}/api/default-night`)
      .then((r) => r.json())
      .then((b: { spec?: NightSpec }) => b.spec && setSpec((s) => s ?? b.spec!))
      .catch(() => undefined);
  }, []);

  const d = config?.defaults;
  const m = mode ?? d?.mode ?? "phones";
  const rv = reveal ?? d?.revealMode ?? "each";
  const { min, max } = SETTINGS_LIMITS.timerSeconds;
  const t = Math.min(max, Math.max(min, Number(timer || d?.timerSeconds || 45)));
  const saved = sessions.load();

  const create = async () => {
    if (!spec?.rounds.length) return setError("Add at least one round.");
    setBusy(true);
    setError("");
    try {
      const r = await call<JoinResult>("createRoom", {
        name: "Host",
        title: title.trim() || undefined,
        settings: { mode: m, revealMode: rv, timerSeconds: t },
        spec,
      });
      sessions.save({ roomCode: r.code, token: r.token, name: r.name, role: r.role });
      navigate(`/room/${r.code}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="host-setup">
      <header className="admin-head">
        <h1>{gameName}: set up tonight</h1>
        <Link to="/" className="muted">
          ← Home
        </Link>
      </header>
      {saved && (saved.role === "host" || saved.role === "cohost") && (
        <Link className="btn btn-ghost resume" to={`/room/${saved.roomCode}`}>
          Back to your room {saved.roomCode}
        </Link>
      )}

      <section className="panel">
        <h2>How do teams answer?</h2>
        <div className="mode-cards">
          <button type="button" className={`mode-card ${m === "phones" ? "on" : ""}`} onClick={() => setMode("phones")} aria-pressed={m === "phones"}>
            <strong>📱 Phones</strong>
            <span>Each team joins from a phone (a QR code on the TV) and answers before the timer runs out. Exact and multiple-choice answers mark themselves; you accept near-misses.</span>
          </button>
          <button type="button" className={`mode-card ${m === "paper" ? "on" : ""}`} onClick={() => setMode("paper")} aria-pressed={m === "paper"}>
            <strong>📝 Paper</strong>
            <span>No phones. Teams write on answer cards; you mark them here and send answers and scores to the TV when you choose. No QR code on the TV.</span>
          </button>
        </div>
        <EnterForm className="setup-row">
          <label>
            Answers go up on the TV
            <select value={rv} onChange={(e) => setReveal(e.target.value as RevealMode)}>
              <option value="each">After each question</option>
              <option value="round">After the round</option>
            </select>
          </label>
          {m === "phones" && (
            <label>
              Seconds to answer
              <NumInput
                maxLength={3}
                value={timer ?? String(t)}
                onChange={(e) => setTimer(e.target.value.replace(/\D/g, ""))}
                onBlur={() => setTimer(String(t))}
              />
            </label>
          )}
          <label>
            Name for tonight (optional)
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={60} placeholder="Tuesday Quiz" />
          </label>
        </EnterForm>
      </section>

      <section className="panel">
        <h2>Rounds</h2>
        {!config || !spec ? (
          <p className="muted">Loading the question packs…</p>
        ) : (
          <NightBuilder packs={config.packs} spec={spec} onChange={setSpec} />
        )}
        <p className="muted small">
          The venue's own question packs are uploaded in the <Link to="/admin">admin</Link>.
        </p>
      </section>

      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary btn-big" onClick={create} disabled={busy || !spec}>
        Open the room
      </button>
    </main>
  );
}
