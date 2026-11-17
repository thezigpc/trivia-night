import type { NightSpec, PackSummary, RoundSpec } from "@trivia/shared";
import { SETTINGS_LIMITS } from "@trivia/shared";
import { useEffect, useState } from "react";
import { EnterForm, NumInput } from "./bits";

/** A night from one pack: a round per category (up to 10 each), its final, a tie-breaker. */
export function specFromPack(p: PackSummary | undefined): NightSpec {
  if (!p) return { rounds: [], finalPackId: null, tiebreaker: false, shuffle: false };
  const cats = p.categories.length ? p.categories : [{ name: "", count: p.count }];
  return {
    rounds: cats.map((c, i) => ({ title: c.name || `Round ${i + 1}`, packId: p.id, category: c.name, count: Math.min(10, c.count) })),
    finalPackId: p.finals ? p.id : null,
    tiebreaker: true,
    shuffle: false,
  };
}

/** How many round questions a pack (and category) can give. */
const available = (packs: PackSummary[], r: RoundSpec) => {
  const p = packs.find((x) => x.id === r.packId);
  if (!p) return 0;
  return r.category ? (p.categories.find((c) => c.name === r.category)?.count ?? 0) : p.count;
};

/**
 * Builds the night by round: "Round 1: General (pack, category, 10 questions), Round 2:
 * Music, Round 3: Pictures, Final". Questions are drawn in pack order (or shuffled), never twice.
 */
export function NightBuilder({ packs, spec, onChange }: { packs: PackSummary[]; spec: NightSpec; onChange: (s: NightSpec) => void }) {
  const setRound = (i: number, patch: Partial<RoundSpec>) =>
    onChange({ ...spec, rounds: spec.rounds.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const move = (i: number, d: number) => {
    const rounds = [...spec.rounds];
    const j = i + d;
    if (j < 0 || j >= rounds.length) return;
    [rounds[i], rounds[j]] = [rounds[j], rounds[i]];
    onChange({ ...spec, rounds });
  };
  const addRound = () => {
    const last = spec.rounds[spec.rounds.length - 1];
    const p = packs.find((x) => x.id === last?.packId) ?? packs[0];
    if (!p) return;
    onChange({
      ...spec,
      rounds: [...spec.rounds, { title: `Round ${spec.rounds.length + 1}`, packId: p.id, category: "", count: Math.min(10, p.count) }],
    });
  };
  const finals = packs.filter((p) => p.finals > 0);
  const anyTiebreak = packs.some((p) => p.tiebreakers > 0);
  const total = spec.rounds.reduce((n, r) => n + Math.min(r.count, available(packs, r)), 0);

  return (
    <EnterForm className="night-builder">
      <div className="nb-quick">
        <label>
          Start from a whole pack
          <select value="" onChange={(e) => e.target.value && onChange(specFromPack(packs.find((p) => p.id === e.target.value)))}>
            <option value="">Choose a pack…</option>
            {packs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.count} questions)
              </option>
            ))}
          </select>
        </label>
      </div>

      <ol className="nb-rounds">
        {spec.rounds.map((r, i) => {
          const pack = packs.find((p) => p.id === r.packId);
          const max = available(packs, r);
          return (
            <li key={i} className="nb-round">
              <div className="nb-row">
                <span className="nb-num">Round {i + 1}</span>
                <input
                  aria-label={`Round ${i + 1} title`}
                  value={r.title}
                  onChange={(e) => setRound(i, { title: e.target.value.slice(0, 60) })}
                  placeholder="Round title"
                  maxLength={60}
                />
                <div className="nb-move">
                  <button type="button" className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up" title="Move up">
                    ↑
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => move(i, 1)}
                    disabled={i === spec.rounds.length - 1}
                    aria-label="Move down"
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => onChange({ ...spec, rounds: spec.rounds.filter((_, j) => j !== i) })}
                    aria-label="Remove round"
                    title="Remove round"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div className="nb-row nb-source">
                <select
                  aria-label="Pack"
                  value={r.packId}
                  onChange={(e) => {
                    const p = packs.find((x) => x.id === e.target.value);
                    setRound(i, { packId: e.target.value, category: "", count: Math.min(r.count, p?.count ?? r.count) });
                  }}
                >
                  {!pack && <option value={r.packId}>(pack deleted)</option>}
                  {packs.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Category"
                  value={r.category}
                  onChange={(e) => {
                    const category = e.target.value;
                    const c = pack?.categories.find((x) => x.name === category);
                    setRound(i, { category, title: category && /^Round \d+$/.test(r.title) ? category : r.title, count: Math.min(r.count, c?.count ?? pack?.count ?? r.count) || 1 });
                  }}
                >
                  <option value="">Any category</option>
                  {pack?.categories
                    .filter((c) => c.name)
                    .map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name} ({c.count})
                      </option>
                    ))}
                </select>
                <label className="nb-count">
                  <CountInput value={r.count} max={SETTINGS_LIMITS.questionsPerRound} onChange={(count) => setRound(i, { count })} />
                  questions
                </label>
              </div>
              {r.count > max && <p className="muted small">Only {max} available here; the round gets {max}.</p>}
            </li>
          );
        })}
      </ol>
      {spec.rounds.length < SETTINGS_LIMITS.roundsPerNight && (
        <button type="button" className="btn btn-ghost" onClick={addRound} disabled={!packs.length}>
          + Add a round
        </button>
      )}

      <div className="nb-extras">
        <label>
          Final (wager) question
          <select value={spec.finalPackId ?? ""} onChange={(e) => onChange({ ...spec, finalPackId: e.target.value || null })}>
            <option value="">No final</option>
            {finals.map((p) => (
              <option key={p.id} value={p.id}>
                From {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={spec.tiebreaker && anyTiebreak}
            disabled={!anyTiebreak}
            onChange={(e) => onChange({ ...spec, tiebreaker: e.target.checked })}
          />
          Keep a “closest to” tie-breaker ready
        </label>
        <label className="check">
          <input type="checkbox" checked={spec.shuffle} onChange={(e) => onChange({ ...spec, shuffle: e.target.checked })} />
          Shuffle the questions
        </label>
      </div>
      <p className="muted small">
        {spec.rounds.length} round{spec.rounds.length === 1 ? "" : "s"}, {total} question{total === 1 ? "" : "s"}
        {spec.finalPackId ? ", a final" : ""}
        {spec.tiebreaker && anyTiebreak ? " and a tie-breaker" : ""}.
      </p>
    </EnterForm>
  );
}

/** A small whole number as typed (empty while editing is fine); saved when it is a number. */
function CountInput({ value, max, onChange }: { value: number; max: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <NumInput
      maxLength={2}
      value={text}
      aria-label="Questions in this round"
      onChange={(e) => {
        const t = e.target.value.replace(/D/g, "");
        setText(t);
        const n = Number(t);
        if (n >= 1) onChange(Math.min(max, n));
      }}
      onBlur={() => setText(String(value))}
    />
  );
}
