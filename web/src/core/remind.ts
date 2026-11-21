// The Annoying 15 min reminder (the developer, 10 Nov 2026, after a G Squad friend asked for the daily reminder card to be
// "EASILY customizable to any notification and timing"): "Make it so you can add multiple throughout the day, edit
// the notifications, change the colour of the pop up, even play a sound you select from audio files too. I want to
// decide the times of the day it begins to pop up etc. Also make it so you can edit the text under each pop up from
// 'Yes' to something else too. Do the same with the notifications on the GOS app too."
//
// A list of reminders. Each one pops up (a card on the Mac, a notification on the phone) from its start time until it
// is confirmed, on the days picked; "Remind me in N mins" puts it away for its snooze length. The daily reminder card
// of V1.38 to V1.45 was reminder number one, id "fu". It is gone since 1.60 (the developer's answer 24a): nobody gets a built in
// reminder any more, a stored "fu" is dropped on every load (RETIRED_ID) and the devices cancel its alarm.
//
// Storage: ONE small encrypted vault record per account (kind "remind", owner private), never inside the big settings
// record, so a change uploads a couple of KB and only when something changed (egress rule). It holds the list and each
// reminder's state (confirmed for which day, snoozed until when), so Yes on the phone clears the Mac's card and
// "Remind me in" on one device snoozes the other. Two devices that change it at once are merged (mergeRemind).
// Own sound files never go in it: each device keeps its own (ps-mac Reminders.swift, ps-gos Remind.kt).
//
// Pure: no vault, no clock, no storage. tests/remind.test.ts checks it; the Mac (ps-mac Sources/Reminders.swift
// RemMath) and the phone (ps-gos RemClock.kt) do the same schedule maths.
import { wall, zonedToTs } from "./tz.ts";

export const REM_MAX = 20;                 // reminders in the list and alarms together (not counting the ones on tasks)
export const REM_TASK_MAX = 60;            // reminders on tasks (V1.55): their own count, so they never crowd out the list
export const REM_ALL_MAX = REM_MAX + REM_TASK_MAX;   // what a shell takes (ps-mac RemMath.maxItems, ps-gos RemClock.MAX)
export const TASK_PILL = "Task reminder";
export const OPEN_WORDS = "Open task";
export const REM_TEXT_MAX = 80;            // the question (the old card's limit)
export const REM_LABEL_MAX = 30;           // the small pill on top, and each button
export const REM_SNOOZE_DEF = 15, REM_SNOOZE_MIN = 1, REM_SNOOZE_MAX = 240;
export const REM_VOL_DEF = 0.8, REM_VOL_MIN = 0.1;
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];   // 0 Sunday to 6 Saturday
export const PUBLIC_QUESTION = "HAVE YOU DONE YOUR DAILY TASK YET?";  // the words of a reminder saved without any
/** The built in daily reminder of V1.38 to V1.59. Removed for everyone in 1.60: never kept, never planned, its
 *  alarm and card cancelled on every device. Reminders people made themselves have random ids and stay. */
export const RETIRED_ID = "fu";

/** The built in sounds (core/alarmsound.ts tone tables at the one level), none, or this device's own file. */
export type RemSound = "none" | "soft" | "alarm" | "own";
export const REM_SOUNDS: { id: RemSound; label: string }[] = [
  { id: "none", label: "No sound" }, { id: "soft", label: "Soft chime" }, { id: "alarm", label: "Alarm tone" }, { id: "own", label: "Your own sound" },
];

export interface Reminder {
  id: string;
  on: boolean;
  label: string;        // the small pill on the card ("Daily reminder"); empty = that
  text: string;         // the question; empty = the default question
  at: string;           // "HH:MM" it starts popping up
  until: string;        // "HH:MM" it stops opening (a card already up stays until answered); may run past midnight
  days: number[];       // the days a window may START on, 0 Sunday to 6 Saturday
  tz: string;           // "" = the device's own time zone, else an IANA zone (the developer's first one: Dubai)
  snooze: number;       // minutes "Remind me in" puts it away for
  later: string;        // the snooze button's words; empty = "Remind me in N mins" ({n} = the minutes)
  yes: string;          // the confirm button's words; empty = "Yes"
  word: string;         // what has to be typed to clear it; empty = the confirm button's words
  click: boolean;       // true: one click on the confirm button clears it, nothing typed
  bg: string;           // "#rrggbb" the card's background
  accent: string;       // "#rrggbb" its border, pill, stripe and confirm button
  sound: RemSound;
  vol: number;          // 0.1 to 1: the sound's share of the device's volume
  edited: number;       // ms: last change to these settings (merging two devices)
  // Reminders ON tasks (V1.55, the developer 12 Nov 2026: "So it blends tasks with the reminders, so I get reminders ON my tasks").
  task?: string;        // the task's id: the pop-up shows its name (text empty), Done ticks it, Open task opens it
  date?: string;        // "YYYY-MM-DD": once, on that day only (its window starts that day). None: on the days picked
  // Alarms (V1.57, the developer 13 Nov 2026: "PS can ring the phone like an alarm at any time I pick, like today's 07:44 gym ring").
  // `at` is the time it rings, `until` always 10 minutes later (the Mac card's window; the phone rings up to 10 minutes),
  // `label` the ring screen's title, `text` its words, `yes` the stop button. Later is always 5 minutes, one click.
  alarm?: boolean;
}
/** One reminder's state on every device: confirmed for which window (its start day), snoozed until when. */
export interface RemState { done?: string; snoozeUntil?: number; at: number; by?: "mac" | "phone" | "web" }
export interface RemindRec {
  v: 1; list: Reminder[]; state: Record<string, RemState>; gone: Record<string, number>; at: number;
  /** PS 1.73 (core/duealerts.ts): the settings of the nag for tasks due today and of the Priority 1 alarm. Unset = the defaults. */
  due?: DueCfg;
  /** PS 1.73: the answers to those (Done, Remind me in, I acknowledge), keyed by their worked out ids (core/duealerts.ts autoId). */
  auto?: Record<string, RemState>;
}
/** PS 1.73 (the developer, 21 Nov 2026): the Annoying reminder for every task due today, and the alarm for a Priority 1 task whose 24 hours
 *  are nearly up. Both are made from your tasks on every device (core/duealerts.ts); only these settings and the answers are saved.
 *  nag and p1 are ordinary reminders so the same editor, cards, notifications and rules serve them (their times are unused). */
