// The day countdown (PS 1.70, the developer 19 Nov 2026: "a countdown under the headline to the end of my day"). Pure rules only: no React,
// no DOM, no clock of its own, so tests/daycount.test.ts checks every one.
//
// What it is:
//  - A countdown in the Tab list between the headline and the list's name, to the end of the day. Default: on, and (PS 1.72, Jan
//    via the developer 21 Nov 2026: "I think it should probably be setting both") the day ends at your reset time, Settings "Reset
//    automatically at" (settings.autoResetAt, core/resetday.ts), in the reset's own zone (Your time zone), so one time sets both.
//    Anyone who picked their own day end before 1.72 keeps it ("Every day at" or "A time for each day", 12:00 by default there),
//    and so does the developer's account (his noon of 19 Nov, modeOf) until he picks another.
//    The 1.70 zone rule stays for those: the developer's account Asia/Dubai, everyone else the device's own (cdZone). All of it is in
//    Settings, Countdown text (settings.countdown, synced like other settings, change only).
//  - At zero it asks "End day now?" with Yes and "Give me 15 more mins". With Reset automatically on (1.72): a day end at the reset
//    itself never asks (the Reset ends the day), and a zero nobody answered lets go at the next automatic Reset (see cdNow). Yes only starts the next day's countdown: it never
//    resets or changes the task list (the developer's answer). 15 more mins (and Esc) snoozes it and asks again. The answer is saved in the
//    vault (settings.cdAns), so an answer on one device clears the card on the others (like the gym reminder).
//  - Island reminders: every 3 hours by default, "You have 4h 12m left" with one button, Acknowledged (also in cdAns).
//  - Priority 1 timers: the hidden 24 hour clock of each Priority 1 task (Todo.p1At, core/squadp1.ts) shown on its row.
// Nothing here reads or sends anything about 1Password or Signal.

import { P1_WINDOW_MS, cleanStart } from "./squadp1.ts";

export const CD_FEATURE = "day-countdown";
export const RED_TZ = "Asia/Dubai";
export const H = 3_600_000, M = 60_000;
/** "Give me 15 more mins" (and Esc on the card). */
export const SNOOZE_MS = 15 * M;
/** A zero nobody answered is let go after this long (or half way to the next end, if that is sooner): the next day counts down. */
export const STALE_MS = 12 * H;
export const EVERY_CHOICES = [1, 2, 3, 4, 6] as const;
export const SIZE_MIN = 60, SIZE_MAX = 200;

export type CdMode = "reset" | "daily" | "week";
export type CdFont = "rounded" | "system" | "mono" | "serif";
export type CdAnim = "slide" | "flip" | "blur" | "pop" | "none";
export type CdWeight = 400 | 500 | 600 | 700 | 800;

export interface CdPrefs {
  on: boolean;
  /** "reset" (PS 1.72, the default): your reset time, Settings "Reset automatically at". "daily": the same time every day.
   *  "week": a time for each day, Monday first ("" = that day has no end). */
  mode: CdMode;
  at: string;
  days: string[];
  /** "" = the default zone (cdZone). */
  tz: string;
  font: CdFont;
  /** "" = the list's own text colour, "accent" = the look's accent, else a #rrggbb. */
  color: string;
  weight: CdWeight;
  /** Text size in percent. */
  size: number;
  anim: CdAnim;
  /** Lively near zero: a glow from an hour out, warmer from 15 minutes, a small rumble in the last 3 minutes. */
  lively: boolean;
  /** The countdown inside the island's task area, right of the task name. */
  island: boolean;
  /** "You have X left" from the island every `every` hours. */
  remind: boolean;
  every: number;
  /** The small timer on each Priority 1 task. */
  p1: boolean;
}

export const CD_DEFAULTS: CdPrefs = {
  on: true, mode: "reset", at: "12:00", days: ["12:00", "12:00", "12:00", "12:00", "12:00", "12:00", "12:00"], tz: "",
  font: "rounded", color: "", weight: 700, size: 100, anim: "slide", lively: true, island: true, remind: true, every: 3, p1: true,
};
export const FONTS: { id: CdFont; label: string }[] = [
  { id: "rounded", label: "Rounded" }, { id: "system", label: "Plain" }, { id: "mono", label: "Mono" }, { id: "serif", label: "Serif" },
];
export const WEIGHTS: { id: CdWeight; label: string }[] = [
  { id: 400, label: "Light" }, { id: 500, label: "Regular" }, { id: 600, label: "Medium" }, { id: 700, label: "Bold" }, { id: 800, label: "Heavy" },
];
export const ANIMS: { id: CdAnim; label: string }[] = [
  { id: "slide", label: "Slide" }, { id: "flip", label: "Flip" }, { id: "blur", label: "Blur" }, { id: "pop", label: "Pop" }, { id: "none", label: "None" },
];
export const COLORS: { id: string; label: string }[] = [
  { id: "", label: "Default" }, { id: "accent", label: "Accent" }, { id: "#ffffff", label: "White" }, { id: "#5eead4", label: "Mint" },
  { id: "#7dd3fc", label: "Sky" }, { id: "#fcd34d", label: "Gold" }, { id: "#fda4af", label: "Rose" }, { id: "#c4b5fd", label: "Lilac" },
];
export const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const okHm = (v: unknown): v is string => typeof v === "string" && HM.test(v);
const HEX = /^#[0-9a-f]{6}$/;
const ZONE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$|^UTC$/;

