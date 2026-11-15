import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { BoxAdminLink, invalidatePublicConfig, staffSignIn } from "@bargames/gamekit/client";
import {
  ADMIN_SETTINGS_LIMITS,
  CSV_COLUMNS,
  SETTINGS_LIMITS,
  type AdminRoomSummary,
  type AdminSettings,
  type KnownTeam,
  type PackSummary,
  type Question,
} from "@trivia/shared";
import { pictureUrl, serverUrl } from "../socket";
import { useVenue } from "../useVenue";

const TOKEN_KEY = "trivia_admin_token";
const loadToken = () => {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
};
const saveToken = (t: string) => {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode */
  }
};

async function api<T>(path: string, token: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${serverUrl}/api/admin${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `Request failed (${res.status}).`), { status: res.status, body });
  return body as T;
}

interface AdminStatus {
  setupNeeded: boolean;
  authenticated: boolean;
  trusted?: boolean;
  venueLogin?: boolean;
  setupAllowed?: boolean;
}

interface Overview {
  rooms: AdminRoomSummary[];
  settings: AdminSettings;
  packs: PackSummary[];
  pictures: { name: string; bytes: number; builtIn: boolean }[];
  teams: KnownTeam[];
}

export function AdminPage() {
  const [token, setToken] = useState(loadToken);
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [error, setError] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  const venue = useVenue();

  const refreshStatus = useCallback(() => {
    api<AdminStatus>("/status", token)
      .then(async (s) => {
        // Venue staff (the box vouches for this browser): signed in without the password.
        if (!s.authenticated && s.trusted && !signedOut) {
          const t = await staffSignIn(serverUrl);
          if (t) {
            saveToken(t);
            setToken(t);
            return;
          }
        }
        setStatus(s);
      })
      .catch((e: Error) => setError(e.message));
  }, [token, signedOut]);
  useEffect(refreshStatus, [refreshStatus]);

  const signedIn = (t: string) => {
    saveToken(t);
    setToken(t);
  };
  const signOut = async () => {
    await api("/logout", token, { method: "POST" }).catch(() => {});
    setSignedOut(true);
    signedIn("");
  };

  return (
    <main className="admin">
      <BoxAdminLink ctx={venue} />
      <header className="admin-head">
        <h1>Trivia admin</h1>
        <Link to="/" className="muted">
          ← Home
        </Link>
      </header>
      {error && <p className="error">{error}</p>}
      {!status ? (
        <p className="muted">Loading…</p>
      ) : status.authenticated ? (
        <Dashboard token={token} onSignOut={signOut} onExpired={() => signedIn("")} />
      ) : (
        <PasswordForm status={status} onToken={signedIn} />
      )}
    </main>
  );
}

