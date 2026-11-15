import { createSettingStore } from "@bargames/gamekit/server";
import { ADMIN_SETTINGS_LIMITS, DEFAULT_SETTINGS, SETTINGS_LIMITS, type AdminSettings } from "@trivia/shared";
import { DEFAULT_ROOM_IDLE_MINUTES, store } from "../config.js";

const DEFAULTS: AdminSettings = {
  roomIdleMinutes: DEFAULT_ROOM_IDLE_MINUTES,
  defaultMode: DEFAULT_SETTINGS.mode,
  defaultRevealMode: DEFAULT_SETTINGS.revealMode,
  defaultTimerSeconds: DEFAULT_SETTINGS.timerSeconds,
};

// DATA_DIR/settings.json (the kit's setting store: atomic writes; a damaged file is left
// untouched while the defaults apply).
const settings = createSettingStore<AdminSettings>({
  store,
  file: "settings.json",
  defaults: DEFAULTS,
  normalize: clean,
});

export const initAdminSettings = () => settings.init();
export const getAdminSettings = (): AdminSettings => settings.get();

export async function updateAdminSettings(patch: Partial<AdminSettings>): Promise<AdminSettings> {
  return settings.set(validate(patch));
}

const inRange = (n: number, r: { min: number; max: number }) => Number.isFinite(n) && n >= r.min && n <= r.max;

/** A loaded or merged value, cleaned: unknown keys dropped, bad values back to defaults. */
function clean(s: AdminSettings): AdminSettings {
  const idle = Math.round(Number(s.roomIdleMinutes));
  const timer = Math.round(Number(s.defaultTimerSeconds));
  return {
    roomIdleMinutes: inRange(idle, ADMIN_SETTINGS_LIMITS.roomIdleMinutes) ? idle : DEFAULTS.roomIdleMinutes,
    defaultMode: s.defaultMode === "paper" ? "paper" : "phones",
    defaultRevealMode: s.defaultRevealMode === "round" ? "round" : "each",
    defaultTimerSeconds: inRange(timer, SETTINGS_LIMITS.timerSeconds) ? timer : DEFAULTS.defaultTimerSeconds,
  };
}

function validate(patch: Partial<AdminSettings>): Partial<AdminSettings> {
  const out: Partial<AdminSettings> = {};
  if (patch.roomIdleMinutes !== undefined) {
    const { min, max } = ADMIN_SETTINGS_LIMITS.roomIdleMinutes;
    const n = Math.round(Number(patch.roomIdleMinutes));
    if (!inRange(n, ADMIN_SETTINGS_LIMITS.roomIdleMinutes)) throw new Error(`Idle time must be between ${min} and ${max} minutes.`);
    out.roomIdleMinutes = n;
  }
  if (patch.defaultTimerSeconds !== undefined) {
    const { min, max } = SETTINGS_LIMITS.timerSeconds;
    const n = Math.round(Number(patch.defaultTimerSeconds));
    if (!inRange(n, SETTINGS_LIMITS.timerSeconds)) throw new Error(`The answer timer must be between ${min} and ${max} seconds.`);
    out.defaultTimerSeconds = n;
  }
  if (patch.defaultMode !== undefined) {
    if (patch.defaultMode !== "phones" && patch.defaultMode !== "paper") throw new Error("Pick phones or paper.");
    out.defaultMode = patch.defaultMode;
  }
  if (patch.defaultRevealMode !== undefined) {
    if (patch.defaultRevealMode !== "each" && patch.defaultRevealMode !== "round") throw new Error("Pick when answers go up.");
    out.defaultRevealMode = patch.defaultRevealMode;
  }
  return out;
}