export interface DueCfg {
  nag: Reminder;     // id "duenag": on, the pill, the words ({task} and {left}), snooze, buttons, typed word or one click, colours, sound
  hours: number;     // the nag starts this many hours before the day ends (or before a P1's 24 hours run out)
  p1: Reminder;      // id "duep1", an alarm: on, the title, the words ({task} and {left}), the button ("I acknowledge"), colours, Mac sound
  lead: number;      // minutes before a P1's 24 hours run out that it rings
  edited: number;    // ms: the last change (two devices: the newer settings win)
}
export const DUE_HOURS_DEF = 3, DUE_HOURS_MIN = 1, DUE_HOURS_MAX = 12;
export const DUE_LEAD_DEF = 60, DUE_LEAD_MIN = 5, DUE_LEAD_MAX = 720;
export const DUE_NAG_ID = "duenag", DUE_P1_ID = "duep1";
export const DUE_NAG_PILL = "Due today", DUE_P1_TITLE = "Priority 1", DUE_P1_YES = "I acknowledge", DUE_P1_TEXT = "{left} left: {task}";
/** The word that has to be typed before I acknowledge stops a Priority 1 alarm (the developer, 21 Nov 2026: a click alone must not do it). */
export const DUE_P1_WORD = "yes";
/** The worked out ids (core/duealerts.ts autoId): "n" (a nag) or "p" (a P1 alarm) and 11 letters and digits. Never made by freshId (8). */
export const AUTO_ID = /^[np][a-z0-9]{11}$/;
export const AUTO_KEEP_MS = 3 * 86_400_000, AUTO_MAX = 120;

// ---------- colours ----------
export const REM_COLOURS: { id: string; label: string; bg: string; accent: string }[] = [
  { id: "pink", label: "Pink", bg: "#28121e", accent: "#ec4e86" },
  { id: "ocean", label: "Ocean", bg: "#0f1b2d", accent: "#3b82f6" },
  { id: "forest", label: "Forest", bg: "#0f2418", accent: "#22c55e" },
  { id: "amber", label: "Amber", bg: "#2a1a08", accent: "#f59e0b" },
  { id: "violet", label: "Violet", bg: "#1c1230", accent: "#8b5cf6" },
  { id: "red", label: "Red alert", bg: "#2a0d0d", accent: "#ef4444" },
  { id: "mono", label: "Graphite", bg: "#18181b", accent: "#e5e7eb" },
  { id: "paper", label: "Paper", bg: "#f6f3ee", accent: "#e0457b" },
];
export const REM_BG = REM_COLOURS[0].bg, REM_ACCENT = REM_COLOURS[0].accent;
const HEX = /^#[0-9a-f]{6}$/;
export const okHex = (v: unknown, def: string) => (typeof v === "string" && HEX.test(v.toLowerCase()) ? v.toLowerCase() : def);
/** Relative luminance 0 (black) to 1 (white). */
export function luma(hex: string): number {
  const n = parseInt(okHex(hex, "#000000").slice(1), 16);
  const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}
// ---------- readable colours on any background (V1.58) ----------
// The developer, 13 Nov 2026: "when you choose the white coloured theme for the fifteen minute reminder, the text almost
// becomes invisible. The text doesn't adapt to the colour." Every colour on the pop-up is worked out from its
// background and accent here, so it reads (4.5 to 1, WCAG AA) on Paper, on white, on a light custom colour and on the
// dark themes alike. The Mac's card (ps-mac Sources/Reminders.swift, "rem look" in its page) and the phone's ring
// screen (ps-gos RemInk.kt) work out the same colours with the same numbers.
export const REM_DARK_INK = "#17121a", REM_WHITE = "#ffffff", REM_BLACK = "#000000";
export const REM_MIN_CONTRAST = 4.5;     // text (WCAG AA)
export const REM_MIN_BUTTON = 3;         // big bold words on an accent button keep their colour down to 3 to 1 (WCAG AA large)
/** WCAG contrast ratio of two colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const x = luma(a), y = luma(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
const rgbOf = (h: string) => { const n = parseInt(okHex(h, "#000000").slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
/** `a` at share `t` (0 to 1) over `b`, as CSS color-mix(in srgb, a t, b) draws it. */
export function mixHex(a: string, b: string, t: number): string {
  const p = rgbOf(a), q = rgbOf(b);
  return "#" + p.map((v, i) => Math.round(v * t + q[i] * (1 - t)).toString(16).padStart(2, "0")).join("");
}
/** The text colour that reads on a background: white or near black, whichever reads better; on a middle tone where
 *  neither reaches 4.5 to 1, pure black or white (one of them always does). */
export function inkFor(bg: string): string {
  const w = contrast(REM_WHITE, bg), d = contrast(REM_DARK_INK, bg);
  if (Math.max(w, d) >= REM_MIN_CONTRAST) return w > d ? REM_WHITE : REM_DARK_INK;
  return contrast(REM_BLACK, bg) > w ? REM_BLACK : REM_WHITE;
}
const minC = (c: string, tones: string[]) => Math.min(...tones.map((t) => contrast(c, t)));
/** `ink` softened toward `base` as far as it still reads on every tone (secondary words, placeholders). */
function softInk(ink: string, base: string, tones: string[], from: number): string {
  for (let i = Math.round(from * 100); i < 100; i += 5) { const c = mixHex(ink, base, i / 100); if (minC(c, tones) >= REM_MIN_CONTRAST) return c; }
  return ink;
}
/** Words on an accent filled button: `first` when it reads (`min` to 1), else a deep shade of the accent itself. */
export function onAccent(tone: string, accent: string, first: string, min: number): string {
  if (contrast(first, tone) >= min) return first;
  for (const s of [0.4, 0.3, 0.2, 0.1]) { const c = mixHex(accent, REM_BLACK, s); if (contrast(c, tone) >= REM_MIN_CONTRAST) return c; }
  return contrast(REM_BLACK, tone) >= contrast(REM_WHITE, tone) ? REM_BLACK : REM_WHITE;
}
/** Every colour on the reminder card (the Mac's pop-up, the website's Test card, Settings' preview). */
export interface RemLook {
  ink: string;      // the question and the buttons' words
  sub: string;      // smaller words (Type Yes and press Enter to confirm)
  lift: string;     // the card's top sheen mixes 8% of this into the background (the background itself: no sheen)
  top: string;      // the card's top tone (background with its sheen)
  glow: number;     // % of the accent glowing at the top
  pill: string;     // the pill's words
  pillBg: string;   // the pill's tone under its words
  btn: number;      // % of ink filling the other buttons
  on: string;       // words on the main (accent) button
  mainTone: string; // the main button's middle tone
  field: string;    // the box's fill (CSS)
  fieldTone: string;
  ph: string;       // the box's placeholder
  hint: string;     // "Only Yes closes this."
}
export function remLook(bgIn: string, accentIn: string): RemLook {
  const bg = okHex(bgIn, REM_BG), accent = okHex(accentIn, REM_ACCENT);
  const ink = inkFor(bg);
  const lit = mixHex(REM_WHITE, bg, 0.08);
  const lift = ink === REM_WHITE && contrast(REM_WHITE, lit) < REM_MIN_CONTRAST ? bg : REM_WHITE;
  const top = mixHex(lift, bg, 0.08);
  const glow = [22, 14, 8, 0].find((g) => contrast(ink, mixHex(accent, top, g / 100)) >= REM_MIN_CONTRAST) ?? 0;
  const pillBg = mixHex(accent, mixHex(accent, top, glow / 100), 0.18);
  const pillA = [55, 45, 35, 25, 15, 0].find((a) => contrast(mixHex(accent, ink, a / 100), pillBg) >= REM_MIN_CONTRAST) ?? 0;
  const btn = [13, 10, 7, 4, 0].find((p) => minC(ink, [mixHex(ink, bg, p / 100), mixHex(ink, top, p / 100)]) >= REM_MIN_CONTRAST) ?? 0;
  const mainTone = mixHex(mixHex(accent, REM_WHITE, 0.8), mixHex(accent, REM_BLACK, 0.85), 0.5);
  const dark = ink !== REM_WHITE;
  const fieldTone = dark ? mixHex(REM_WHITE, bg, 0.5) : mixHex(REM_BLACK, bg, 0.28);
  const red = dark ? "#b42318" : "#fca5a5";
  return {
    ink, sub: softInk(ink, bg, [bg, top], 0.7), lift, top, glow, pill: mixHex(accent, ink, pillA / 100), pillBg, btn,
    on: onAccent(mainTone, accent, REM_WHITE, REM_MIN_BUTTON), mainTone,
    field: dark ? "rgba(255,255,255,.5)" : "rgba(0,0,0,.28)", fieldTone, ph: softInk(ink, fieldTone, [fieldTone], 0.6),
    hint: minC(red, [bg, top]) >= REM_MIN_CONTRAST ? red : ink,
  };
}
/** The phone's ring screen for an alarm (ps-gos GymRingActivity) on a flat background: words, smaller words, and the
 *  words on the accent orb and stop button (big and bold: the background's own colour when it reads, as before). */