function PasswordForm({ status, onToken }: { status: AdminStatus; onToken: (t: string) => void }) {
  const setupNeeded = status.setupNeeded;
  // On a box the venue's admin password signs in here too, even before this game has one.
  const onBox = status.venueLogin === true;
  const canSetOwn = onBox && setupNeeded && status.setupAllowed === true;
  const [ownPassword, setOwnPassword] = useState(false);
  const setup = setupNeeded && (!onBox || (canSetOwn && ownPassword));
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (setup && password !== confirm) return setError("The passwords don't match.");
    setBusy(true);
    setError("");
    try {
      const r = await api<{ token: string }>(setup ? "/setup" : "/login", "", { method: "POST", body: { password } });
      onToken(r.token);
    } catch (err) {
      const msg = (err as Error).message;
      setError(onBox && setupNeeded && !setup && /set up/i.test(msg) ? "That isn't the venue's admin password." : msg);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel admin-login" onSubmit={submit}>
      <h2>{setup ? "Set the admin password" : "Sign in"}</h2>
      {onBox && !setup && (
        <p className="muted small">{setupNeeded ? "Use the venue's admin password." : "Use this game's admin password, or the venue's admin password."}</p>
      )}
      {setup && (
        <p className="warning">
          No admin password has been set yet. Whoever sets it first becomes the admin, so do this now. The <code>ADMIN_PASSWORD</code> environment
          variable overrides it.
        </p>
      )}
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={setup ? "new-password" : "current-password"} autoFocus />
      </label>
      {setup && (
        <label>
          Confirm password
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary btn-big" disabled={busy || !password}>
        {setup ? "Set password" : "Sign in"}
      </button>
      {canSetOwn && (
        <button type="button" className="btn btn-ghost" onClick={() => setOwnPassword((v) => !v)}>
          {ownPassword ? "Use the venue's password instead" : "Set a separate password for this game instead"}
        </button>
      )}
    </form>
  );
}

function Dashboard({ token, onSignOut, onExpired }: { token: string; onSignOut: () => void; onExpired: () => void }) {
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api<Overview>("/overview", token)
      .then((x) => {
        setO(x);
        setError("");
      })
      .catch((e: Error & { status?: number }) => (e.status === 401 ? onExpired() : setError(e.message)));
  }, [token, onExpired]);
  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);
  const call = async (path: string, method: string, body?: unknown) => {
    try {
      await api(path, token, { method, body });
      invalidatePublicConfig();
      load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  if (!o) return <p className="muted">{error || "Loading…"}</p>;
  return (
    <div className="dashboard">
      {error && <p className="error">{error}</p>}
      <PacksPanel token={token} packs={o.packs} onChanged={load} call={call} />
      <PicturesPanel token={token} pictures={o.pictures} onChanged={load} call={call} />
      <TeamsPanel teams={o.teams} call={call} />
      <SettingsPanel settings={o.settings} call={call} />
      <section className="panel">
        <h2>Rooms</h2>
        {!o.rooms.length && <p className="muted">No rooms open.</p>}
        <ul className="team-list">
          {o.rooms.map((r) => (
            <li key={r.code}>
              <strong>{r.code}</strong>
              <span className="muted small">
                {r.mode} · {r.teams} team{r.teams === 1 ? "" : "s"} · {r.stage} {r.kind === "venue" ? "· venue" : ""}
              </span>
              <button className="btn btn-small btn-ghost" onClick={() => window.confirm(`Close room ${r.code}?`) && call(`/rooms/${r.code}/close`, "POST")}>
                Close
              </button>
            </li>
          ))}
        </ul>
      </section>
      <button className="btn btn-ghost" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  );
}

type Call = (path: string, method: string, body?: unknown) => Promise<boolean>;

const readFile = (f: File, as: "text" | "base64") =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("Couldn't read that file."));
    r.onload = () => {
      const s = String(r.result ?? "");
      resolve(as === "base64" ? s.slice(s.indexOf(",") + 1) : s);
    };
    if (as === "text") r.readAsText(f);
    else r.readAsDataURL(f);
  });