/** The Day ends choice. Saved by 1.72 and later: as saved. Saved before 1.72 (no mode, as "daily" was the default then and only
 *  changes were saved): a time of your own ("at") keeps "Every day at" with it; nothing set means you never picked a day end, so
 *  it follows the reset time. The developer's account (`red`) keeps the 1.70 noon he chose on 19 Nov until he picks another Day ends: his
 *  noon was the default then, so it was never saved and cannot be told apart from never picked. */
function modeOf(o: Record<string, unknown>, red: boolean): CdMode {
  if (o.mode === "week" || o.mode === "daily" || o.mode === "reset") return o.mode;
  return okHm(o.at) || red ? "daily" : "reset";
}
/** Saved prefs (anything) to whole prefs: every unknown or broken value takes its default. `red`: the developer's account (modeOf). */
export function cleanCd(v: unknown, red = false): CdPrefs {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const d = CD_DEFAULTS;
  const days = Array.isArray(o.days) && o.days.length === 7 ? o.days.map((x) => (x === "" || okHm(x) ? (x as string) : d.at)) : [...d.days];
  const every = typeof o.every === "number" && (EVERY_CHOICES as readonly number[]).includes(o.every) ? o.every : d.every;
  const size = typeof o.size === "number" && Number.isFinite(o.size) ? Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, o.size))) : d.size;
  const color = typeof o.color === "string" && (o.color === "" || o.color === "accent" || HEX.test(o.color.toLowerCase())) ? o.color.toLowerCase() : d.color;
  return {
    on: o.on !== false,
    mode: modeOf(o, red),
    at: okHm(o.at) ? o.at : d.at,
    days,
    tz: typeof o.tz === "string" && o.tz.length <= 64 && ZONE.test(o.tz) ? o.tz : "",
    font: FONTS.some((f) => f.id === o.font) ? (o.font as CdFont) : d.font,
    color,
    weight: WEIGHTS.some((w) => w.id === o.weight) ? (o.weight as CdWeight) : d.weight,
    size,
    anim: ANIMS.some((a) => a.id === o.anim) ? (o.anim as CdAnim) : d.anim,
    lively: o.lively !== false,
    island: o.island !== false,
    remind: o.remind !== false,
    every,
    p1: o.p1 !== false,
  };
}
/** Only what differs from the defaults is saved (a small settings record, change only). */
export function cdPatch(cur: CdPrefs, change: Partial<CdPrefs>): Partial<CdPrefs> {
  const next = cleanCd({ ...cur, ...change });
  const out: Partial<CdPrefs> = {};
  for (const k of Object.keys(CD_DEFAULTS) as (keyof CdPrefs)[]) {
    if (JSON.stringify(next[k]) !== JSON.stringify(CD_DEFAULTS[k])) (out as Record<string, unknown>)[k] = next[k];
  }
  // A saved time with no mode reads as "Every day at" (a pick from before 1.72, modeOf), so a time kept while following the reset
  // time saves its mode too; so does a Day ends picked now (on the developer's account no mode reads as Every day at).
  if ((out.at !== undefined || "mode" in change) && out.mode === undefined) out.mode = next.mode;
  return out;
}

/** The zone the day ends in: the one picked, else (following the reset time) the reset's own zone, Settings "Your time zone"
 *  (`resetTz`, core/overdue.ts overdueZone), else the developer's Dubai on the developer's account, else the device's own. */
export function cdZone(p: Pick<CdPrefs, "tz"> & { mode?: CdMode }, red: boolean, deviceTz: string, resetTz?: string): string {
  if (p.tz) return p.tz;
  if (p.mode === "reset" && resetTz) return resetTz;
  return red ? RED_TZ : deviceTz || "UTC";
}
/** The prefs the clock maths reads: following the reset time is "the same time every day" at the reset time ("HH:MM",
 *  core/resetday.ts resetAtOf: midnight when never set). */
export function cdEffective(p: CdPrefs, resetAt: string): CdPrefs {
  return p.mode === "reset" ? { ...p, mode: "daily", at: okHm(resetAt) ? resetAt : "00:00" } : p;
}

