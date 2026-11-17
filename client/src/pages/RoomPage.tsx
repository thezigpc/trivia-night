import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useOnScreenKeyboard, useRoomConnection } from "@bargames/gamekit/client";
import { isOnBox, tableMode, type TableModeController } from "@bargames/sdk/client";
import type { JoinResult, RoomView } from "@trivia/shared";
import { toggleFullscreen } from "../components/bits";
import { useGameName } from "../config";
import { call, socket } from "../socket";
import { sessions, type StoredSession } from "../session";
import { useVenue } from "../useVenue";
import { HostConsole } from "./HostConsole";
import { TeamView } from "./TeamView";
import { TvView } from "./TvView";

/** Runs a server intent; a refusal shows as a short toast. */
export function useAction() {
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  const act = useCallback(async <T = object,>(event: Parameters<typeof call>[0], ...args: unknown[]) => {
    try {
      return await call<T>(event, ...args);
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Something went wrong.");
      return null;
    }
  }, []);
  return { act, toast, setToast };
}
export type Act = ReturnType<typeof useAction>["act"];

/**
 * /room/CODE. With ?role=table (the TV, the box's table route) the URL alone joins the room
 * as a display: no name, no tap.
 */
export function RoomPage() {
  const { code = "" } = useParams();
  const upper = code.toUpperCase();
  const [search] = useSearchParams();
  const wantTable = search.get("role") === "table";
  const isTableSeat = () => {
    const s = sessions.load();
    return s?.roomCode === upper && s.role === "table";
  };
  const [ready, setReady] = useState(() => !wantTable || isTableSeat());
  const [joinError, setJoinError] = useState("");

  useEffect(() => {
    if (ready) return;
    socket.connect();
    let live = true;
    call<JoinResult>("joinRoom", { code: upper, role: "table" })
      .then((r) => {
        if (!live) return;
        sessions.save({ roomCode: r.code, token: r.token, name: r.name, role: r.role });
        setReady(true);
      })
      .catch((err: Error) => live && setJoinError(err.message));
    return () => {
      live = false;
    };
  }, [ready, upper]);

  if (!ready) {
    return (
      <main className="center-page tv-wait">
        {joinError ? (
          <div className="panel">
            <h2>Can't show room {upper}</h2>
            <p>{joinError}</p>
          </div>
        ) : (
          <p className="muted">Opening room {upper}…</p>
        )}
      </main>
    );
  }
  return <Room code={upper} />;
}

function Room({ code }: { code: string }) {
  const navigate = useNavigate();
  const gameName = useGameName();
  const { view, status, closedReason, skew, reconnect } = useRoomConnection<RoomView, StoredSession>(code, {
    socket: socket as unknown as Parameters<typeof useRoomConnection>[1]["socket"],
    call,
    sessions,
    // A host link's key resumes the host seat; the answer carries the seat's own token, so a
    // later take-over (a new key) leaves this phone seated as a co-host.
    onResumed: (ack, session) =>
      sessions.save({
        ...session,
        token: typeof ack.token === "string" ? ack.token : session.token,
        name: typeof ack.name === "string" ? ack.name : session.name,
        role: typeof ack.role === "string" ? (ack.role as StoredSession["role"]) : session.role,
      }),
  });
  const { act, toast, setToast } = useAction();
  // A touchscreen with the on-screen keyboard: the toast goes to the top, never under the keys.
  const keyboard = useOnScreenKeyboard();
  useEffect(() => {
    const onNotice = (n: { message: string }) => setToast(n.message);
    socket.on("notice", onNotice);
    return () => {
      socket.off("notice", onNotice);
    };
  }, [setToast]);

  // A TV on a Bar Games box: the SDK's tableMode hides the pointer, keeps the screen awake,
  // gives 5% safe margins (--bg-safe-x/y) and the standard reconnecting / closed banners, and
  // marks the page as a shared screen (the announcement follows the staff's "show"). Off a
  // box nothing changes.
  const venue = useVenue();
  const role = view?.you.role ?? sessions.load()?.role;
  const boxTv = isOnBox(venue) && role === "table";
  const tm = useRef<TableModeController | null>(null);
  useEffect(() => {
    if (!boxTv) return;
    tm.current = tableMode(venue);
    return () => {
      tm.current?.stop();
      tm.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxTv]);
  useEffect(() => {
    tm.current?.setState(closedReason ? "closed" : status === "offline" ? "reconnecting" : "connected", closedReason ?? undefined);
  }, [boxTv, status, closedReason]);

  if (closedReason) {
    if (role === "table") {
      return (
        <div className="tv tv-closed">
          <div className="tv-center">
            <h1>{gameName}</h1>
            <p className="tv-sub">{closedReason}</p>
          </div>
        </div>
      );
    }
    return (
      <main className="center-page">
        <div className="panel">
          <h2>Room closed</h2>
          <p>{closedReason}</p>
          <Link className="btn btn-primary" to="/">
            Back to home
          </Link>
        </div>
      </main>
    );
  }
  if (!view) {
    return (
      <main className={role === "table" ? "tv tv-closed" : "center-page"}>
        <p className="muted">Connecting to room {code}…</p>
      </main>
    );
  }

  const leave = async () => {
    const host = view.you.role === "host";
    if (!window.confirm(host ? "Leave the console? The room keeps running; open it again with Back to your room." : "Leave this room?")) return;
    await call("leaveRoom").catch(() => {});
    if (!host) sessions.clear();
    navigate(host ? "/host" : "/");
  };

  if (view.you.role === "table") {
    return (
      <>
        {status !== "online" && !boxTv && <div className="banner banner-float">Reconnecting…</div>}
        <TvView view={view} skew={skew} gameName={gameName} venue={venue} onBox={isOnBox(venue)} />
      </>
    );
  }

  return (
    <div className={`room role-${view.you.role}`}>
      {status !== "online" && (
        <div className="banner" role="status">
          {status === "offline" ? "Connection lost. Reconnecting…" : "Connecting…"}
        </div>
      )}
      <header className="room-header">
        <div className="room-id">
          <span className="room-code">{view.code}</span>
          <span className="muted">
            {view.you.role === "team" ? view.you.name : view.you.role === "cohost" ? `${view.you.name}` : gameName}
            {view.title ? ` · ${view.title}` : ""}
          </span>
          {view.you.role === "cohost" && <span className="badge">Co-host</span>}
          {view.settings.mode === "paper" && view.you.role !== "team" && <span className="badge badge-quiet">Paper</span>}
        </div>
        <div className="header-actions">
          <button className="icon-btn" onClick={toggleFullscreen} title="Full screen" aria-label="Full screen">
            ⛶
          </button>
          <button className="icon-btn" onClick={reconnect} title="Reconnect" aria-label="Reconnect">
            ⟳
          </button>
          <button className="icon-btn" onClick={leave} title="Leave" aria-label="Leave">
            ✕
          </button>
        </div>
      </header>
      {view.you.role === "team" ? <TeamView view={view} skew={skew} act={act} /> : <HostConsole view={view} skew={skew} act={act} venue={venue} />}
      {toast && (
        <div className={`toast ${keyboard ? "toast-top" : ""}`} role="alert" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}
