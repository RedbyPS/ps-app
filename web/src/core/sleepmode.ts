// Sleep mode (V1.40). The developer: a Sleep button with a bed icon and floating Z's at the end of the task list, next to
// Resurrect. Pressing it shows a calm full screen with a big clock and "Asleep for X"; alarms wake you; near the
// wake time a panel rises with today's tasks and how many people in your G Squad are working; Wake up goes back to
// PS and fills in last night's sleep in the Sleep log (you confirm it first, and can change it). Day sleep counts.
// "Implement it for any device that you have connected to the PS app" (the developer, 7 Nov 2026):
// - Mac: PS's own full screen window (ps-mac SleepScreen.swift). The Mac is kept awake while it is up, only on
//   mains power (a warning on battery, it stops at 20 percent), and leaving it needs Touch ID or the Mac password.
// - GrapheneOS phone: a screen over the lock screen like an alarm clock (ps-gos Sleep.kt), exact alarms that ring
//   through PS Do Not Disturb.
// - iPhone web app and the website: this page's own screen (views/SleepMode.tsx) with a screen wake lock. Alarms
//   there only ring while the page stays open and on screen, and the screen says so.
// Pure rules here (tests/sleepmode.test.ts). The settings live in the vault settings record (`sleepMode`, synced
// like every setting); "went to sleep" and "woke up" live in the Fitness settings record (`sleepOpen`, the Sleep
// log's own hook), so any device can finish a sleep another one started.
// Privacy by default: the screen shows COUNTS only (never a task title, a client's name or message text) unless the
// person switches "Show full details" on. A shell gets task titles only when it is on.
import { fmtMins, spanFromClock, makeLog, logFromSleepMode, dayIn, clockIn, sleepMins, MAX_BREAKS, type SleepBreak, type SleepLog } from "./sleep.ts";
import type { OpenSleep } from "./fitness.ts";
import { zonedToTs, wall } from "./tz.ts";
import { okLevel } from "./alarmsound.ts";
import { planList, ringMs, ringWantsList, type PlanList } from "./alarmlist.ts";
import { SENTRY_SPOT_DEF, okSpot, sleepSentry, type RestartFacts, type SentryPrefs, type SentrySpot, type SleepSentry } from "./sentry.ts";
import { cleanOnce, onceLine, onceRing, onceTimes, onceView, onceWords, type AlarmOnce } from "./alarmonce.ts";
import { WAKE_DEF, cleanTimer, cleanWake, countdownLine, okStyle, okWakeIn, styleOf, wakeInAt, wakeInChoices, type SleepTimer, type WakePrefs, type WakeStyle } from "./sleepwake.ts";

/** at: "HH:MM" on this device's clock; V1.43 style: how it wakes you (the light); V1.47 sound: what it plays (AlarmSound). */
export interface SleepAlarm { id: string; at: string; on: boolean; style?: WakeStyle; sound?: AlarmSound }
/** V1.47 (the developer's friend: "I added a custom sound as an alarm, but I don't know how to select it in my alarm ... It should
 *  all be together"): each alarm's own sound. "auto" (or none): as before, the playlist when it is on, else your own
 *  sound, else the built in one. "builtin": the built in one. "own": your own sound. "list": the day's playlist file.
 *  "t:<id>": one file from the playlist's files, every day. */
export type AlarmSound = "auto" | "builtin" | "own" | "list" | `t:${string}`;
export const okSound = (v: unknown): v is AlarmSound => typeof v === "string" && (["auto", "builtin", "own", "list"].includes(v) || /^t:[0-9a-f]{16}$/.test(v));
export interface SleepModePrefs {
  show?: boolean;          // the Sleep button at the end of the list (default on)
  alarms?: SleepAlarm[];   // up to MAX_ALARMS wake times; none means silent all night
  details?: boolean;       // the screen shows task titles too (default off: counts only)
  panel?: number;          // minutes before the wake time the panel rises (default 30)
  ask?: boolean;           // after Wake up, ask to save the sleep in the Sleep log (default on)
  look?: SleepLook;        // V1.42: how the sleep screen looks (Customise)
  lock?: boolean;          // V1.43: Wake up asks for Touch ID or the password (the phone: its own unlock). Default on.
  wake?: WakePrefs;        // V1.43: the wake styles' settings (core/sleepwake.ts)
  ringAlways?: boolean;    // V1.47: alarms ring at their time even when Sleep mode is off (Mac and phone). Default on.
  once?: AlarmOnce | null; // PS 1.65 Just tomorrow: the next morning only, moved or skipped (core/alarmonce.ts). The main alarms are untouched.
}
export interface SleepModeView { show: boolean; alarms: SleepAlarm[]; details: boolean; panel: number; ask: boolean; look: SleepLook; lock: boolean; wake: WakePrefs; ringAlways: boolean; once: AlarmOnce | null }
/** The whole settings record from the view, for a save (a save replaces sleepMode, so every field goes every time). */
export function prefsOf(v: SleepModeView): SleepModePrefs {
  return { show: v.show, alarms: v.alarms, details: v.details, panel: v.panel, ask: v.ask, look: v.look, lock: v.lock, wake: v.wake, ringAlways: v.ringAlways, once: v.once };
}