// ---------- time in a zone (Intl, so daylight saving is always right) ----------
const fmts = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmts.get(tz);
  if (!f) {
    try { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" }); }
    catch { f = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" }); }
    fmts.set(tz, f);
  }
  return f;
}
const WD: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
interface Wall { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: number }
function wallOf(ts: number, tz: string): Wall {
  const o: Record<string, string> = {};
  for (const p of fmt(tz).formatToParts(ts)) if (p.type !== "literal") o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: WD[o.weekday] ?? 0 };
}
function offsetMin(ts: number, tz: string): number {
  const w = wallOf(ts, tz);
  return Math.round((Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ts / 1000) * 1000) / 60000);
}
/** A wall clock time in a zone to the real moment (two passes settle daylight saving edges). */
export function zoned(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ts = guess - offsetMin(guess, tz) * 60000;
  ts = guess - offsetMin(ts, tz) * 60000;
  return ts;
}

/** Every end of day from 3 days back to 9 days ahead of `around`, oldest first. */
export function endsAround(p: Pick<CdPrefs, "mode" | "at" | "days">, tz: string, around: number): number[] {
  const out: number[] = [];
  const w = wallOf(around, tz);
  for (let k = -3; k <= 9; k++) {
    const day = new Date(Date.UTC(w.y, w.mo - 1, w.d + k, 12));
    const wd = (day.getUTCDay() + 6) % 7;   // Monday 0
    const hm = p.mode === "week" ? p.days[wd] ?? "" : p.at;
    if (!okHm(hm)) continue;
    const [h, mi] = hm.split(":").map(Number);
    out.push(zoned(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, mi, tz));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}
export function prevEnd(p: Pick<CdPrefs, "mode" | "at" | "days">, tz: string, now: number): number | null {
  const l = endsAround(p, tz, now).filter((t) => t <= now);
  return l.length ? l[l.length - 1] : null;
}
export function nextEnd(p: Pick<CdPrefs, "mode" | "at" | "days">, tz: string, after: number): number | null {
  return endsAround(p, tz, after).find((t) => t > after) ?? null;
}

// ---------- the answers (synced: settings.cdAns) ----------
export interface CdAns {
  /** The end of day (ISO) the answer is for. */
  end?: string;
  /** Yes: the day is over, the next one counts down. */
  yes?: boolean;
  /** Give me 15 more mins: asked again at this time (ISO). */
  snooze?: string;
  /** The last reminder acknowledged (its time, ISO). */
  rem?: string;
}
const isoOk = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v));
export function cleanAns(v: unknown): CdAns {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const a: CdAns = {};
  if (isoOk(o.end)) a.end = new Date(Date.parse(o.end)).toISOString();
  if (a.end && o.yes === true) a.yes = true;
  if (a.end && isoOk(o.snooze)) a.snooze = new Date(Date.parse(o.snooze)).toISOString();
  if (isoOk(o.rem)) a.rem = new Date(Date.parse(o.rem)).toISOString();
  return a;
}
const iso = (t: number) => new Date(t).toISOString();

export interface CdNow {
  /** When the countdown reaches zero (ms), or null when switched off or nothing is set. */
  target: number | null;
  /** At zero and waiting for an answer: the "End day now?" card is up. */
  asking: boolean;
  /** The end of day being asked about (ISO), while asking or snoozed. */
  endKey: string | null;
  /** Counting down a "15 more mins". */
  snoozed: boolean;
}
const OFF: CdNow = { target: null, asking: false, endKey: null, snoozed: false };

/** Where the countdown is now. `since`: when this device first ran it (ms); an end before that never asks (an update never fires an
 *  old one at once). `firstReset` (PS 1.72, only while Reset automatically is on): the first automatic Reset at or after a moment.
 *  The automatic Reset ends the day, so a day end right at it never asks "End day now?" and never sits at 0:00, and a zero nobody
 *  answered lets go at the next Reset (Jan, 21 Nov 2026: 0:00 sat under his headline from noon). */
export function cdNow(p: CdPrefs, ans: CdAns, tz: string, now: number, since: number, firstReset?: ((t: number) => number | null) | null): CdNow {
  if (!p.on) return OFF;
  const b = prevEnd(p, tz, now);
  const r = b !== null && firstReset ? firstReset(b) : null;
  if (b !== null && b > since && r !== b) {
    const after = nextEnd(p, tz, b);
    const stale = Math.min(STALE_MS, after ? (after - b) / 2 : STALE_MS, r !== null && r > b ? r - b : STALE_MS);
    const key = iso(b);
    const mine = ans.end === key;
    if (now - b < stale && !(mine && ans.yes)) {
      const sn = mine && ans.snooze ? Date.parse(ans.snooze) : NaN;
      if (Number.isFinite(sn) && sn > now) return { target: sn, asking: false, endKey: key, snoozed: true };
      return { target: b, asking: true, endKey: key, snoozed: false };
    }
  }
  const n = nextEnd(p, tz, now);
  return n === null ? OFF : { target: n, asking: false, endKey: null, snoozed: false };
}
/** The answer to save for Yes or for "15 more mins" (Esc too). Keeps the reminder field. */
export function answer(ans: CdAns, endKey: string, act: "yes" | "snooze", now: number): CdAns {
  const out: CdAns = { end: endKey };
  if (act === "yes") out.yes = true;
  else out.snooze = iso(now + SNOOZE_MS);
  if (ans.rem) out.rem = ans.rem;
  return out;
}