function PacksPanel({ token, packs, onChanged, call }: { token: string; packs: PackSummary[]; onChanged: () => void; call: Call }) {
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [replace, setReplace] = useState("");
  const [preview, setPreview] = useState<{ questions: Question[]; errors: string[]; name?: string } | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const doPreview = async (t: string) => {
    setMsg("");
    try {
      const r = await api<{ questions: Question[]; errors: string[]; name?: string }>("/upload/packs/preview", token, { method: "POST", body: { text: t } });
      setPreview(r);
      if (r.name && !name) setName(r.name);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const t = await readFile(f, "text");
    setText(t);
    if (!name) setName(f.name.replace(/\.(csv|json|txt)$/i, ""));
    void doPreview(t);
  };
  const save = async () => {
    setBusy(true);
    setMsg("");
    try {
      await api("/upload/packs", token, { method: "POST", body: { text, name, id: replace || undefined } });
      setMsg(replace ? "Pack replaced." : "Pack saved.");
      setText("");
      setName("");
      setReplace("");
      setPreview(null);
      invalidatePublicConfig();
      onChanged();
    } catch (e) {
      const err = e as Error & { body?: { errors?: string[] } };
      setMsg(err.message);
      if (err.body?.errors) setPreview((p) => (p ? { ...p, errors: err.body!.errors! } : p));
    } finally {
      setBusy(false);
    }
  };
  const download = async (p: PackSummary, format: "csv" | "json") => {
    const res = await fetch(`${serverUrl}/api/admin/packs/${p.id}${format === "csv" ? "?format=csv" : ""}`, { headers: { authorization: `Bearer ${token}` } });
    const blob =
      format === "csv"
        ? await res.blob()
        : new Blob([JSON.stringify({ name: p.name, description: p.description, questions: ((await res.json()) as { pack: { questions: Question[] } }).pack.questions }, null, 2)], {
            type: "application/json",
          });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${p.name.replace(/[^\w.-]+/g, "-")}.${format}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section className="panel">
      <h2>Question packs</h2>
      <ul className="pack-list">
        {packs.map((p) => (
          <li key={p.id}>
            <div>
              <strong>{p.name}</strong> {p.builtIn && <span className="badge badge-quiet">sample</span>}
              <div className="muted small">
                {p.count} questions
                {p.categories.filter((c) => c.name).length > 0 && ` in ${p.categories.map((c) => `${c.name || "no category"} (${c.count})`).join(", ")}`}
                {p.finals > 0 && ` · ${p.finals} final`}
                {p.tiebreakers > 0 && ` · ${p.tiebreakers} tie-breaker`}
                {p.pictures > 0 && ` · ${p.pictures} with pictures`}
              </div>
            </div>
            <div className="row-btns">
              <button className="btn btn-small btn-ghost" onClick={() => download(p, "csv")}>
                CSV
              </button>
              <button className="btn btn-small btn-ghost" onClick={() => download(p, "json")}>
                JSON
              </button>
              {!p.builtIn && (
                <button className="btn btn-small btn-ghost" onClick={() => window.confirm(`Delete the pack ${p.name}?`) && call(`/packs/${p.id}`, "DELETE")}>
                  Delete
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <h3>Upload a pack</h3>
      <details className="format-help">
        <summary>CSV and JSON format</summary>
        <p className="small">
          CSV: a header row, then one question per row. Columns: <code>{CSV_COLUMNS.join(", ")}</code>. Only <code>question</code> and{" "}
          <code>answer</code> are required.
        </p>
        <ul className="small">
          <li>
            <code>accept</code>: other answers that count, separated by <code>|</code> (“Abe Lincoln|Lincoln”).
          </li>
          <li>
            <code>type</code>: <code>open</code> (default), <code>choice</code>, <code>truefalse</code> or <code>number</code>.{" "}
            <code>choices</code>: the options, separated by <code>|</code>; the answer is one of them (or its letter).
          </li>
          <li>
            <code>category</code> groups questions into rounds; <code>points</code> defaults to 1; <code>image</code> is a picture uploaded below (its
            file name) or an https link; <code>note</code> is for the host only.
          </li>
          <li>
            <code>use</code>: <code>round</code> (default), <code>final</code> (the wager question) or <code>tiebreaker</code> (a number question:
            closest wins).
          </li>
        </ul>
        <p className="small">JSON: {"{ \"name\": \"…\", \"questions\": [ { \"question\": \"…\", \"answer\": \"…\", \"accept\": [\"…\"], … } ] }"}. Download the sample pack above for an example of both.</p>
        <p className="small">Write or license your own questions: don't upload questions copied from published quiz games, books or websites.</p>
      </details>
      <div className="upload">
        <input type="file" accept=".csv,.json,.txt,text/csv,application/json" onChange={(e) => void onFile(e.target.files?.[0])} />
        <textarea
          rows={5}
          value={text}
          placeholder="…or paste CSV or JSON here"
          onChange={(e) => {
            setText(e.target.value);
            setPreview(null);
          }}
        />
        <div className="setup-row">
          <label>
            Pack name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </label>
          <label>
            Save as
            <select value={replace} onChange={(e) => setReplace(e.target.value)}>
              <option value="">A new pack</option>
              {packs
                .filter((p) => !p.builtIn)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    Replace {p.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <div className="row-btns">
          <button className="btn" disabled={!text.trim()} onClick={() => doPreview(text)}>
            Check
          </button>
          <button className="btn btn-primary" disabled={busy || !preview || preview.errors.length > 0 || !preview.questions.length || !name.trim()} onClick={save}>
            Save pack
          </button>
        </div>
        {msg && <p className={/saved|replaced/i.test(msg) ? "ok-text" : "error"}>{msg}</p>}
        {preview && (
          <div className="preview">
            <p>
              {preview.questions.length} question{preview.questions.length === 1 ? "" : "s"} read
              {preview.errors.length ? `, ${preview.errors.length} problem${preview.errors.length === 1 ? "" : "s"} to fix:` : ". Ready to save."}
            </p>
            {preview.errors.length > 0 && (
              <ul className="errors">
                {preview.errors.slice(0, 50).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
                {preview.errors.length > 50 && <li>…and {preview.errors.length - 50} more</li>}
              </ul>
            )}
            <ol className="preview-list small">
              {preview.questions.slice(0, 8).map((q) => (
                <li key={q.id}>
                  {q.text} → <strong>{q.answer}</strong> <span className="muted">({q.type}{q.category ? `, ${q.category}` : ""}{q.use !== "round" ? `, ${q.use}` : ""})</span>
                </li>
              ))}
            </ol>
            {preview.questions.length > 8 && <p className="muted small">…and {preview.questions.length - 8} more.</p>}
          </div>
        )}
      </div>
    </section>
  );
}

function PicturesPanel({
  token,
  pictures,
  onChanged,
  call,
}: {
  token: string;
  pictures: Overview["pictures"];
  onChanged: () => void;
  call: Call;
}) {
  const [msg, setMsg] = useState("");
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const done: string[] = [];
    for (const f of [...files]) {
      try {
        const data = await readFile(f, "base64");
        const r = await api<{ name: string }>("/upload/pictures", token, { method: "POST", body: { name: f.name, data } });
        done.push(r.name);
      } catch (e) {
        setMsg(`${f.name}: ${(e as Error).message}`);
        onChanged();
        return;
      }
    }
    setMsg(`Uploaded: ${done.join(", ")}. Put the name in a question's image column.`);
    onChanged();
  };
  return (
    <section className="panel">
      <h2>Pictures</h2>
      <p className="muted small">For picture rounds: upload PNG, JPEG, GIF or WebP files (3 MB each at most), then name the file in a question's image column.</p>
      <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={(e) => void upload(e.target.files)} />
      {msg && <p className="small">{msg}</p>}
      <ul className="pictures">
        {pictures.map((p) => (
          <li key={p.name}>
            <img src={pictureUrl(p.name)} alt="" loading="lazy" />
            <code>{p.name}</code>
            {p.builtIn ? (
              <span className="muted small">sample</span>
            ) : (
              <button className="btn btn-small btn-ghost" onClick={() => window.confirm(`Delete ${p.name}?`) && call(`/pictures/${encodeURIComponent(p.name)}`, "DELETE")}>
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function TeamsPanel({ teams, call }: { teams: KnownTeam[]; call: Call }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [to, setTo] = useState("");
  return (
    <section className="panel">
      <h2>Teams</h2>
      <p className="muted small">
        Every team that finished a night here. Teams pick their name from this list when they join, so their results stay under one name (season
        standings join nights by team name). Rename a misspelt team onto the right name to merge the two.
      </p>
      {!teams.length && <p className="muted">No nights finished yet.</p>}
      <ul className="team-list">
        {teams.map((t) => (
          <li key={t.name}>
            {editing === t.name ? (
              <form
                className="inline-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await call("/teams/rename", "POST", { from: t.name, to })) setEditing(null);
                }}
              >
                <input value={to} onChange={(e) => setTo(e.target.value)} maxLength={32} autoFocus />
                <button className="btn btn-small">Save</button>
                <button type="button" className="btn btn-small btn-ghost" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <span className="team-name">{t.name}</span>
                <span className="muted small">
                  {t.nights} night{t.nights === 1 ? "" : "s"} · last {new Date(t.lastSeen).toLocaleDateString()}
                </span>
                <button
                  className="btn btn-small btn-ghost"
                  onClick={() => {
                    setEditing(t.name);
                    setTo(t.name);
                  }}
                >
                  Rename
                </button>
                <button className="btn btn-small btn-ghost" onClick={() => window.confirm(`Take ${t.name} off the list?`) && call("/teams/remove", "POST", { name: t.name })}>
                  Remove
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SettingsPanel({ settings, call }: { settings: AdminSettings; call: Call }) {
  const [s, setS] = useState(settings);
  useEffect(() => setS(settings), [settings]);
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  return (
    <section className="panel">
      <h2>Defaults for new rooms</h2>
      <div className="setup-row">
        <label>
          Teams answer
          <select value={s.defaultMode} onChange={(e) => setS({ ...s, defaultMode: e.target.value as AdminSettings["defaultMode"] })}>
            <option value="phones">On their phones</option>
            <option value="paper">On paper answer cards</option>
          </select>
        </label>
        <label>
          Answers go up
          <select value={s.defaultRevealMode} onChange={(e) => setS({ ...s, defaultRevealMode: e.target.value as AdminSettings["defaultRevealMode"] })}>
            <option value="each">After each question</option>
            <option value="round">After the round</option>
          </select>
        </label>
        <label>
          Seconds to answer
          <input
            type="number"
            min={SETTINGS_LIMITS.timerSeconds.min}
            max={SETTINGS_LIMITS.timerSeconds.max}
            value={s.defaultTimerSeconds}
            onChange={(e) => setS({ ...s, defaultTimerSeconds: Number(e.target.value) })}
          />
        </label>
        <label>
          Close idle rooms after (minutes)
          <input
            type="number"
            min={ADMIN_SETTINGS_LIMITS.roomIdleMinutes.min}
            max={ADMIN_SETTINGS_LIMITS.roomIdleMinutes.max}
            value={s.roomIdleMinutes}
            onChange={(e) => setS({ ...s, roomIdleMinutes: Number(e.target.value) })}
          />
        </label>
      </div>
      <button className="btn btn-primary" disabled={!dirty} onClick={() => call("/settings", "PUT", s)}>
        Save
      </button>
    </section>
  );
}