// ---------- the sleep screen's look (V1.42, the developer: "I want everything to be very customisable on the sleep screen") ----------
// V1.43 (the developer): "more fonts and letter styles, more colour options and a colour wheel". Every font is bundled with
// PS (no network): the web page and the Mac load the same files, the phone uses the nearest font it has.
export type ClockFont = "thin" | "rounded" | "mono" | "serif" | "bold" | "clean" | "type" | "digital" | "pixel" | "hand" | "marker" | "chalk";
export type ClockColor = "amber" | "red" | "white" | "green" | "blue" | "violet" | "deep" | "orange" | "gold" | "teal" | "pink" | "ice";
/** A colour: one of the presets, or any #rrggbb from the colour wheel. */
export type Ink = ClockColor | string;
export type SleepBg = "black" | "dim" | "ps" | string;   // V1.43: or any #rrggbb
export type ClockPos = "top" | "center" | "bottom";
export type WatchSize = "off" | "small" | "big";
export interface SleepPieces { asleep: boolean; alarm: boolean; date: boolean; panel: boolean; tasks: boolean; squad: boolean; count: boolean }
export interface SleepLook {
  size: number;        // clock size, percent of the usual (SIZE_MIN to SIZE_MAX)
  font: ClockFont;
  weight: number;      // V1.43: 0 the font's own weight, else 100 to 900
  spacing: number;     // V1.43: letter spacing added to the font's own, hundredths of the letter size (SPACING_MIN to SPACING_MAX)
  h12: boolean;        // 12 hour clock (default 24 hour)
  secs: boolean;       // seconds on the clock
  color: Ink;          // the clock
  text: Ink | "same";  // V1.43: the other words on the screen (date, Asleep for, alarms, stopwatch, panel); "same" follows the clock
  bright: number;      // how bright the clock is, percent (BRIGHT_MIN to 100)
  bg: SleepBg;         // near black, a dim shade of the clock colour, or the PS background
  pos: ClockPos;       // where the clock sits
  show: SleepPieces;   // which pieces show
  watch: WatchSize;    // the stopwatch: off, small or big
  pointer: number;     // the mouse pointer hides after this many seconds still (0: never hides)
  // V1.43 (the developer: "the option to have a clock face as well"): an analogue face instead of the digits.
  face: ClockFace;     // digital or analogue
  dial: DialStyle;     // the analogue face's marks: minimal ticks, numbers or roman numerals
  hand: SecondHand;    // the second hand: a smooth sweep, a tick each second, or none
  faceInk: Ink | "same";   // the face's ring and glow ("same": the clock colour)
  handInk: Ink | "same";   // the hands
  tickInk: Ink | "same";   // the ticks and numbers
  digi: boolean;       // the digital time small under the face
  sentry: SentrySpot;  // V1.52 (the developer): where the AI Sentry mode button sits on the Mac's sleep screen, or hidden (core/sentry.ts)
}
export type ClockFace = "digital" | "analogue";
export type DialStyle = "ticks" | "numbers" | "roman";
export type SecondHand = "sweep" | "tick" | "none";
export const DIAL_NAMES: Record<DialStyle, string> = { ticks: "Minimal ticks", numbers: "Numbers", roman: "Roman" };
export const HAND_NAMES: Record<SecondHand, string> = { sweep: "Smooth sweep", tick: "Ticking", none: "No second hand" };
export const SIZE_MIN = 40, SIZE_MAX = 300, BRIGHT_MIN = 10, POINTER_MAX = 60;
export const SPACING_MIN = -10, SPACING_MAX = 40;
export const FONTS: ClockFont[] = ["thin", "bold", "rounded", "clean", "mono", "type", "serif", "digital", "pixel", "hand", "marker", "chalk"];
export const FONT_NAMES: Record<ClockFont, string> = {
  thin: "Thin", rounded: "Rounded", mono: "Mono", serif: "Serif", bold: "Bold", clean: "Clean", type: "Typewriter",
  digital: "Digital", pixel: "Pixel", hand: "Handwritten", marker: "Marker", chalk: "Chalk",
};
/** The weights to pick from (0: the font's own). A font without that weight shows its nearest one. */
export const WEIGHTS = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900];
export const WEIGHT_NAMES: Record<number, string> = { 0: "Usual", 100: "Hairline", 200: "Thin", 300: "Light", 400: "Regular", 500: "Medium", 600: "Semibold", 700: "Bold", 800: "Heavy", 900: "Black" };
export const COLORS: Record<ClockColor, [number, number, number]> = {
  amber: [231, 163, 94], red: [214, 74, 56], white: [236, 226, 210], green: [126, 200, 146], blue: [122, 170, 238], violet: [178, 150, 240],
  deep: [150, 28, 18], orange: [242, 134, 58], gold: [232, 196, 92], teal: [86, 200, 190], pink: [240, 140, 182], ice: [206, 226, 255],
};
export const COLOR_NAMES: Record<ClockColor, string> = {
  amber: "Amber", red: "Night red", white: "Warm white", green: "Green", blue: "Blue", violet: "Violet",
  deep: "Deep red", orange: "Orange", gold: "Gold", teal: "Teal", pink: "Pink", ice: "Ice",
};
/** Background presets besides near black, dim colour and the PS background. */
export const BGS: { hex: string; name: string }[] = [
  { hex: "#000000", name: "Black" }, { hex: "#070a18", name: "Midnight" }, { hex: "#0d0612", name: "Plum" }, { hex: "#04100a", name: "Forest" },
  { hex: "#131316", name: "Charcoal" }, { hex: "#1a0703", name: "Ember" },
];
export const POINTER_STEPS = [0, 2, 3, 5, 10, 30];
export const PIECE_NAMES: Record<keyof SleepPieces, string> = {
  asleep: "Asleep for", alarm: "Alarms", date: "Date", count: "Countdown", panel: "Wake time panel", tasks: "Today's tasks", squad: "G Squad working",
};
export const LOOK_DEF: SleepLook = {
  size: 100, font: "thin", weight: 0, spacing: 0, h12: false, secs: false, color: "amber", text: "same", bright: 78, bg: "black", pos: "center",
  show: { asleep: true, alarm: true, date: false, panel: true, tasks: true, squad: true, count: false }, watch: "small", pointer: 3,
  face: "digital", dial: "ticks", hand: "sweep", faceInk: "same", handInk: "same", tickInk: "same", digi: true,
  sentry: SENTRY_SPOT_DEF,
};
const pick = <T extends string>(v: unknown, all: readonly T[], def: T): T => (all as readonly unknown[]).includes(v) ? v as T : def;
const num = (v: unknown, lo: number, hi: number, def: number) => v !== undefined && v !== null && Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : def;
const isHex = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const ink = (v: unknown, def: Ink): Ink => isHex(v) ? v.toLowerCase() : (Object.keys(COLORS) as unknown[]).includes(v) ? v as ClockColor : def;
/** A look from any page, checked: every field known, in range, with the default for anything missing or odd. */
export function cleanLook(v: unknown): SleepLook {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const sh = (o.show && typeof o.show === "object" ? o.show : {}) as Record<string, unknown>;
  const show = { ...LOOK_DEF.show };
  for (const k of Object.keys(show) as (keyof SleepPieces)[]) if (typeof sh[k] === "boolean") show[k] = sh[k] as boolean;
  return {
    size: num(o.size, SIZE_MIN, SIZE_MAX, LOOK_DEF.size),
    font: pick(o.font, FONTS, LOOK_DEF.font),
    weight: WEIGHTS.includes(Math.round(Number(o.weight) / 100) * 100) && Number(o.weight) > 0 ? Math.round(Number(o.weight) / 100) * 100 : 0,
    spacing: num(o.spacing, SPACING_MIN, SPACING_MAX, LOOK_DEF.spacing),
    h12: typeof o.h12 === "boolean" ? o.h12 : LOOK_DEF.h12,
    secs: typeof o.secs === "boolean" ? o.secs : LOOK_DEF.secs,
    color: ink(o.color, LOOK_DEF.color),
    text: o.text === "same" ? "same" : ink(o.text, "same"),
    bright: num(o.bright, BRIGHT_MIN, 100, LOOK_DEF.bright),
    bg: isHex(o.bg) ? o.bg.toLowerCase() : pick(o.bg, ["black", "dim", "ps"] as const, LOOK_DEF.bg as "black"),
    pos: pick(o.pos, ["top", "center", "bottom"] as const, LOOK_DEF.pos),
    show,
    watch: pick(o.watch, ["off", "small", "big"] as const, LOOK_DEF.watch),
    pointer: num(o.pointer, 0, POINTER_MAX, LOOK_DEF.pointer),
    face: pick(o.face, ["digital", "analogue"] as const, LOOK_DEF.face),
    dial: pick(o.dial, ["ticks", "numbers", "roman"] as const, LOOK_DEF.dial),
    hand: pick(o.hand, ["sweep", "tick", "none"] as const, LOOK_DEF.hand),
    faceInk: o.faceInk === "same" ? "same" : ink(o.faceInk, "same"),
    handInk: o.handInk === "same" ? "same" : ink(o.handInk, "same"),
    tickInk: o.tickInk === "same" ? "same" : ink(o.tickInk, "same"),
    digi: typeof o.digi === "boolean" ? o.digi : LOOK_DEF.digi,
    sentry: okSpot(o.sentry) ? o.sentry : LOOK_DEF.sentry,
  };
}
const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
const toHex = ([r, g, b]: [number, number, number]) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
export const NIGHT = "#050302";
/** A colour as #rrggbb (a preset, or a wheel colour as it is). */
export function inkHex(c: Ink): string { return isHex(c) ? c.toLowerCase() : toHex(COLORS[c as ClockColor] ?? COLORS.amber); }
const inkRgb = (c: Ink): [number, number, number] => { const n = parseInt(inkHex(c).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
/** The background as #rrggbb: near black, a very dim shade of the clock colour, or the PS background (psBase, the
 *  look's base colour the page reads; near black when it has none). */
export function bgHex(l: { bg: SleepBg; color: Ink }, psBase?: string | null): string {
  if (isHex(l.bg)) return l.bg.toLowerCase();
  if (l.bg === "dim") { const [r, g, b] = inkRgb(l.color); return toHex([r * 0.085 + 2, g * 0.085 + 2, b * 0.085 + 2]); }
  if (l.bg === "ps" && psBase && /^#[0-9a-f]{6}$/i.test(psBase.trim())) return psBase.trim().toLowerCase();
  return NIGHT;
}
/** The clock face: "07:05" or "7:05" with "AM", seconds when on. On this device's own clock. */
export function clockText(ms: number, l: Pick<SleepLook, "h12" | "secs">): { time: string; ampm: string | null } {
  const d = new Date(ms);
  const h = d.getHours(), m = String(d.getMinutes()).padStart(2, "0"), s = String(d.getSeconds()).padStart(2, "0");
  const hh = l.h12 ? String(h % 12 === 0 ? 12 : h % 12) : String(h).padStart(2, "0");
  return { time: `${hh}:${m}${l.secs ? `:${s}` : ""}`, ampm: l.h12 ? (h < 12 ? "AM" : "PM") : null };
}

// ---------- the stopwatch (V1.42): times, not ticks, so it stays right while the screen dims or the page sleeps ----------
export interface Stopwatch { run: boolean; from: number | null; acc: number }
export const WATCH_ZERO: Stopwatch = { run: false, from: null, acc: 0 };
export const watchMs = (w: Stopwatch, now: number) => Math.max(0, w.acc + (w.run && w.from != null ? now - w.from : 0));
export const watchStart = (w: Stopwatch, now: number): Stopwatch => w.run ? w : { run: true, from: now, acc: w.acc };
export const watchPause = (w: Stopwatch, now: number): Stopwatch => w.run ? { run: false, from: null, acc: watchMs(w, now) } : w;
export const watchReset = (): Stopwatch => ({ ...WATCH_ZERO });
/** "0:07", "12:34", "1:02:03". */
export function watchText(ms: number): string {
  const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = String(t % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
/** The look as the shells draw it: colours resolved to #rrggbb, brightness 0 to 1. */
export interface PlanLook {
  size: number; font: ClockFont; h12: boolean; secs: boolean; ink: string; bright: number; bg: string; pos: ClockPos;
  show: SleepPieces; watch: WatchSize; pointer: number;
  text: string; weight: number; spacing: number;   // V1.43: the other words' colour, the weight (0: the font's own), letter spacing
  face: ClockFace; dial: DialStyle; hand: SecondHand; faceInk: string; handInk: string; tickInk: string; digi: boolean;   // V1.43 the analogue face
  sentry: SentrySpot;   // V1.52: the AI Sentry mode button (the Mac only; an older shell ignores it)
}
export function planLook(l: SleepLook, psBase?: string | null): PlanLook {
  return { size: l.size, font: l.font, h12: l.h12, secs: l.secs, ink: inkHex(l.color), bright: l.bright / 100, bg: bgHex(l, psBase),
    pos: l.pos, show: { ...l.show }, watch: l.watch, pointer: l.pointer,
    text: inkHex(l.text === "same" ? l.color : l.text), weight: l.weight, spacing: l.spacing,
    face: l.face, dial: l.dial, hand: l.hand, digi: l.digi, sentry: l.sentry,
    faceInk: inkHex(l.faceInk === "same" ? l.color : l.faceInk), handInk: inkHex(l.handInk === "same" ? l.color : l.handInk), tickInk: inkHex(l.tickInk === "same" ? l.color : l.tickInk) };
}

// ---------- V1.43 the analogue face (the Mac and phone draw it from the same numbers) ----------
/** The hands' angles in degrees, clockwise from 12, at this device's local time. The hour and minute hands move
 *  smoothly; the second hand sweeps (smooth) or ticks (whole seconds). */
export function handAngles(d: Date, hand: SecondHand = "sweep"): { hour: number; minute: number; second: number } {
  const ms = d.getMilliseconds(), s = d.getSeconds() + (hand === "sweep" ? ms / 1000 : 0), m = d.getMinutes() + d.getSeconds() / 60, h = (d.getHours() % 12) + m / 60;
  return { hour: h * 30, minute: m * 6, second: s * 6 };
}
/** The face's marks: 60 ticks (the 12 hour marks longer), or 12 labels with small minute dots. */
export function dialMarks(dial: DialStyle): { angle: number; major: boolean; label: string | null }[] {
  const ROMAN = ["XII", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI"];
  return Array.from({ length: 60 }, (_, i) => {
    const major = i % 5 === 0, hr = i / 5;
    return { angle: i * 6, major, label: !major || dial === "ticks" ? null : dial === "roman" ? ROMAN[hr] : String(hr === 0 ? 12 : hr) };
  });
}

export const MAX_ALARMS = 5;
export const PANEL_DEF = 30, PANEL_MIN = 5, PANEL_MAX = 180;
export const RING_FOR = 10 * 60_000;       // a ring stops by itself after 10 minutes (like the gym ring)
export const RING_GRACE = 5 * 60_000;      // an alarm missed by up to 5 minutes (the device was busy) still rings
export const DRIFT = 6;                     // pixels either way, against burn in
export const DRIFT_EVERY = 90_000;          // a new position every 90 seconds
export const BATTERY_STOP = 20;             // Mac: Sleep mode stops at this battery percent

const okClock = (s: unknown): s is string => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const okId = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{1,24}$/.test(s);

/** A settings patch from any page, checked: unknown fields dropped, alarms kept to MAX_ALARMS, sorted by time. */
export function cleanSleepMode(v: unknown): SleepModePrefs {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const out: SleepModePrefs = {};
  if (typeof o.show === "boolean") out.show = o.show;
  if (typeof o.details === "boolean") out.details = o.details;
  if (typeof o.ask === "boolean") out.ask = o.ask;
  if (typeof o.lock === "boolean") out.lock = o.lock;
  if (typeof o.ringAlways === "boolean") out.ringAlways = o.ringAlways;
  if (o.look !== undefined && o.look !== null) out.look = cleanLook(o.look);
  if (o.once !== undefined) out.once = cleanOnce(o.once);
  if (o.wake !== undefined && o.wake !== null) out.wake = cleanWake(o.wake);
  if (o.panel !== undefined && Number.isFinite(Number(o.panel))) out.panel = Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.round(Number(o.panel))));
  if (Array.isArray(o.alarms)) {
    const seen = new Set<string>();
    out.alarms = o.alarms
      .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
      .map((a) => ({ id: okId(a.id) ? a.id : "", at: okClock(a.at) ? a.at : "", on: a.on !== false, ...(okStyle(a.style) ? { style: a.style } : {}), ...(okSound(a.sound) && a.sound !== "auto" ? { sound: a.sound } : {}) }))
      .filter((a) => a.id && a.at && !seen.has(a.id) && (seen.add(a.id), true))
      .slice(0, MAX_ALARMS)
      .sort((a, b) => a.at.localeCompare(b.at));
  }
  return out;
}
/** The settings with their defaults filled in. */
export function sleepModeOf(st: { sleepMode?: SleepModePrefs | null } | null | undefined): SleepModeView {
  const p = cleanSleepMode(st?.sleepMode);
  return { show: p.show !== false, alarms: p.alarms ?? [], details: p.details === true, panel: p.panel ?? PANEL_DEF, ask: p.ask !== false, look: p.look ?? cleanLook(null), lock: p.lock !== false, wake: p.wake ?? { ...WAKE_DEF }, ringAlways: p.ringAlways !== false, once: p.once ?? null };
}
/** A new alarm id (short, unique enough inside one list of five). */
export function newAlarmId(now = Date.now(), rnd = Math.random()): string { return `a${now.toString(36)}${Math.floor(rnd * 1296).toString(36)}`; }

// ---------- times ----------
/** The first moment after `after` when the clock in tz reads `hhmm` (today or tomorrow; a clock change is handled). */
export function nextAt(hhmm: string, after: number, tz: string): number | null {
  if (!okClock(hhmm)) return null;
  const [h, m] = hhmm.split(":").map(Number);
  const w = wall(after, tz);
  for (let i = 0; i < 3; i++) {
    const d = new Date(Date.UTC(w.y, w.mo - 1, w.d + i));
    const t = zonedToTs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, m, tz);
    if (t > after) return t;
  }
  return null;
}
/** V1.43: `style` is how it wakes you, `from` when its light starts (Sunrise: before the alarm; else the alarm time). */
export interface Ring { id: string; at: number; label: string; style?: WakeStyle; from?: number; sound?: AlarmSound; once?: true }
export const TIMER_ID = "timer";
/** Every switched on alarm, once, at its first time after you went to sleep, plus "Wake me up in" (V1.43), soonest
 *  first. `wake` resolves each style (Strobe flash only once switched on) and the sunrise's lead. */
/** PS 1.65 `once`: Just tomorrow (core/alarmonce.ts): the next morning's rings moved or skipped, the main alarms untouched. */
export function ringsFor(alarms: SleepAlarm[], since: number, tz: string, wake: WakePrefs = WAKE_DEF, timer?: SleepTimer | null, once?: AlarmOnce | null): Ring[] {
  const out: Ring[] = [];
  const ring = (id: string, at: number, label: string, s: unknown, sound?: AlarmSound): Ring => {
    const style = styleOf(s, wake);
    return { id, at, label, style, from: style === "sunrise" ? Math.max(since, at - wake.sunrise * 60_000) : at, ...(sound && sound !== "auto" ? { sound } : {}) };
  };
  const moved = onceTimes(alarms, once, tz);
  for (const a of alarms) {
    if (!a.on) continue;
    if (moved.has(a.id)) {
      const r = onceRing(a, since, tz, moved);
      if (r) out.push(r.moved ? { ...ring(a.id, r.at, clockOf(r.at, tz), a.style, a.sound), once: true } : ring(a.id, r.at, a.at, a.style, a.sound));
      continue;
    }
    const at = nextAt(a.at, since, tz);
    if (at != null) out.push(ring(a.id, at, a.at, a.style, a.sound));
  }
  const t = cleanTimer(timer);
  if (t && Date.parse(t.at) > since) out.push(ring(TIMER_ID, Date.parse(t.at), clockOf(Date.parse(t.at), tz), t.style));
  return out.sort((a, b) => a.at - b.at);
}
const clockOf = (ms: number, tz: string) => { const w = wall(ms, tz); return `${String(w.h).padStart(2, "0")}:${String(w.mi).padStart(2, "0")}`; };
/** The ring whose light is up before its alarm (Sunrise), or null. */
export function dawnRing(rings: Ring[], now: number, done: ReadonlySet<string>): Ring | null {
  for (const r of rings) if (!done.has(ringKey(r)) && r.from != null && r.from < r.at && now >= r.from && now < r.at) return r;
  return null;
}
/** When you mean to wake: the first alarm, else your usual wake time from the Sleep log (when it knows one), else
 *  none (then the panel never rises by itself; the screen can still show it on a tap). */
export function wakeAt(rings: Ring[], since: number, tz: string, usualWake?: string | null): number | null {
  if (rings.length) return rings[0].at;
  if (usualWake && okClock(usualWake)) {
    // At least an hour after going to sleep: a 03:10 bedtime with a usual 03:30 wake means tomorrow, not now.
    return nextAt(usualWake, since + 3600_000, tz);
  }
  return null;
}
/** When the panel rises: `mins` before the wake time (never before going to sleep). */
export function panelAt(wake: number | null, since: number, mins: number): number | null {
  if (wake == null) return null;
  return Math.max(since, wake - Math.max(PANEL_MIN, Math.min(PANEL_MAX, mins)) * 60_000);
}
/** Which ring is due now: due, inside its grace, not answered yet. */
export function ringDue(rings: Ring[], now: number, done: ReadonlySet<string>): Ring | null {
  for (const r of rings) if (!done.has(`${r.id}@${r.at}`) && now >= r.at && now < r.at + RING_GRACE) return r;
  return null;
}
export const ringKey = (r: Ring) => `${r.id}@${r.at}`;
/** V1.47 (the developer's friend: "The custom default should just play on a loop forever until the user turns it off"): what a
 *  ring plays, from its own sound (Ring.sound) and the plan. A custom sound that loops (your own sound, one playlist
 *  file, the playlist on loop) rings until Stop; the built in sound stops by itself after RING_FOR, and "Play the
 *  whole file" when the file ends. `haveOwn`: this device has your own sound. */
export type RingPlay = { kind: "builtin"; len: number } | { kind: "own"; len: number } | { kind: "track"; id: string; loop: boolean; fade: number; len: number };
export const FOREVER = Number.POSITIVE_INFINITY;
export function ringPlay(r: Pick<Ring, "sound">, list: PlanList | null | undefined, day: string, haveOwn: boolean): RingPlay {
  const s = r.sound ?? "auto";
  if (s === "builtin") return { kind: "builtin", len: RING_FOR };
  if ((s as string) === "style") return haveOwn ? { kind: "own", len: FOREVER } : { kind: "builtin", len: RING_FOR };   // the playlist chat's "the usual sound"
  if (s.startsWith("t:")) return { kind: "track", id: s.slice(2), loop: true, fade: list?.fade ?? 0, len: FOREVER };
  if (s === "list" || (s === "auto" && list && list.on !== false)) {
    const pick = list?.days[day];
    if (list && pick) return { kind: "track", id: pick.id, loop: list.end === "loop", fade: list.fade, len: list.end === "loop" ? FOREVER : ringMs("whole", pick.secs) };
  }
  return haveOwn ? { kind: "own", len: FOREVER } : { kind: "builtin", len: RING_FOR };
}
/** Is a ring that started at `start` still ringing (it stops by itself after RING_FOR)? */
/** V1.47: `len` a playlist's "Play the whole file" ring (core/alarmlist.ts ringMs); else the usual RING_FOR. */
export const stillRinging = (start: number, now: number, len = RING_FOR) => now >= start && now < start + len;

/** The screen's small drift against burn in: a slow walk inside +/- DRIFT pixels, a new spot every 90 s. */
export function drift(now: number): { x: number; y: number } {
  const k = Math.floor(now / DRIFT_EVERY);
  return { x: Math.round(DRIFT * Math.sin(k * 0.71)), y: Math.round(DRIFT * Math.cos(k * 0.53)) };
}

// ---------- words (drafts for the developer's yes) ----------
/** "Asleep for 7 h 05", "Asleep for 12 min", "Asleep for a moment". */
export function asleepFor(since: number, now: number): string {
  const m = Math.floor((now - since) / 60_000);
  return m < 1 ? "Asleep for a moment" : `Asleep for ${fmtMins(m)}`;
}
export function taskLine(n: number): string { return n <= 0 ? "Nothing on your list for today" : n === 1 ? "1 task for today" : `${n} tasks for today`; }
/** "4 people are working". Null (the line is hidden) when there is no G Squad yet. */
export function squadLine(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n < 0) return null;
  return n === 0 ? "Nobody in your G Squad is working yet" : n === 1 ? "1 person is working" : `${Math.round(n)} people are working`;
}
/** "Alarm 07:30", "Alarms 07:30 and 08:00", "No alarm, silent all night". */
export function alarmLine(rings: Ring[]): string {
  if (!rings.length) return "No alarm, silent all night";
  const t = rings.map((r) => r.id === TIMER_ID ? `${r.label} (Wake me up in)` : r.label);
  return rings.length === 1 ? `Alarm ${t[0]}` : `Alarms ${t.slice(0, -1).join(", ")} and ${t[t.length - 1]}`;
}

// ---------- today's tasks (counts by default) ----------
export interface TaskLite { title: string; type: "daily" | "once"; done: boolean; clearedAt?: string | null; due?: string | null; order?: number; p1?: boolean }
/** What is on today: open one off tasks due today or earlier (or with no date) and every repeating task not done. */
export function todayTasks(list: TaskLite[], today: string): TaskLite[] {
  return list
    .filter((t) => !t.done && !t.clearedAt && (t.type === "daily" || !t.due || t.due.slice(0, 10) <= today))
    .sort((a, b) => Number(!!b.p1) - Number(!!a.p1) || (a.type === b.type ? 0 : a.type === "once" ? -1 : 1) || (a.order ?? 0) - (b.order ?? 0));
}

// ---------- the plan handed to the Mac and phone shells ----------
export interface SleepPlan {
  v: 1;
  since: number;             // went to sleep (ms)
  tz: string;                // this device's zone, for the clock
  rings: Ring[];
  wake: number | null;       // when the panel's countdown points at
  panel: number | null;      // when the panel rises
  details: boolean;          // titles below are only ever filled when true
  tasks: { count: number; titles: string[] };
  squad: number | null;      // people working right now; null = no G Squad yet (the line is hidden)
  look: PlanLook;            // V1.42: how the screen looks (an older shell ignores it)
  lock: boolean;             // V1.43: Wake up asks for Touch ID or the password (an older shell always asks)
  styles: { wave: string; sunrise: number; strobe: boolean; timer: WakeStyle; level: number };   // V1.43: Colour wave's colour, the sunrise's minutes, strobe on, the timer's style; V1.44: the alarm loudness (an older shell ignores it)
  wakeIn: { name: string; mins: number; sleep: number }[];     // V1.43: "Wake me up in" suggestions (core/sleepwake.ts SLEEP_CYCLES)
  timer: { at: number; mins: number } | null;                  // V1.43: "Wake me up in" set for this sleep
  list: PlanList | null;     // V1.47: the alarm playlist: each day's file, the ending and the fade (null: no files; `on`: every "auto" alarm plays it)
  alarmOnly?: boolean;       // V1.47: an alarm while Sleep mode is off: the screen only rings, Stop closes it, nothing is logged
  once?: PlanOnce;           // PS 1.65 Just tomorrow: the line and the choices for the sleep screen (an older shell ignores it)
  sentry?: SleepSentry;      // V1.52: the AI Sentry mode button's settings, restart check and words (the Mac only; never with alarmOnly)
  words: SleepWords;         // every sentence the shells draw, so they all say the same thing
}
/** PS 1.65 Just tomorrow, for the Mac's and the phone's sleep screens: the line, and the words of the choices. A shell asks its own
 *  Touch ID or unlock (with `words.reason`) and only then sends the choice back ({once: {act, mins, at}} on a Mac,
 *  {type: "sleep:once", act, mins, at} on a phone); the page saves it. */
export interface PlanOnce {
  set: boolean;              // an override is in place (Undo shows)
  skipped: boolean;
  line: string;              // "Just tomorrow: 09:00" or "Tomorrow only: 10:30 (your usual 09:00 is back the day after)"
  usual: string;             // the first alarm's usual time, "09:00" (Pick a time starts there)
  words: ReturnType<typeof onceWords>;
}
export interface SleepWords {
  title: string; wakeUp: string; stop: string; ringing: string; tasks: string; squad: string | null; alarm: string;
  battery: string; locked: string; hint: string;
  start: string; pause: string; reset: string; customise: string; watch: string;
  breakAsk: string; breakBack: string; breakMore: string; breakUp: string; onBreak: string;
  wakeIn: string; wakeInSet: string; wakeInClear: string; wakeInCustom: string; countdown: string | null; loudNote: string;
}
export function sleepWords(p: { rings: Ring[]; tasks: number; squad: number | null; lock?: boolean; now?: number }): SleepWords {
  return {
    title: "Sleep mode",
    wakeUp: "Wake up",
    stop: "Stop alarm",
    ringing: "Good morning",
    tasks: taskLine(p.tasks),
    squad: squadLine(p.squad),
    alarm: alarmLine(p.rings),
    battery: "On battery. Plug in to keep Sleep mode on all night. It stops at 20%.",
    locked: p.lock === false ? "Wake up leaves at once. Esc also leaves, and locks PS app." : "Wake up asks for Touch ID or your Mac password. Esc also leaves, and locks PS app.",
    hint: "Press the power button to lock. The clock comes back over the lock screen. Press it again to keep the screen dark.",
    start: "Start", pause: "Pause", reset: "Reset", customise: "Customise", watch: "Stopwatch",
    breakAsk: "Go back to sleep?", breakBack: "Back to sleep", breakMore: "5 more minutes", breakUp: "I'm up now", onBreak: "On a break",
    wakeIn: "Wake me up in", wakeInSet: "Set", wakeInClear: "No timer", wakeInCustom: "Your own",
    countdown: p.rings.length && p.now != null ? countdownLine(p.rings[0].at, p.now) : null,
    loudNote: "Loud turns your volume up for the alarm and puts it back after.",
  };
}
export function buildPlan(o: {
  since: number; tz: string; prefs: SleepModeView; usualWake?: string | null;
  tasks: TaskLite[]; squad: number | null; psBase?: string | null; timer?: SleepTimer | null; now?: number; alarmOnly?: boolean;
  /** V1.52: on a Mac, Sentry mode's settings and the restart helper's state (ps.ts RebootSettings), for the button. */
  sentry?: { prefs: SentryPrefs; reboot: RestartFacts | null | undefined } | null;
  /** PS 1.65: Just tomorrow is switched on (feature "alarm-once"): the override counts and the plan carries its line. */
  onceOn?: boolean;
}): SleepPlan {
  const timer = cleanTimer(o.timer);
  const once = o.onceOn ? o.prefs.once : null;
  const rings = ringsFor(o.prefs.alarms, o.since, o.tz, o.prefs.wake, timer, once);
  const ov = o.onceOn ? onceView(o.prefs.alarms, once, o.now ?? o.since, o.tz) : null;
  const wake = wakeAt(rings, o.since, o.tz, o.usualWake);
  const titles = o.prefs.details ? o.tasks.slice(0, 6).map((t) => t.title.replace(/\s+/g, " ").trim().slice(0, 90)) : [];
  return {
    v: 1, since: o.since, tz: o.tz, rings, wake, panel: panelAt(wake, o.since, o.prefs.panel), details: o.prefs.details,
    tasks: { count: o.tasks.length, titles }, squad: o.squad, look: planLook(o.prefs.look, o.psBase), lock: o.prefs.lock,
    styles: { wave: o.prefs.wake.wave, sunrise: o.prefs.wake.sunrise, strobe: o.prefs.wake.strobe, timer: styleOf(o.prefs.wake.timer, o.prefs.wake), level: okLevel(o.prefs.wake.level) },
    wakeIn: wakeInChoices().map((c) => ({ name: c.name, mins: c.mins, sleep: c.sleep })),
    timer: timer && Date.parse(timer.at) > o.since ? { at: Date.parse(timer.at), mins: timer.mins } : null,
    // V1.47: `on` says whether every default alarm plays it, or only the alarms set to it (ringPlay).
    list: (() => {
      const pl = planList(o.prefs.wake.list, o.now ?? o.since, o.tz, rings.map((r) => r.at), 3, rings.some((r) => ringWantsList(r.sound)));
      return pl ? { ...pl, on: o.prefs.wake.list.on } : null;
    })(),
    ...(o.alarmOnly ? { alarmOnly: true } : {}),
    ...(ov && !o.alarmOnly ? { once: { set: ov.state === "set", skipped: ov.state === "set" && ov.skipped, line: onceLine(ov), usual: ov.usual[0], words: onceWords(ov.day) } } : {}),
    ...(o.sentry && !o.alarmOnly ? { sentry: sleepSentry(o.sentry.prefs, o.sentry.reboot) } : {}),
    words: sleepWords({ rings, tasks: o.tasks.length, squad: o.squad, lock: o.prefs.lock, now: o.now }),
  };
}

// ---------- after Wake up: the sleep to confirm ----------
export interface Proposal {
  day: string; asleep: string; wake: string; mins: number;
  log: SleepLog | null;
  why: "ok" | "short" | "long";
}
/** The sleep Wake up would save (fell asleep, woke up, how long), shown for a yes before anything is saved. */
export function propose(open: { at: string; tz: string; breaks?: SleepBreak[] | null }, woke: number, now = new Date()): Proposal | null {
  const start = Date.parse(open.at);
  if (!Number.isFinite(start) || !(woke > start)) return null;
  const tz = open.tz || "UTC";
  const log = logFromSleepMode(start, woke, tz, now, open.breaks);
  const mins = log ? sleepMins(log) : Math.round((woke - start) / 60_000);
  return { day: dayIn(woke, tz), asleep: clockIn(start, tz), wake: clockIn(woke, tz), mins, log,
    why: log ? "ok" : mins < 30 ? "short" : "long" };
}
/** The same sleep with the times changed by hand on the card (woke on `day`, the times in tz). */
export function editedLog(day: string, asleep: string, wake: string, tz: string, now = new Date(), breaks?: SleepBreak[] | null): SleepLog | null {
  const s = spanFromClock(day, asleep, wake, tz);
  return s ? makeLog({ start: s.start, end: s.end, tz, src: "sleepmode", breaks }, now) : null;
}

// ---------- short breaks (V1.43). The developer: Wake up asks "Up for the day, or just checking something?" ----------
// "I'm up" ends the sleep. "Back to sleep in" (5 to 120 minutes) leaves the screen and keeps the sleep open as a
// break. When it is up: "Go back to sleep?" with Back to sleep, 5 more minutes, I'm up now; asked again every
// BREAK_REASK, and after BREAK_ASKS asks with no answer the sleep ends at the last moment of activity. The Sleep log
// keeps the breaks and counts time asleep without them.
export const BREAK_STEPS = Array.from({ length: 24 }, (_, i) => (i + 1) * 5);   // 5, 10, ... 120 minutes
export const BREAK_DEF = 5, BREAK_MORE = 5;
export const BREAK_REASK = 5 * 60_000, BREAK_ASKS = 3;
type Open = OpenSleep;
const iso = (ms: number) => new Date(ms).toISOString();
/** Wake up pressed: the sleep waits for "I'm up" or "Back to sleep in" (any device can answer). A "Wake me up in"
 *  that has already rung is done with (it never rings again after Back to sleep); one still to come is kept. */
export const pauseOpen = (o: Open, at: number): Open => ({ ...o, paused: iso(at), brk: null, ...(o.timer && !(Date.parse(o.timer.at) > at) ? { timer: null } : {}) });
/** "Wake me up in `mins`" from `now` (null: no timer), on the open sleep so every device rings it. */
export function timerOpen(o: Open, mins: number | null, now: number, style: WakeStyle): Open {
  const m = mins == null ? null : okWakeIn(mins);
  return { ...o, timer: m == null ? null : { at: iso(wakeInAt(now, m)), mins: m, style } };
}
/** "I'm up" (or "I'm up now" on a break): the sleep ends when you first got up. */
export function upOpen(o: Open, at: number): Open {
  const from = o.brk ? Date.parse(o.brk.from) : o.paused ? Date.parse(o.paused) : at;
  return { ...o, woke: iso(Number.isFinite(from) ? from : at), paused: null, brk: null };
}
/** "Back to sleep in N minutes": a break from the moment you got up. */
export function breakOpen(o: Open, mins: number, now: number, dev: "mac" | "phone" | "web"): Open {
  const n = BREAK_STEPS.includes(mins) ? mins : BREAK_DEF;
  const from = o.paused && Number.isFinite(Date.parse(o.paused)) ? Date.parse(o.paused) : now;
  return { ...o, paused: null, brk: { from: iso(from), until: iso(now + n * 60_000), dev } };
}
/** "Back to sleep": the break is over and kept, the sleep goes on. */
export function resumeOpen(o: Open, now: number): Open {
  if (!o.brk && !o.paused) return o;
  const from = Date.parse(o.brk ? o.brk.from : o.paused!);   // a Wake up never answered, then Sleep again: a break too
  const breaks = [...(o.breaks ?? []), ...(Number.isFinite(from) && now > from ? [{ start: iso(from), end: iso(now) }] : [])].slice(-MAX_BREAKS);
  return { ...o, brk: null, paused: null, breaks };
}
/** "5 more minutes". */
export const moreOpen = (o: Open, now: number): Open => o.brk ? { ...o, brk: { ...o.brk, until: iso(now + BREAK_MORE * 60_000) } } : o;
/** No answer after BREAK_ASKS asks: the sleep ends at the last moment of activity (never before the break began);
 *  the time up is kept as a break, so it never counts as sleep. */
export function timeoutOpen(o: Open, lastActive: number, now: number): Open {
  if (!o.brk) return o;
  const from = Date.parse(o.brk.from);
  const end = Math.min(now, Math.max(Number.isFinite(from) ? from : now, Number.isFinite(lastActive) ? lastActive : now));
  const breaks = [...(o.breaks ?? []), ...(end > from ? [{ start: o.brk.from, end: iso(end) }] : [])].slice(-MAX_BREAKS);
  return { ...o, woke: iso(end), brk: null, paused: null, breaks };
}
/** Where a break stands at `now`: "running" (before its time), "ask" with which ask (1 to BREAK_ASKS), or "end". */
export function breakStage(brk: { until: string } | null | undefined, now: number): { stage: "none" | "running" | "ask" | "end"; ask: number } {
  const u = brk ? Date.parse(brk.until) : NaN;
  if (!Number.isFinite(u)) return { stage: "none", ask: 0 };
  if (now < u) return { stage: "running", ask: 0 };
  const k = Math.floor((now - u) / BREAK_REASK) + 1;
  return k > BREAK_ASKS ? { stage: "end", ask: BREAK_ASKS } : { stage: "ask", ask: k };
}
/** "Back to sleep at 03:45" for the row while a break runs. */
export function breakUntilLine(brk: { until: string }, clock: (ms: number) => string): string { return `Back to sleep at ${clock(Date.parse(brk.until))}`; }

// ---------- Wake up (V1.41, the developer 7 Nov 2026: "The wake up button doesn't work") ----------
/** The card's data for a Wake up pressed on this device, shown at once from this device's own copy: the open sleep,
 *  or (Wake up pressed on the screen before the open sleep was saved) the time this screen went up. Null: nothing
 *  to ask about (a sleep already woke, or none at all). */
export function wakeCard(o: { at: string; tz: string; woke?: string | null; breaks?: SleepBreak[] | null } | null, at: number, since: number | null, tz: string)
  : { at: string; tz: string; woke: string; breaks?: SleepBreak[] | null } | null {
  const woke = new Date(at).toISOString();
  if (o && !o.woke && typeof o.at === "string" && Number.isFinite(Date.parse(o.at))) return { at: o.at, tz: o.tz, woke, ...(o.breaks?.length ? { breaks: o.breaks } : {}) };
  if (since != null && Number.isFinite(since) && since < at) return { at: new Date(since).toISOString(), tz, woke };
  return null;
}
/** Wake up pressed on another device (the open sleep has a wake time after this screen went up): this device's clock
 *  goes too, so one Wake up ends the sleep everywhere. A wake from an earlier sleep never closes a new one. */
export function wokeElsewhere(o: { at: string; woke?: string | null } | null, here: boolean, since: number | null): boolean {
  if (!here || since == null || !o?.woke) return false;
  const w = Date.parse(o.woke);
  return Number.isFinite(w) && w > since;
}

// ---------- PS 1.68: a night is never lost (Jan 18 Nov 2026: "Sleep in G Squad says there is no sleep, but I do sleep with it") ----------
// After Wake up and I'm up, the sleep waited in the open record for the Sleep log card's Save. A card closed with Esc, never
// answered, or gone with the Tab list left it there, and the next night's Sleep press wrote over it: no sleep in the Sleep log,
// so G Squad (which shares from the Sleep log) said there was none. Now an unanswered sleep is logged by itself: at the next
// Sleep press at once, or LOG_UNSAVED_MS after waking. "Don't log" still logs nothing; a sleep typed by hand is never replaced.
export const LOG_UNSAVED_MS = 3 * 3_600_000;
export function unsavedLog(open: { at: string; tz: string; woke?: string | null; breaks?: SleepBreak[] | null } | null | undefined, now: number,
  had: { src?: string } | null | undefined, force = false): SleepLog | null {
  if (!open?.woke) return null;
  const woke = Date.parse(open.woke);
  if (!Number.isFinite(woke) || woke > now + 60_000) return null;
  if (!force && now - woke < LOG_UNSAVED_MS) return null;
  const p = propose(open, woke);
  if (!p?.log) return null;
  if (had && had.src !== "sleepmode") return null;
  return p.log;
}