// ---------- the island reminders ----------
/** The reminder due now (its time, ms), or null. Reminders fall every `every` hours counting back from the end (09:00, 06:00 ... for
 *  noon and 3 hours), never at the end itself, never in the 15 more mins, and the newest one only, until it is acknowledged. */
export function remindDue(p: CdPrefs, st: CdNow, ans: CdAns, tz: string, now: number, since: number): number | null {
  if (!p.on || !p.remind || st.asking || st.snoozed || st.target === null) return null;
  const step = p.every * H;
  const k = Math.ceil((st.target - now) / step);
  const slot = st.target - k * step;
  if (k < 1 || slot > now || slot <= since) return null;
  const start = prevEnd(p, tz, now);
  if (start !== null && slot <= start) return null;
  if (now - slot >= step) return null;
  if (ans.rem && Date.parse(ans.rem) >= slot) return null;
  return slot;
}
/** The next moment a reminder can fall (ms), for the phone's alarm. */
export function nextRemind(p: CdPrefs, st: CdNow, now: number): number | null {
  if (!p.on || !p.remind || st.asking || st.target === null) return null;
  const step = p.every * H;
  const k = Math.floor((st.target - now) / step);
  const at = st.target - k * step;
  return k >= 1 && at > now ? at : null;
}
export function remAck(ans: CdAns, slot: number): CdAns { return { ...ans, rem: iso(slot) }; }

// ---------- words and numbers ----------
/** "4:12:09", "12:09", "0:00", the same as the Mac's island (IslandTimersCore.swift TimersCore.clock). */
export function clock(ms: number): string {
  const t = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p2 = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p2(m)}:${p2(s)}` : `${m}:${p2(s)}`;
}
/** "4h 12m", "35m", "45s". */
export function leftWords(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.ceil(ms / 1000))}s`;
  const m = Math.ceil(ms / 60_000), h = Math.floor(m / 60);
  return h > 0 ? (m % 60 ? `${h}h ${m % 60}m` : `${h}h`) : `${m}m`;
}
export const WORDS = {
  endAsk: "End day now?",
  yes: "Yes",
  snooze: "Give me 15 more mins",
  remind: (ms: number) => `You have ${leftWords(ms)} left`,
  ack: "Acknowledged",
  settings: "Settings",
  missed: "Missed",
  tip: (hm: string) => `Time left until your day ends at ${hm}. Right click for Settings.`,
  /** Settings, Countdown text, Day ends (PS 1.72): the choice that follows the reset time, with that time. */
  sameAsReset: (hm: string) => `Same as reset time (${hm})`,
};
/** How alive the numbers are near zero: 0 calm, 1 a soft glow (an hour out), 2 warmer (15 minutes), 3 a small rumble (3 minutes). */
export function livelyStage(leftMs: number, asking: boolean): 0 | 1 | 2 | 3 {
  if (asking) return 3;
  if (leftMs <= 3 * M) return 3;
  if (leftMs <= 15 * M) return 2;
  if (leftMs <= H) return 1;
  return 0;
}

// ---------- Priority 1 timers ----------
/** A Priority 1 task's own clock: the moment its 24 hours run out (ms), or null when it has none (not P1, done, daily, or no start
 *  yet: the clock starts while Priority 1 is shared with the squad, core/squadp1.ts). At 24 hours nothing changes on the task:
 *  the row says Missed, as the squad panel does, and the day log counts it once (core/taskhist.ts), exactly as before. */
export function p1Deadline(t: { p1?: boolean; p1At?: string | null; p1Since?: string | null; done?: boolean; type?: string }, now: number): number | null {
  if (t.p1 !== true || t.done || t.type === "daily") return null;
  // PS 1.73: the squad's clock first, else your own (Todo.p1Since, core/duealerts.ts), so a P1 that is not shared has its timer
  // too, and it is the same 24 hours the Priority 1 alarm rings for.
  const s = cleanStart(t.p1At, now) ?? cleanStart(t.p1Since, now);
  return s ? Date.parse(s) + P1_WINDOW_MS : null;
}