export function alarmLook(bgIn: string, accentIn: string): { ink: string; sub: string; on: string } {
  const bg = okHex(bgIn, REM_BG), accent = okHex(accentIn, REM_ACCENT);
  const ink = inkFor(bg);
  return { ink, sub: softInk(ink, bg, [bg], 0.7), on: onAccent(accent, accent, bg, REM_MIN_BUTTON) };
}

// ---------- cleaning ----------
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID = /^[a-z0-9]{1,16}$/;
const TASK_ID = /^[A-Za-z0-9-]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const okTaskId = (v: unknown): v is string => typeof v === "string" && TASK_ID.test(v);
/** One line, no control characters, trimmed, at most `max` characters. */
export function oneLine(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.slice(0, 400).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, max).trim();
}
const num = (v: unknown, lo: number, hi: number, def: number, step = 1) => {
  const n = Number(v);
  return typeof v === "number" || (typeof v === "string" && v.trim()) ? (Number.isFinite(n) ? Math.round(Math.max(lo, Math.min(hi, n)) / step) * step : def) : def;
};
export const okSnooze = (v: unknown) => num(v, REM_SNOOZE_MIN, REM_SNOOZE_MAX, REM_SNOOZE_DEF);
export const okVol = (v: unknown) => Math.round(num(v, REM_VOL_MIN, 1, REM_VOL_DEF, 0.05) * 100) / 100;
export function okTz(v: unknown): string {
  if (typeof v !== "string" || !v || v.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(v)) return "";
  try { new Intl.DateTimeFormat("en-US", { timeZone: v }); return v; } catch { return ""; }
}
export const ALARM_RING_MIN = 10;          // the phone rings this long (ps-gos GymClock.RING_FOR), the Mac card's window
export const ALARM_LATER_MIN = 5;          // Later on an alarm (the gym ring's Later)
export const ALARM_TITLE = "Alarm", ALARM_YES = "Acknowledge", ALARM_LATER = "Later";
const plusMin = (hm: string, n: number) => { const [h, m] = hm.split(":").map(Number); const x = (h * 60 + m + n + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`; };
export const okDays = (v: unknown): number[] =>
  Array.isArray(v) ? [...new Set(v.filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6))].sort((a, b) => a - b) : [...ALL_DAYS];

/** A brand new reminder (Add reminder): on, 09:00 to 21:00 every day, this device's zone, pink, no sound. */
export function newReminder(id: string, now: number, n = 2): Reminder {
  return { id, on: true, label: `Reminder ${n}`, text: "HAVE YOU DONE IT YET?", at: "09:00", until: "21:00", days: [...ALL_DAYS], tz: "",
    snooze: REM_SNOOZE_DEF, later: "", yes: "", word: "", click: false, bg: REM_BG, accent: REM_ACCENT, sound: "none", vol: REM_VOL_DEF, edited: now };
}
/** A reminder checked field by field (an old or broken copy keeps what is good). Null when it has no usable id. */
export function cleanReminder(v: unknown, now = 0): Reminder | null {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  if (typeof o.id !== "string" || !ID.test(o.id)) return null;
  const at = typeof o.at === "string" && HHMM.test(o.at) ? o.at : "09:00";
  let until = typeof o.until === "string" && HHMM.test(o.until) ? o.until : "21:00";
  if (until === at) until = at === "21:00" ? "09:00" : "21:00";   // never an empty window
  const sound = REM_SOUNDS.some((s) => s.id === o.sound) ? (o.sound as RemSound) : "none";
  const r: Reminder = {
    id: o.id, on: typeof o.on === "boolean" ? o.on : true,
    label: oneLine(o.label, REM_LABEL_MAX), text: oneLine(o.text, REM_TEXT_MAX), at, until, days: okDays(o.days), tz: okTz(o.tz),
    snooze: okSnooze(o.snooze), later: oneLine(o.later, REM_LABEL_MAX), yes: oneLine(o.yes, REM_LABEL_MAX), word: oneLine(o.word, REM_LABEL_MAX),
    click: o.click === true, bg: okHex(o.bg, REM_BG), accent: okHex(o.accent, REM_ACCENT), sound, vol: okVol(o.vol),
    edited: typeof o.edited === "number" && Number.isFinite(o.edited) ? o.edited : now,
  };
  if (typeof o.task === "string" && TASK_ID.test(o.task)) r.task = o.task;
  if (r.task && typeof o.date === "string" && DAY.test(o.date)) r.date = o.date;
  if (o.alarm === true && !r.task) Object.assign(r, { alarm: true, until: plusMin(r.at, ALARM_RING_MIN), snooze: ALARM_LATER_MIN, later: ALARM_LATER, click: true });
  return r;
}
function cleanState(v: unknown): RemState | null {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const s: RemState = { at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0 };
  if (typeof o.done === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.done)) s.done = o.done;
  if (typeof o.snoozeUntil === "number" && Number.isFinite(o.snoozeUntil) && o.snoozeUntil > 0) s.snoozeUntil = o.snoozeUntil;
  if (o.by === "mac" || o.by === "phone" || o.by === "web") s.by = o.by;
  return s;
}
/** The record checked: known fields only, at most REM_MAX reminders, no id twice, state only for kept reminders. */
export function cleanRemind(v: unknown): RemindRec {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const list: Reminder[] = [];
  let plain = 0, onTasks = 0;
  for (const x of Array.isArray(o.list) ? o.list : []) {
    const r = cleanReminder(x);
    if (!r || r.id === RETIRED_ID || list.some((y) => y.id === r.id)) continue;
    if (r.task ? onTasks >= REM_TASK_MAX : plain >= REM_MAX) continue;
    if (r.task) onTasks++; else plain++;
    list.push(r);
  }
  const state: Record<string, RemState> = {};
  const st = (o.state && typeof o.state === "object" ? o.state : {}) as Record<string, unknown>;
  for (const r of list) { const s = cleanState(st[r.id]); if (s && st[r.id]) state[r.id] = s; }
  const gone: Record<string, number> = {};
  const g = (o.gone && typeof o.gone === "object" ? o.gone : {}) as Record<string, unknown>;
  for (const [id, t] of Object.entries(g).slice(0, 160)) if (ID.test(id) && typeof t === "number" && Number.isFinite(t)) gone[id] = t;
  const out: RemindRec = { v: 1, list, state, gone, at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0 };
  const due = cleanDue(o.due);
  if (due) out.due = due;
  const auto = cleanAuto(o.auto, out.at);
  if (auto) out.auto = auto;
  return out;
}
/** The due settings checked, or null when there are none (the defaults then). */
export function cleanDue(v: unknown): DueCfg | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const nag = cleanReminder({ ...(o.nag && typeof o.nag === "object" ? o.nag : {}), id: DUE_NAG_ID });
  const p1 = cleanReminder({ ...(o.p1 && typeof o.p1 === "object" ? o.p1 : {}), id: DUE_P1_ID, alarm: true });
  if (!nag || !p1) return null;
  delete nag.task; delete nag.date; delete nag.alarm;
  return { nag, p1, hours: num(o.hours, DUE_HOURS_MIN, DUE_HOURS_MAX, DUE_HOURS_DEF), lead: num(o.lead, DUE_LEAD_MIN, DUE_LEAD_MAX, DUE_LEAD_DEF),
    edited: typeof o.edited === "number" && Number.isFinite(o.edited) ? o.edited : 0 };
}
/** The answers to the worked out items: known ids only, the newest AUTO_MAX, none older than AUTO_KEEP_MS (of the record's time). */
export function cleanAuto(v: unknown, recAt: number): Record<string, RemState> | null {
  if (!v || typeof v !== "object") return null;
  const rows: [string, RemState][] = [];
  for (const [id, x] of Object.entries(v as Record<string, unknown>).slice(0, 400)) {
    if (!AUTO_ID.test(id)) continue;
    const s = cleanState(x);
    if (s && s.at > 0 && (!recAt || recAt - s.at < AUTO_KEEP_MS)) rows.push([id, s]);
  }
  if (!rows.length) return null;
  rows.sort((a, b) => b[1].at - a[1].at || (a[0] < b[0] ? -1 : 1));
  return Object.fromEntries(rows.slice(0, AUTO_MAX));
}
/** Does a stored record still carry the retired built in reminder (so the next save should rewrite it without)? */
export function hasRetired(v: unknown): boolean {
  const o = (v && typeof v === "object" ? v : {}) as { list?: unknown };
  return Array.isArray(o.list) && o.list.some((x) => !!x && typeof x === "object" && (x as { id?: unknown }).id === RETIRED_ID);
}
export const sameRemind = (a: RemindRec, b: RemindRec) => JSON.stringify(cleanRemind(a)) === JSON.stringify(cleanRemind(b));

// ---------- words ----------
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** "15 mins", "1 min", "1 hour", "1 h 30 mins". */
export function minsWords(n: number): string {
  const m = okSnooze(n);
  if (m < 60) return plural(m, "min");
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${plural(r, "min")}` : plural(h, "hour");
}
export const pillOf = (r: Pick<Reminder, "label"> & { task?: string; alarm?: boolean }) => r.label || (r.task ? TASK_PILL : r.alarm ? ALARM_TITLE : "Daily reminder");
/** An alarm's words: its own, else "Alarm at 07:44". */
export const alarmText = (r: Pick<Reminder, "text" | "at">) => r.text || `Alarm at ${r.at}`;
export const questionOf = (r: Pick<Reminder, "text">) => r.text || PUBLIC_QUESTION;
/** The snooze button: its own words with {n} as the minutes, else "Remind me in 15 mins" (the number follows the length). */
export const laterOf = (r: Pick<Reminder, "later" | "snooze">) => (r.later ? r.later.replace(/\{n\}/g, String(okSnooze(r.snooze))) : `Remind me in ${minsWords(r.snooze)}`);
export const yesOf = (r: Pick<Reminder, "yes"> & { alarm?: boolean }) => r.yes || (r.alarm ? ALARM_YES : "Yes");
export const wordOf = (r: Pick<Reminder, "word" | "yes">) => r.word || yesOf(r);
/** Does what was typed clear it? Any case, spaces at the ends trimmed; one click when `click`. */
export function confirms(r: Pick<Reminder, "word" | "yes" | "click">, typed: string): boolean {
  if (r.click) return true;
  return typed.trim().toLowerCase() === wordOf(r).trim().toLowerCase();
}

// ---------- the schedule ----------
const pad = (n: number) => String(n).padStart(2, "0");
export const zoneOf = (r: Pick<Reminder, "tz">, deviceTz: string) => r.tz || deviceTz;
export const minutesOf = (hm: string) => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };
const dayKey = (ts: number, tz: string) => { const w = wall(ts, tz); return `${w.y}-${pad(w.mo)}-${pad(w.d)}`; };
const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
export const weekdayOf = (day: string) => { const [y, m, d] = day.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const tsOf = (day: string, hm: string, tz: string) => { const [y, m, d] = day.split("-").map(Number); const [h, mi] = hm.split(":").map(Number); return zonedToTs(y, m, d, h, mi, tz); };

export interface RemWindow { day: string; start: number; end: number }
/** The window that starts on `day` (its start day in the reminder's zone), whatever the days picked. */
export function windowOn(r: Pick<Reminder, "at" | "until" | "tz">, day: string, deviceTz: string): RemWindow {
  const tz = zoneOf(r, deviceTz);
  const over = minutesOf(r.until) <= minutesOf(r.at);   // runs past midnight
  return { day, start: tsOf(day, r.at, tz), end: tsOf(over ? addDays(day, 1) : day, r.until, tz) };
}
/** The window a moment belongs to: from the start time on it is that day's, before it the day before's (the old
 *  card's "cycle day"). Done is kept per window, so confirming at 05:00 clears that night's window only. */
export function cycleDay(r: Pick<Reminder, "at" | "tz">, now: number, deviceTz: string): string {
  const tz = zoneOf(r, deviceTz), w = wall(now, tz), today = `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
  return w.h * 60 + w.mi < minutesOf(r.at) ? addDays(today, -1) : today;
}
/** The window open right now on a picked day, else null. */
/** May a window start on this day? Once: that one day. Else: one of the days picked. */
export const startsOn = (r: Pick<Reminder, "days"> & { date?: string }, day: string) => (r.date ? day === r.date : r.days.includes(weekdayOf(day)));
const anyDay = (r: Pick<Reminder, "days"> & { date?: string }) => !!r.date || r.days.length > 0;
export function openWindow(r: Reminder, now: number, deviceTz: string): RemWindow | null {
  if (!r.on || !anyDay(r)) return null;
  const w = windowOn(r, cycleDay(r, now, deviceTz), deviceTz);
  return startsOn(r, w.day) && now >= w.start && now < w.end ? w : null;
}
/** The next window start after `now` on a picked day (within 8 days), 0 when none. */
export function nextStart(r: Reminder, now: number, deviceTz: string): number {
  if (!r.on || !anyDay(r)) return 0;
  if (r.date) { const s = windowOn(r, r.date, deviceTz).start; return s > now ? s : 0; }
  const today = dayKey(now, zoneOf(r, deviceTz));
  for (let i = -1; i <= 8; i++) {
    const day = addDays(today, i);
    if (!startsOn(r, day)) continue;
    const s = windowOn(r, day, deviceTz).start;
    if (s > now) return s;
  }
  return 0;
}

export type RemStatus = "off" | "done" | "closed" | "snoozed" | "show";
/** What a reminder is doing now. "show": it may open (the Mac still waits while you are away, in a meeting, under Do
 *  Not Disturb or over 1Password and Signal). A card already up when the window closes stays until answered; that is
 *  the shell's to keep (this says "closed"). A snooze that ends after the window does not bring it back. */
export function remStatus(r: Reminder, s: RemState | undefined, now: number, deviceTz: string): RemStatus {
  if (!r.on) return "off";
  if (s?.done && s.done === cycleDay(r, now, deviceTz)) return "done";
  if (!openWindow(r, now, deviceTz)) return "closed";
  if (s?.snoozeUntil && s.snoozeUntil > now) return "snoozed";
  return "show";
}
/** When anything about it can change next (a window opens or closes, a snooze ends), 0 when never. */
export function remNextWake(r: Reminder, s: RemState | undefined, now: number, deviceTz: string): number {
  const t: number[] = [];
  const n = nextStart(r, now, deviceTz); if (n) t.push(n);
  const w = openWindow(r, now, deviceTz); if (w) t.push(w.end);
  if (s?.snoozeUntil && s.snoozeUntil > now) t.push(s.snoozeUntil);
  return t.length ? Math.min(...t) : 0;
}

// ---------- ringing (1.60: the full screen card on the phone and the iPhone web app) ----------
type RingShape = Pick<Reminder, "at" | "until" | "tz" | "days" | "snooze" | "on"> & { date?: string };
/** When it next RINGS (0 never), the same rules as the phone's RemClock.nextRing: when its window opens and when a snooze
 *  ends, then every snooze length until it is answered, inside the window. `last`: when it last rang (0 = never). */
export function remNextRing(r: Reminder, s: RemState | undefined, now: number, deviceTz: string, last: number): number {
  const w = openWindow(r, now, deviceTz);
  switch (remStatus(r, s, now, deviceTz)) {
    case "off": case "done": return 0;
    case "show": {
      if (!w) return 0;
      if (last < w.start || (s?.snoozeUntil ?? 0) > last) return now;
      const t = last + okSnooze(r.snooze) * 60_000;
      return t >= w.end ? 0 : Math.max(t, now);
    }
    case "snoozed": return w && (s?.snoozeUntil ?? 0) < w.end ? s!.snoozeUntil! : 0;
    default: return nextStart(r, now, deviceTz);
  }
}
/** The moments a closed web app should be pushed for this reminder, from `from` on (never more than `max`, none later than
 *  `from + horizon`): each window's start (or a snooze's end) and every snooze length after, inside the window. A window
 *  already confirmed is left out. The server keeps only these times and the id. */
export function remRingTimes(r: RingShape, s: RemState | undefined, from: number, horizon: number, deviceTz: string, max = 12): number[] {
  if (!r.on) return [];
  const out: number[] = [];
  const day0 = cycleDay(r, from, deviceTz), step = okSnooze(r.snooze) * 60_000;
  for (let i = 0; i <= 3 && out.length < max; i++) {
    const day = addDays(day0, i);
    if (!startsOn(r, day) || s?.done === day) continue;
    const w = windowOn(r, day, deviceTz);
    let t = Math.max(w.start, from);
    if (i === 0 && s?.snoozeUntil && s.snoozeUntil > t && s.snoozeUntil < w.end) t = s.snoozeUntil;
    for (; t < w.end && t <= from + horizon && out.length < max; t += step) if (t > from) out.push(t);
  }
  return out;
}

// ---------- answers (on any device) ----------
export type RemAct = { id: string; act: "done" | "snooze"; day?: string; until?: number; at: number; by?: RemState["by"] };
/** Confirm: done for the window it is in now. */
export function doneAct(r: Reminder, now: number, deviceTz: string, by?: RemState["by"]): RemAct {
  return { id: r.id, act: "done", day: cycleDay(r, now, deviceTz), at: now, by };
}
/** Remind me in: away for its snooze length. */
export function snoozeAct(r: Reminder, now: number, by?: RemState["by"]): RemAct {
  return { id: r.id, act: "snooze", until: now + okSnooze(r.snooze) * 60_000, at: now, by };
}
/** An answer (from this page, the Mac's card or the phone's notification) put into the record. Null: nothing changes
 *  (unknown reminder, a broken answer, or an older answer than the one kept). */
export function applyAct(rec: RemindRec, a: unknown): RemindRec | null {
  const o = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
  if (typeof o.id !== "string") return null;
  const auto = !rec.list.some((r) => r.id === o.id);
  if (auto && !AUTO_ID.test(o.id)) return null;   // PS 1.73: a nag or P1 alarm worked out from a task (core/duealerts.ts)
  const at = typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0;
  const old = auto ? rec.auto?.[o.id] : rec.state[o.id];
  if (old && old.at >= at) return null;
  const by = o.by === "mac" || o.by === "phone" || o.by === "web" ? o.by : undefined;
  let s: RemState;
  if (o.act === "done" && typeof o.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.day)) s = { done: o.day, at };
  else if (o.act === "snooze" && typeof o.until === "number" && Number.isFinite(o.until)) s = { ...(old?.done ? { done: old.done } : {}), snoozeUntil: o.until, at };
  else return null;
  if (by) s.by = by;
  if (auto) return { ...rec, auto: cleanAuto({ ...(rec.auto ?? {}), [o.id]: s }, Math.max(rec.at, at)) ?? {}, at: Math.max(rec.at, at) };
  return { ...rec, state: { ...rec.state, [o.id]: s }, at: Math.max(rec.at, at) };
}

// ---------- editing the list ----------
export function emptyRemind(): RemindRec { return { v: 1, list: [], state: {}, gone: {}, at: 0 }; }
/** One reminder changed (settings only; its state stays). Its edited time moves on, so a merge keeps this copy. */
export function patchReminder(rec: RemindRec, id: string, patch: Partial<Reminder>, now: number): RemindRec {
  const list = rec.list.map((r) => {
    if (r.id !== id) return r;
    const rest = { ...r, ...patch, id, edited: Math.max(now, r.edited + 1) };
    return cleanReminder(rest, now) ?? r;
  });
  // A new start time or new days: what was confirmed or snoozed for the old window no longer holds.
  const old = rec.list.find((r) => r.id === id), now2 = list.find((r) => r.id === id);
  let state = rec.state;
  if (old && now2 && (old.at !== now2.at || old.tz !== now2.tz) && state[id]) { state = { ...state }; delete state[id]; }
  return { ...rec, list, state, at: Math.max(now, rec.at) };
}
/** The reminders in the list (Settings), without the ones on tasks and the alarms. */
export const plainOf = (rec: RemindRec) => rec.list.filter((r) => !r.task && !r.alarm);
/** The alarms (V1.57). They count with the list's own towards REM_MAX. */
export const alarmsOf = (rec: RemindRec) => rec.list.filter((r) => !!r.alarm);
const ownCount = (rec: RemindRec) => rec.list.filter((r) => !r.task).length;
export const onTasksOf = (rec: RemindRec) => rec.list.filter((r) => !!r.task);
export function addReminder(rec: RemindRec, id: string, now: number): RemindRec {
  const plain = plainOf(rec).length;
  if (ownCount(rec) >= REM_MAX || !ID.test(id) || rec.list.some((r) => r.id === id)) return rec;
  const gone = { ...rec.gone }; delete gone[id];
  // Before the first reminder on a task, so the list's own order stays together.
  const list = [...rec.list];
  const at = list.findIndex((r) => !!r.task);
  list.splice(at < 0 ? list.length : at, 0, newReminder(id, now, plain + 1));
  return { ...rec, list, gone, at: Math.max(now, rec.at) };
}
export function removeReminder(rec: RemindRec, id: string, now: number): RemindRec {
  if (!rec.list.some((r) => r.id === id)) return rec;
  const state = { ...rec.state }; delete state[id];
  return { ...rec, list: rec.list.filter((r) => r.id !== id), state, gone: { ...rec.gone, [id]: now }, at: Math.max(now, rec.at) };
}
export function moveReminder(rec: RemindRec, id: string, by: -1 | 1, now: number): RemindRec {
  const i = rec.list.findIndex((r) => r.id === id);
  if (i < 0) return rec;
  // Only past one of its own kind (the list's reminders, the alarms, or the ones on tasks).
  const kind = (r: Reminder) => (r.task ? "t" : r.alarm ? "a" : "p");
  let j = i + by;
  while (j >= 0 && j < rec.list.length && kind(rec.list[j]) !== kind(rec.list[i])) j += by;
  if (j < 0 || j >= rec.list.length) return rec;
  const list = [...rec.list]; [list[i], list[j]] = [list[j], list[i]];
  return { ...rec, list, at: Math.max(now, rec.at) };
}
/** A fresh id that is not in the list: 8 lowercase letters and digits. */
export function freshId(rec: RemindRec, rnd: () => number = Math.random): string {
  for (;;) {
    const id = Array.from({ length: 8 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(rnd() * 36)]).join("");
    if (!rec.list.some((r) => r.id === id) && !rec.gone[id]) return id;
  }
}

/** At most REM_MAX of the list's own and REM_TASK_MAX on tasks, in order. */
function capKinds(list: Reminder[]): Reminder[] {
  let a = 0, b = 0;
  return list.filter((r) => (r.task ? ++b <= REM_TASK_MAX : ++a <= REM_MAX));
}

// ---------- two devices at once ----------
/** Two copies changed on two devices: each reminder's newer settings, each reminder's newer state, removals win over
 *  older edits (a reminder edited after it was removed elsewhere comes back), the order of the newer copy. */
export function mergeRemind(a: RemindRec, b: RemindRec): RemindRec {
  const [newer, older] = b.at >= a.at ? [b, a] : [a, b];
  const gone: Record<string, number> = { ...older.gone };
  for (const [id, t] of Object.entries(newer.gone)) gone[id] = Math.max(gone[id] ?? 0, t);
  const pick = new Map<string, Reminder>();
  for (const r of [...older.list, ...newer.list]) { const h = pick.get(r.id); if (!h || r.edited >= h.edited) pick.set(r.id, r); }
  const order = [...newer.list.map((r) => r.id), ...older.list.map((r) => r.id).filter((id) => !newer.list.some((r) => r.id === id))];
  const list = capKinds(order.filter((id, i) => order.indexOf(id) === i).map((id) => pick.get(id)!).filter((r) => !(gone[r.id] >= r.edited)));
  for (const r of list) delete gone[r.id];
  const state: Record<string, RemState> = {};
  for (const r of list) {
    const x = a.state[r.id], y = b.state[r.id];
    const s = !x ? y : !y ? x : y.at >= x.at ? y : x;
    if (s) state[r.id] = s;
  }
  const out: RemindRec = { v: 1, list, state, gone, at: Math.max(a.at, b.at) };
  // PS 1.73: the newer due settings, and each worked out item's newer answer.
  const due = !a.due ? b.due : !b.due ? a.due : b.due.edited >= a.due.edited ? b.due : a.due;
  if (due) out.due = due;
  const ids = new Set([...Object.keys(a.auto ?? {}), ...Object.keys(b.auto ?? {})]);
  if (ids.size) {
    const m: Record<string, RemState> = {};
    for (const id of ids) { const x = a.auto?.[id], y = b.auto?.[id]; const s = !x ? y : !y ? x : y.at >= x.at ? y : x; if (s) m[id] = s; }
    const auto = cleanAuto(m, out.at);
    if (auto) out.auto = auto;
  }
  return out;
}

/** What Settings shows and edits when there is no record yet: an empty list (not saved until a change). */
export function remindOrDefault(rec: RemindRec | null, _red?: boolean): RemindRec {
  return rec ?? emptyRemind();
}

// ---------- what each shell gets ----------
/** The plan for the Mac (ps-mac Reminders.swift) and the phone (ps-gos Remind.kt): every reminder with its words
 *  already worked out (so no shell needs the defaults), its state, and the zone to use when it says "". Small, and
 *  sent only when it changed. */
export interface PlanItem {
  id: string; on: boolean; pill: string; text: string; at: string; until: string; days: number[]; tz: string;
  snooze: number; later: string; yes: string; word: string; click: boolean; bg: string; accent: string; ink: string;
  sound: RemSound; vol: number; done: string; snoozeUntil: number; stateAt: number;
  // V1.55, reminders on tasks ("" on the list's own): the task's id, the one day of a once reminder, the third button's words.
  task: string; date: string; open: string;
  // PS 1.73 (optional, older shells ignore them): one = only the confirm button (no snooze), ring = the Mac card's sound loops
  // until it is answered or ALARM_RING_MIN is up (the Priority 1 alarm).
  one?: boolean; ring?: boolean;
}
/** What the plan needs to know about one task (core/model.ts Todo). */
export interface TaskInfo { title: string; done: boolean; daily: boolean; doneAt?: string | null }
/** The plan's view of the tasks: their names and whether they are ticked. Without it (Settings' preview) a reminder on
 *  a task shows its own words. */
export interface PlanCtx { tasks: Map<string, TaskInfo>; now: number; deviceTz: string }
const clip = (t: string, max: number) => { const x = oneLine(t, 400); return x.length <= max ? x : `${x.slice(0, max - 3).trimEnd()}...`; };
/** The pop-up's words for a reminder on a task: its own question, else the task's name. */
export function taskQuestion(r: Pick<Reminder, "text">, title: string | undefined): string {
  return r.text || (title ? clip(title, REM_TEXT_MAX) : "YOUR TASK");
}
export function remPlan(rec: RemindRec | null, _red: boolean, ctx?: PlanCtx): { v: 1; items: PlanItem[] } {
  if (!rec) return { v: 1, items: [] };
  return {
    v: 1,
    items: rec.list.map((r) => {
      const s = rec.state[r.id];
      let on = r.on, done = s?.done ?? "", stateAt = s?.at ?? 0;
      let text = r.alarm ? alarmText(r) : questionOf(r);
      if (r.task) {
        const t = ctx?.tasks.get(r.task);
        text = taskQuestion(r, t?.title);
        if (ctx && !t) on = false;   // the task is gone (deleted here or on another device): quiet until it is swept
        else if (ctx && t?.done) {
          // Ticked in the list: nothing to nag about for the window it is in now (a repeating one comes back next time).
          const day = cycleDay(r, ctx.now, ctx.deviceTz);
          if (done !== day) { done = day; stateAt = Math.max(stateAt, Date.parse(t.doneAt ?? "") || 0, s?.at ?? 0) || ctx.now; }
        }
      }
      return { id: r.id, on, pill: pillOf(r), text, at: r.at, until: r.until, days: r.days, tz: r.tz,
        snooze: r.snooze, later: laterOf(r), yes: yesOf(r), word: wordOf(r), click: r.click, bg: r.bg, accent: r.accent, ink: inkFor(r.bg),
        sound: r.sound, vol: r.vol, done, snoozeUntil: s?.snoozeUntil ?? 0, stateAt,
        task: r.task ?? "", date: r.date ?? "", open: r.task ? OPEN_WORDS : "" };
    }),
  };
}

/** "02:00 to 06:00, every day" / "09:00 to 21:00, weekdays" for the list ("Rings at 07:44, every day" for an alarm). */
export function windowWords(r: Pick<Reminder, "at" | "until" | "days"> & { date?: string; alarm?: boolean }): string {
  if (r.alarm) return `Rings at ${r.at}, ${daysWords(r.days)}`;
  if (r.date) return `${r.at} to ${r.until}${minutesOf(r.until) <= minutesOf(r.at) ? " (next day)" : ""}, once on ${dayWords(r.date)}`;
  return `${r.at} to ${r.until}${minutesOf(r.until) <= minutesOf(r.at) ? " (next day)" : ""}, ${daysWords(r.days)}`;
}
function daysWords(days: number[]): string {
  const d = days.join(",");
  return d === "0,1,2,3,4,5,6" ? "every day" : d === "1,2,3,4,5" ? "weekdays" : d === "0,6" ? "weekends" : !days.length ? "no days"
    : days.map((x) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][x]).join(", ");
}

// ---------- the record in the vault ----------
/** This account's reminders record: the newest copy kept, every copy merged (two devices that each made one before
 *  they synced), the others to remove on the next save. */
export function pickRemind<D extends { id: string; data: unknown }>(docs: D[]): { keep: D | null; extra: D[]; rec: RemindRec | null; stale: boolean } {
  if (!docs.length) return { keep: null, extra: [], rec: null, stale: false };
  const stale = docs.some((d) => hasRetired(d.data));
  const all = docs.map((d) => ({ d, r: cleanRemind(d.data) })).sort((a, b) => b.r.at - a.r.at || (a.d.id < b.d.id ? -1 : 1));
  const rec = all.slice(1).reduce((m, x) => mergeRemind(m, x.r), all[0].r);
  return { keep: all[0].d, extra: all.slice(1).map((x) => x.d), rec, stale };
}
export type RemindOp = { op: "put"; id: string; data: RemindRec };
/** The Tab list holds no keys: its save goes to the main page as this, checked again there. */
export function cleanRemindOp(v: unknown): RemindOp | null {
  const o = (v && typeof v === "object" ? v : {}) as { op?: unknown; id?: unknown; data?: unknown; kind?: unknown };
  if (o.op !== "put" || typeof o.id !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(o.id) || (o.kind !== undefined && o.kind !== "remind")) return null;
  return { op: "put", id: o.id, data: cleanRemind(o.data) };
}

// ---------- reminders ON tasks (V1.55) ----------
// The developer, 12 Nov 2026: "if I right click on the task or click edit on the task I can add an annoying 15 minute reminder and
// when I click on the settings for it it will pop up with the 15 minute reminder display where I can then customize the
// reminder for the task and I can have a task recurring every day etc."
// One reminder per task, in the same record as the list (same sync, same encryption, same cards and notifications).
// Its pop-up says the task's name (unless its own words are set) and has a third button, Open task. Done ticks the task
// and ends today's nagging; a repeating one comes back next time. Ticking the task in the list does the same. Deleting
// a task, or finishing a one-off task, takes its reminder away (after a short wait, so Undo brings both back), and a once
// reminder goes a day after its day.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Thu 12 Nov". */
export function dayWords(day: string): string {
  const [, m, d] = day.split("-").map(Number);
  return `${WEEKDAYS[weekdayOf(day)]} ${d} ${MONTHS[m - 1] ?? ""}`.trim();
}
export const TASK_GRACE_MS = 2 * 60_000;   // a task gone or finished this long takes its reminder with it

export type RepeatKind = "once" | "daily" | "weekdays" | "days";
export const REPEAT_KINDS: { id: RepeatKind; label: string }[] = [
  { id: "once", label: "Once" }, { id: "daily", label: "Every day" }, { id: "weekdays", label: "Weekdays" }, { id: "days", label: "Chosen days" },
];
export function repeatOf(r: Pick<Reminder, "days"> & { date?: string }): RepeatKind {
  if (r.date) return "once";
  const d = r.days.join(",");
  return d === "0,1,2,3,4,5,6" ? "daily" : d === "1,2,3,4,5" ? "weekdays" : "days";
}
/** The change a repeat choice makes. Once: on `day` (the day it was on, else today). Chosen days: the days it had. */
export function repeatPatch(r: Pick<Reminder, "days"> & { date?: string }, kind: RepeatKind, today: string): Partial<Reminder> {
  if (kind === "once") return { date: r.date || today };
  if (kind === "daily") return { date: undefined, days: [...ALL_DAYS] };
  if (kind === "weekdays") return { date: undefined, days: [1, 2, 3, 4, 5] };
  const keep = repeatOf(r) === "days" && r.days.length ? r.days : r.date ? [weekdayOf(r.date)] : [1, 3, 5];
  return { date: undefined, days: [...keep] };
}
const hm = (m: number) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
/** A new reminder on a task: once, today, from the next whole hour (tomorrow 09:00 when it is late), for 3 hours,
 *  Done in one click, the pink look. Its words are the task's name until the developer writes his own. */
export function newTaskReminder(id: string, task: string, now: number, deviceTz: string): Reminder {
  const w = wall(now, deviceTz);
  const today = `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
  const next = (w.h + 1) * 60;
  const late = next > 21 * 60;
  const at = late ? "09:00" : hm(next);
  return { ...newReminder(id, now), label: "", text: "", at, until: hm(minutesOf(at) + 180), yes: "Done", click: true,
    task, date: late ? addDays(today, 1) : today };
}
export const reminderOfTask = (rec: RemindRec | null, task: string) => rec?.list.find((r) => r.task === task) ?? null;
/** A reminder on a task joins the record (at the end). Nothing changes when that task has one already, or there are
 *  REM_TASK_MAX already. */
export function addTaskReminder(rec: RemindRec, r: Reminder, now: number): RemindRec {
  const c = cleanReminder(r, now);
  if (!c?.task || rec.list.some((x) => x.id === c.id || x.task === c.task) || onTasksOf(rec).length >= REM_TASK_MAX) return rec;
  const gone = { ...rec.gone }; delete gone[c.id];
  return { ...rec, list: [...rec.list, { ...c, edited: Math.max(now, c.edited) }], gone, at: Math.max(now, rec.at) };
}
/** PS 1.68 (Jan, 18 Nov 2026: adding a task offers the annoying reminder too, like its Edit): a reminder set up in the Add a
 *  task window before the task existed joins the record once the task has its id. It gets a fresh id here (the one it was
 *  drafted with may be taken by now) and the new task's id; everything else is cleaned like any reminder. */
export function addDraftTaskReminder(rec: RemindRec, draft: unknown, task: string, now: number): RemindRec {
  const c = cleanReminder(draft, now);
  if (!c || !task) return rec;
  return addTaskReminder(rec, { ...c, id: freshId(rec), task }, now);
}
/** A one-line state for the bell's hover: "Showing now", "Snoozed until 14:30", "Done for today. Next: Fri 13 Nov, 09:00". */
export function nextWords(r: Reminder, s: RemState | undefined, now: number, deviceTz: string, taskDone = false): string {
  if (!r.on) return "Reminder off";
  const st = taskDone && remStatus(r, s, now, deviceTz) !== "off" ? "done" : remStatus(r, s, now, deviceTz);
  const tz = zoneOf(r, deviceTz);
  const when = (ts: number) => {
    const w = wall(ts, tz), day = `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
    const today = dayKey(now, tz), tomorrow = addDays(today, 1);
    return `${day === today ? "Today" : day === tomorrow ? "Tomorrow" : dayWords(day)}, ${pad(w.h)}:${pad(w.mi)}`;
  };
  const n = nextStart(r, now, deviceTz);
  const next = n ? `Next: ${when(n)}` : r.date ? "No more times" : "";
  if (st === "show") return "Reminding you now";
  if (st === "snoozed" && s?.snoozeUntil) return `Snoozed until ${when(s.snoozeUntil).replace(/^Today, /, "")}`;
  if (st === "done") return `Done for now${next ? `. ${next}` : ""}`;
  return next || "No more times";
}
/** Reminders on tasks to take away now, and the times tasks were first seen gone or finished (kept by the caller,
 *  in memory). A task gone, or a one-off task finished, for TASK_GRACE_MS; a once reminder a day after its window. */
export function staleTaskReminders(rec: RemindRec, tasks: Map<string, TaskInfo>, since: Record<string, number>, now: number, deviceTz: string):
  { remove: string[]; since: Record<string, number> } {
  const remove: string[] = [];
  const next: Record<string, number> = {};
  for (const r of rec.list) {
    if (!r.task) continue;
    const t = tasks.get(r.task);
    if (!t || (t.done && !t.daily)) {
      const first = since[r.id] ?? now;
      if (now - first >= TASK_GRACE_MS) remove.push(r.id); else next[r.id] = first;
      continue;
    }
    if (r.date && now - windowOn(r, r.date, deviceTz).end >= 86_400_000) remove.push(r.id);
  }
  return { remove, since: next };
}
/** Take several reminders away at once. */
export function removeReminders(rec: RemindRec, ids: string[], now: number): RemindRec {
  return ids.reduce((x, id) => removeReminder(x, id, now), rec);
}
/** The tasks as the plan and the sweep see them (core/model.ts Todo). A task a reset cleared counts as finished. */
export function taskInfos(list: { id: string; data: { title?: unknown; done?: unknown; type?: unknown; doneAt?: unknown; clearedAt?: unknown } }[]): Map<string, TaskInfo> {
  const m = new Map<string, TaskInfo>();
  for (const d of list) {
    const t = d.data;
    m.set(d.id, { title: typeof t.title === "string" ? t.title : "", done: !!t.done || !!t.clearedAt, daily: t.type === "daily",
      doneAt: typeof t.doneAt === "string" ? t.doneAt : null });
  }
  return m;
}

// ---------- alarms (V1.57) ----------
// The developer, 13 Nov 2026: "Besides the 15 min reminders, PS can ring/alarm the phone at any time he picks, like today's 07:44 gym
// ring. He can customise that screen and the times it goes off, just like the 15 min reminders."
// An alarm is a reminder with `alarm` set, in the same record (same sync, same encryption, same Settings tab):
//  - the phone RINGS with the gym ring (ps-gos Gym.kt): full screen, on the alarm volume, through PS Do Not Disturb,
//    up to 10 minutes then a missed notice, Later rings again in 5. Its words, title and colours are the alarm's own.
//    The page hands the rings over with the gym plan (gymwatch.ts, alarmRings below), never in the reminders' plan;
//  - the Mac shows the matching card: the reminder card (ps-mac Reminders.swift) with the alarm's colours and words,
//    for its 10 minute window (a card already up stays until answered);
//  - Acknowledge on either one is the reminder's "done" for that day (applyAct), so both stop.
/** A new alarm: 07:00 every day, this device's time zone, amber, the alarm tone on the Mac. */
export function newAlarm(id: string, now: number): Reminder {
  const r = cleanReminder({ ...newReminder(id, now), alarm: true, label: "", text: "", at: "07:00", yes: "", bg: "#2a1a08", accent: "#f59e0b", sound: "alarm" }, now)!;
  return r;
}
export function addAlarm(rec: RemindRec, id: string, now: number): RemindRec {
  if (ownCount(rec) >= REM_MAX || !ID.test(id) || rec.list.some((r) => r.id === id)) return rec;
  const gone = { ...rec.gone }; delete gone[id];
  const list = [...rec.list];
  const at = list.findIndex((r) => !!r.task);
  list.splice(at < 0 ? list.length : at, 0, newAlarm(id, now));
  return { ...rec, list, gone, at: Math.max(now, rec.at) };
}
/** One ring the phone needs: which alarm, its day (its "done" day), when, and how its screen looks. */
export interface AlarmRing { id: string; day: string; at: number; title: string; text: string; yes: string; later: string; bg: string; accent: string; ink: string; one?: boolean; word?: string }
export const ALARM_RINGS_MAX = 40;
/** The rings to come for the phone (and the ones that may still be ringing or snoozed, up to 6 hours back), soonest
 *  first, without the days already acknowledged. An alarm switched off or removed is simply not here, so a phone
 *  ringing it stops. */
export function alarmRings(rec: RemindRec | null, now: number, deviceTz: string): AlarmRing[] {
  if (!rec) return [];
  const out: AlarmRing[] = [];
  for (const r of rec.list) {
    if (!r.alarm || !r.on || !r.days.length) continue;
    const today = dayKey(now, zoneOf(r, deviceTz));
    for (let i = -1; i <= 8; i++) {
      const day = addDays(today, i);
      if (!r.days.includes(weekdayOf(day)) || rec.state[r.id]?.done === day) continue;
      const at = windowOn(r, day, deviceTz).start;
      if (at < now - 6 * 3_600_000) continue;
      out.push({ id: r.id, day, at, title: pillOf(r), text: alarmText(r), yes: yesOf(r), later: ALARM_LATER, bg: r.bg, accent: r.accent, ink: inkFor(r.bg) });
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(0, ALARM_RINGS_MAX);
}
