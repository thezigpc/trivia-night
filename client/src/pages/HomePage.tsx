import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { BackToGames } from "@bargames/gamekit/client";
import type { JoinResult, Mode } from "@trivia/shared";
import { TeamNameField } from "../components/bits";
import { useGameName } from "../config";
import { call, socket } from "../socket";
import { lastTeam, rememberTeam, sessions } from "../session";
import { useVenue } from "../useVenue";

/** The landing page (phones mode: a team joins here) and /join/CODE links (QR codes, host links). */
export function HomePage() {
  const { code: codeParam = "" } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const gameName = useGameName();
  const venue = useVenue();
  const hostKey = search.get("host");
  const cohostInvite = search.get("cohost");
  const asTable = search.get("role") === "table" || search.get("as") === "table";

  const [code, setCode] = useState(codeParam.toUpperCase());
  const [name, setName] = useState(lastTeam);
  const [info, setInfo] = useState<{ mode: Mode; started: boolean } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    socket.connect();
  }, []);

  // A host link (the box's "Open the host controls", or a take-over): the key resumes the
  // host seat, and the room page saves the seat's own token from the answer.
  useEffect(() => {
    if (!codeParam) return;
    const room = codeParam.toUpperCase();
    if (hostKey) {
      sessions.save({ roomCode: room, token: hostKey, name: "Host", role: "host" });
      navigate(`/room/${room}`, { replace: true });
    } else if (asTable) {
      navigate(`/room/${room}?role=table`, { replace: true });
    }
  }, [codeParam, hostKey, asTable, navigate]);

  // Paper rooms take no phones: say so before anyone types a team name.
  useEffect(() => {
    setInfo(null);
    const c = code.trim().toUpperCase();
    if (c.length < 4 || hostKey || asTable || cohostInvite) return;
    let live = true;
    call<{ mode: Mode; started: boolean }>("roomInfo", { code: c })
      .then((r) => live && setInfo(r))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [code, hostKey, asTable, cohostInvite]);

  const join = async (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (!c) return setError("Enter the room code from the TV.");
    if (!name.trim()) return setError(cohostInvite ? "Enter your name." : "Enter your team's name.");
    setBusy(true);
    setError("");
    try {
      const r = await call<JoinResult>("joinRoom", {
        code: c,
        role: "team",
        name: name.trim(),
        ...(cohostInvite ? { cohost: cohostInvite } : {}),
      });
      if (!cohostInvite) rememberTeam(r.name);
      sessions.save({ roomCode: r.code, token: r.token, name: r.name, role: r.role });
      navigate(`/room/${r.code}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Already seated in a room on this tab: offer to go back.
  const saved = sessions.load();

  if (hostKey || asTable) return <main className="center-page"><p className="muted">Opening the room…</p></main>;

  const paper = info?.mode === "paper" && !cohostInvite;
  return (
    <main className="home">
      <header className="home-head">
        <div className="logo-mark" aria-hidden>?</div>
        <h1>{gameName}</h1>
      </header>

      {saved && saved.roomCode && (
        <Link className="btn btn-ghost resume" to={`/room/${saved.roomCode}`}>
          Back to room {saved.roomCode} ({saved.role === "team" ? saved.name : saved.role === "table" ? "TV" : "host"})
        </Link>
      )}

      <form className="panel join-form" onSubmit={join}>
        <h2>{cohostInvite ? "Join as a co-host" : "Join your team in"}</h2>
        {cohostInvite && <p className="muted">You've been invited to help run tonight's trivia: mark answers and run the screens.</p>}
        <label>
          Room code
          <input
            className="code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8))}
            placeholder="ABCD"
            autoCapitalize="characters"
            inputMode="text"
            maxLength={8}
            autoComplete="off"
          />
        </label>
        {paper ? (
          <p className="notice">This trivia night is played on paper answer cards: no phones needed. Ask the host for a card.</p>
        ) : cohostInvite ? (
          <label>
            Your name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} autoFocus />
          </label>
        ) : (
          <TeamNameField value={name} onChange={setName} label="Team name" autoFocus={!!codeParam} />
        )}
        {error && <p className="error">{error}</p>}
        {!paper && (
          <button className="btn btn-primary btn-big" disabled={busy}>
            {cohostInvite ? "Join as co-host" : "Join"}
          </button>
        )}
      </form>

      {!codeParam && (
        <section className="panel host-cta">
          <h2>Running the quiz?</h2>
          <p className="muted">Set up tonight's rounds, put the questions on the TV and keep score, with phones or paper answer cards.</p>
          <Link className="btn" to="/host">
            Host a trivia night
          </Link>
        </section>
      )}

      <BackToGames ctx={venue} />
    </main>
  );
}
