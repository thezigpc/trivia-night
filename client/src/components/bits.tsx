import { useEffect, useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import QRCode from "qrcode";
import type { TimerView } from "@trivia/shared";
import { loadKnownTeams, pictureUrl } from "../socket";

/** A QR code for a link, drawn as an image. */
export function Qr({ url, size = 320, className }: { url: string; size?: number; className?: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(url, { margin: 1, width: size, errorCorrectionLevel: "M" })
      .then((d) => live && setSrc(d))
      .catch(() => live && setSrc(""));
    return () => {
      live = false;
    };
  }, [url, size]);
  return src ? <img className={className ?? "qr"} src={src} alt="QR code to join" /> : <div className={className ?? "qr"} />;
}

/** Seconds left on the answer timer, ticking (skew: server clock minus this one). */
export function useSecondsLeft(timer: TimerView | null, skew: number): number | null {
  const [now, setNow] = useState(() => Date.now());
  const running = !!timer?.open && timer.closesAt !== undefined;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running]);
  if (!timer?.open) return null;
  if (timer.remainingMs !== undefined) return Math.ceil(timer.remainingMs / 1000);
  if (timer.closesAt === undefined) return null;
  return Math.max(0, Math.ceil((timer.closesAt - (now + skew)) / 1000));
}

/** The timer as a ring with the seconds in it. */
export function TimerRing({ timer, skew, paused }: { timer: TimerView | null; skew: number; paused?: boolean }) {
  const left = useSecondsLeft(timer, skew);
  if (left === null || !timer) return null;
  const frac = Math.max(0, Math.min(1, (left * 1000) / timer.totalMs));
  const r = 44;
  const c = 2 * Math.PI * r;
  return (
    <div className={`timer-ring ${left <= 5 ? "urgent" : ""}`} role="timer" aria-label={`${left} seconds left`}>
      <svg viewBox="0 0 100 100">
        <circle cx="50" cy="50" r={r} className="ring-bg" />
        <circle cx="50" cy="50" r={r} className="ring-fg" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} />
      </svg>
      <span>{paused ? "❚❚" : left}</span>
    </div>
  );
}

export function Picture({ image, className }: { image?: string; className?: string }) {
  if (!image) return null;
  return <img className={className ?? "q-picture"} src={pictureUrl(image)} alt="Question picture" />;
}

/**
 * A team name box that offers the teams who've played here before, so a returning team
 * picks its usual name instead of retyping it (season standings join on the name).
 */
export function TeamNameField({
  value,
  onChange,
  autoFocus,
  placeholder = "Team name",
  exclude = [],
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
  exclude?: string[];
  label?: ReactNode;
}) {
  const id = useId();
  const [known, setKnown] = useState<string[]>([]);
  useEffect(() => {
    void loadKnownTeams().then(setKnown);
  }, []);
  const key = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  const taken = new Set(exclude.map(key));
  const q = key(value);
  const matches = known.filter((t) => !taken.has(key(t)) && (!q || key(t).includes(q))).slice(0, 8);
  const exact = known.find((t) => key(t) === q);
  return (
    <div className="team-field">
      {label && <label htmlFor={id}>{label}</label>}
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={32}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCapitalize="words"
      />
      {matches.length > 0 && !(exact && exact === value) && (
        <div className="team-suggest" aria-label="Teams that have played here before">
          <span className="muted small">{value ? "Played here before:" : "Played here before? Pick your team:"}</span>
          <div className="chips">
            {matches.map((t) => (
              <button type="button" key={t} className="chip" onClick={() => onChange(t)}>
                {t}
              </button>
            ))}
          </div>
        </div>
      )}
      {exact && exact !== value && <p className="muted small">Will play as “{exact}”, the name used here before.</p>}
    </div>
  );
}

/**
 * A number field: type="text" with inputMode (the kit's advice; type="number" has no caret, so
 * backspace and edits misbehave). Phones get their own number keyboard ("." when `decimal`), and
 * the kit's on-screen keyboard its number pad (kit 0.10.3+).
 */
export function NumInput({ decimal, ...props }: InputHTMLAttributes<HTMLInputElement> & { decimal?: boolean }) {
  return <input autoComplete="off" {...props} type="text" inputMode={decimal ? "decimal" : "numeric"} />;
}

/**
 * A form for fields that save on their own (on blur): Enter, or the on-screen keyboard's
 * Enter key, finishes the field (blurs it, which saves it and closes the keyboard) instead
 * of reloading the page.
 */
export function EnterForm({ children, className, onEnter }: { children: ReactNode; className?: string; onEnter?: () => void }) {
  return (
    <form
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur();
        onEnter?.();
      }}
    >
      {children}
      {/* Enter submits a form with more than one field only when it has a submit button. */}
      <button type="submit" hidden tabIndex={-1} aria-hidden />
    </form>
  );
}

export async function toggleFullscreen(): Promise<void> {
  const d = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  try {
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      if (d.exitFullscreen) await d.exitFullscreen();
      else d.webkitExitFullscreen?.();
    } else if (el.requestFullscreen) await el.requestFullscreen();
    else el.webkitRequestFullscreen?.();
  } catch {
    /* not allowed here */
  }
}

/** "1st", "2nd", "3rd", "4th"… */
export const ordinal = (n: number): string => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

export const fmtScore = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, ""));
