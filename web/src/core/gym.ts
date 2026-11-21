// The gym reminder (the developer, 2 Nov 2026): every day at 08:00 by default (since 1.72 only once saved); Fitness settings change the time, the
// days and on/off. Mac PS shows one card 2 h, 1 h, 30 min and 10 min before (the same card, its words move
// on); the phone gets a notification at the same four times and RINGS at gym time minus 16 minutes, full
// screen, until the developer taps Yes (ps-gos Gym.kt). Yes (it said Acknowledge until V1.57) on either device is saved
// in the vault (settings.gymAck, the day), so the ring stops, the Mac card goes and that day's later reminders
// stay quiet. Gym already shows in the Meetings panel from his calendar, so nothing is added there.
// The developer's choices (2 Nov 2026): each phone ring stops by itself after 10 minutes and leaves a missed-gym
// notification; Later is 5 minutes, then it rings again (the Mac card's Later: back in 5 minutes with its
// chime); the ring is an alarm and rings through PS Do Not Disturb, the Mac card stays quiet under it.
//
// V1.57 (the developer, 13 Nov 2026: "gym reminder that nags every 15 minutes until I say Yes, plus a settable ring time"):
//  - Nag mode: from a start time (default 10:00) a reminder every 15 minutes (settable) on the Mac and the phone,
//    until the developer says "Yes, I'm going" (or the gym time is over). It takes the place of the 2 h, 1 h, 30 min and
//    10 min steps. A Mac that slept through some shows ONE when it wakes, never a pile.
//  - Ring time: an exact time (his: 22:55) instead of gym time minus 16 minutes. Only without a Yes that day.
//  - The gym has an end time and may run past midnight (his: 23:00 to 01:00). "The day" (for Yes and the ring)
//    is the day the nagging starts, never the day the gym ends. With nag mode on, a gym time earlier in the day
//    than the nag start is the next morning's (nag from 10:00, gym 00:30: the gym is after midnight).
//
// Pure: no vault, no clock, no storage. Times are wall clock times in the developer's own zone (settings.tmHomeTz,
// else this device's). A reminder fires only within its grace: a Mac that slept through 06:00 and 07:00
// does not throw two stale cards at him when it wakes at 07:10, it waits for 07:30.
import { wall, zonedToTs } from "./tz.ts";
import { dndMutes, type Dnd } from "./dnd.ts";

export interface GymPrefs {
  on: boolean;
  time: string;        // "HH:MM" the gym starts
  end: string;         // "HH:MM" the gym ends (may be after midnight); "" = 1 h 30 after the start, as before V1.57
  days: number[];      // the days it is on: 0 Sunday to 6 Saturday (the day the nagging starts, or the gym starts)
  nag: boolean;        // nag mode: every `nagEvery` minutes from `nagStart` until Yes
  nagStart: string;    // "HH:MM"
  nagEvery: number;    // minutes
  ringAt: string;      // "HH:MM" the phone rings; "" = gym time minus 16 minutes, as before V1.57
}
export const NAG_MIN = 5, NAG_MAX = 120;
export const GYM_DEFAULTS: GymPrefs = { on: true, time: "08:00", end: "", days: [0, 1, 2, 3, 4, 5, 6], nag: false, nagStart: "10:00", nagEvery: 15, ringAt: "" };
export const GYM = {
  before: [120, 60, 30, 10] as readonly number[],   // minutes before: the Mac card, the phone's notifications (nag mode off)
  ring: 16,                                         // minutes before: the phone rings (when no ring time is set)
  grace: 2 * 60_000,                                // later than this, a reminder is stale and skipped
  cardStays: 90 * 60_000,                           // with no end time set, the gym (and the card) ends this long after it starts
  snooze: 5 * 60_000,                               // Later: the Mac card comes back after this (the phone rings again)
  keepDays: 14,                                     // days with a Yes kept this long
} as const;
export const YES_WORDS = "Yes, I'm going";

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const okHm = (v: unknown): v is string => typeof v === "string" && HM.test(v);
const minsOf = (hm: string) => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };
const pad = (n: number) => String(n).padStart(2, "0");
const hmOf = (m: number) => { const x = ((m % 1440) + 1440) % 1440; return `${pad(Math.floor(x / 60))}:${pad(x % 60)}`; };
/** The end time in use: its own, else 1 h 30 after the start. */
export const gymEnd = (p: Pick<GymPrefs, "time" | "end">) => (p.end && p.end !== p.time ? p.end : hmOf(minsOf(p.time) + GYM.cardStays / 60_000));
/** The ring time in use: its own, else 16 minutes before the gym. */
export const gymRingAt = (p: Pick<GymPrefs, "time" | "ringAt">) => p.ringAt || hmOf(minsOf(p.time) - GYM.ring);

/** Prefs from the vault (or an old or broken copy), with the defaults filled in field by field. `defOn`: whether it is
 *  on before anything was saved. The developer's is on (unchanged); anyone else's starts off until they switch it on in Fitness
 *  settings (7 Nov 2026: the public PS has the gym reminder too, but it never rings a stranger's phone uninvited).
 *  Settings saved before V1.57 (on, time, days only) load with nag mode off, no end time and no ring time, so they
 *  work exactly as before. */
/** PS 1.72 (the developer, 21 Nov 2026: "at like seven forty four AM I still get the calls on my phone telling me to go to the gym
 *  ... I don't even go to the gym in the morning now. So I want you to remove that"): a gym reminder that was NEVER saved
 *  (no gym record in the settings at all) is OFF, the developer's too. Before, the developer's unsaved reminder was on at the 08:00 default,
 *  so the phone rang at 07:44 (08:00 minus 16 minutes) every morning and the Mac showed its 06:00 to 07:50 cards, for a
 *  gym time nobody picked. The reminder now rings only for a time saved in Fitness settings. A saved record (even an
 *  old one without `on`) keeps `defOn` as before. */
export function gymPrefs(raw: unknown, defOn: boolean = GYM_DEFAULTS.on): GymPrefs {
  if (!raw || typeof raw !== "object") defOn = false;
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof GymPrefs, unknown>>;
  const time = okHm(r.time) ? r.time : GYM_DEFAULTS.time;
  const days = Array.isArray(r.days) ? [...new Set(r.days.filter((d): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6))].sort((a, b) => a - b) : GYM_DEFAULTS.days;
  const every = typeof r.nagEvery === "number" && Number.isFinite(r.nagEvery) ? Math.round(Math.max(NAG_MIN, Math.min(NAG_MAX, r.nagEvery))) : GYM_DEFAULTS.nagEvery;
  return {
    on: typeof r.on === "boolean" ? r.on : defOn, time,
    end: okHm(r.end) && r.end !== time ? r.end : "",
    days,
    nag: r.nag === true,
    nagStart: okHm(r.nagStart) ? r.nagStart : GYM_DEFAULTS.nagStart,
    nagEvery: every,
    ringAt: okHm(r.ringAt) ? r.ringAt : "",
  };
}

/** 1.60 (the phone rang for the gym in the morning although the gym is set for the night): may a gym plan be worked out and
 *  handed to the phone now? Only from the saved settings. Before the vault has loaded them (just unlocked, the first sync
 *  still running, nothing saved yet on this device) gymPrefs() would fall back to its 08:00 default, and the phone would
 *  be told to ring for a gym nobody set. A settings record that is here (even a cached one) is the saved setting; with none,
 *  only a finished sync says that nothing was ever saved. */
export function gymReady(v: { hasSettings: boolean; syncing: boolean; lastSync: string | null }): boolean {
  return v.hasSettings || (!v.syncing && !!v.lastSync);
}

/** "2026-11-03": the day in that zone. */
export function dayKey(ts: number, tz: string) { const w = wall(ts, tz); return `${w.y}-${pad(w.mo)}-${pad(w.d)}`; }
export const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
const weekday = (day: string) => { const [y, m, d] = day.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const tsOf = (day: string, hm: string, tz: string) => { const [y, m, d] = day.split("-").map(Number); const [h, mi] = hm.split(":").map(Number); return zonedToTs(y, m, d, h, mi, tz); };

/** One gym day. `day` is THE day (Yes, the ring, the days picked): the day the nagging starts, or the gym starts with
 *  nag mode off. `from` the first reminder, `at` the gym starts, `end` it ends (the card leaves), `ring` the phone rings. */
export interface GymTime { day: string; at: number; end: number; ring: number; from: number }
/** The gym day that starts on `day`, whatever the days picked. */
export function gymOn(p: GymPrefs, day: string, tz: string): GymTime {
  const nagFrom = tsOf(day, p.nagStart, tz);
  // Nag mode: the gym is the first gym time from the nag start on (the same day, or after midnight).
  let at = tsOf(day, p.time, tz);
  if (p.nag && minsOf(p.time) < minsOf(p.nagStart)) at = tsOf(addDays(day, 1), p.time, tz);
  const atDay = dayKey(at, tz);
  const endHm = gymEnd(p);
  let end = tsOf(atDay, endHm, tz);
  if (end <= at) end = tsOf(addDays(atDay, 1), endHm, tz);
  // The ring: the last ring time before the gym ends (22:55 for a 23:00 to 01:00 gym; 00:30 rings after midnight).
  let ring: number;
  if (!p.ringAt) ring = at - GYM.ring * 60_000;
  else {
    const endDay = dayKey(end, tz);
    ring = tsOf(endDay, p.ringAt, tz);
    if (ring >= end) ring = tsOf(addDays(endDay, -1), p.ringAt, tz);
  }
  const from = p.nag ? Math.min(nagFrom, at) : at - Math.max(...GYM.before) * 60_000;
  return { day, at, end, ring, from };
}

/** Gym days from yesterday to `ahead` days on, not over yet (before their end). */
export function gymTimes(p: GymPrefs, now: number, tz: string, ahead = 8): GymTime[] {
  if (!p.on || !p.days.length) return [];
  const today = dayKey(now, tz), out: GymTime[] = [];
  for (let i = -1; i <= ahead; i++) {
    const day = addDays(today, i);
    if (!p.days.includes(weekday(day))) continue;
    const g = gymOn(p, day, tz);
    if (g.end > now) out.push(g);
  }
  return out;
}
/** The gym day that is on now (from its first reminder to its end), else today's still to come, else null. */
export function gymToday(p: GymPrefs, now: number, tz: string): GymTime | null {
  const all = gymTimes(p, now, tz, 1);
  return all.find((g) => g.from <= now && now < g.end) ?? all.find((g) => g.day === dayKey(now, tz)) ?? null;
}

/** One reminder. `mins`: minutes before the gym (0 or less once it started). `grace`: how late it may still come. */
export interface GymStep { id: string; day: string; at: number; mins: number; due: number; ring: boolean; nag: boolean; grace: number }
/** Every reminder still to come for the days without a Yes, soonest first. */
export function gymSteps(p: GymPrefs, now: number, tz: string, acked: string[] = [], ahead = 8): GymStep[] {
  const out: GymStep[] = [];
  for (const g of gymTimes(p, now, tz, ahead)) {
    if (acked.includes(g.day)) continue;
    if (p.nag) {
      const every = p.nagEvery * 60_000;
      for (let k = 0, t = g.from; t < g.end && k < 400; k++, t += every)
        out.push({ id: `${g.day}:n${k}`, day: g.day, at: g.at, mins: Math.round((g.at - t) / 60_000), due: t, ring: false, nag: true, grace: every });
    } else {
      for (const mins of GYM.before) out.push({ id: `${g.day}:${mins}`, day: g.day, at: g.at, mins, due: g.at - mins * 60_000, ring: false, nag: false, grace: GYM.grace });
    }
    out.push({ id: `${g.day}:r`, day: g.day, at: g.at, mins: Math.round((g.at - g.ring) / 60_000), due: g.ring, ring: true, nag: false, grace: GYM.grace });
  }
  return out.sort((a, b) => a.due - b.due);
}

/** The Mac card step to show now: due, within its grace, not shown yet. Null when none (a stale one is skipped).
 *  Nag steps keep their grace for the whole interval and only the newest counts: a Mac that slept shows ONE. */
export function gymDue(p: GymPrefs, now: number, tz: string, acked: string[], fired: string[]): GymStep | null {
  const live = gymSteps(p, now, tz, acked).filter((s) => !s.ring && s.due <= now && now < s.due + s.grace);
  const newest = live[live.length - 1];
  return newest && !fired.includes(newest.id) ? newest : null;
}

/** The card that belongs on screen now: the newest reminder this Mac really showed for a day without a Yes, until
 *  the gym ends. After a restart it comes back the same, quietly. */
export function gymCard(p: GymPrefs, now: number, tz: string, acked: string[], fired: string[]): { day: string; at: number; mins: number } | null {
  const shown = gymSteps(p, now, tz, acked, 1).filter((s) => !s.ring && s.due <= now && fired.includes(s.id));
  const s = shown[shown.length - 1];
  return s ? { day: s.day, at: s.at, mins: s.mins } : null;
}

/** When to look again (ms): the next card step, Later being over, or the shown card leaving by itself. 0 = nothing coming. */
export function gymNextWake(p: GymPrefs, now: number, tz: string, acked: string[], fired: string[], snooze?: GymSnooze | null): number {
  const times = gymSteps(p, now, tz, acked).filter((s) => !s.ring && s.due > now).map((s) => s.due);
  const c = gymCard(p, now, tz, acked, fired);
  if (c) { const g = gymTimes(p, now, tz, 1).find((x) => x.day === c.day); if (g) times.push(g.end); }
  if (c && snooze && snooze.day === c.day && snooze.until > now) times.push(snooze.until);
  return times.length ? Math.min(...times) : 0;
}

/** Later on the Mac card: put away for GYM.snooze, then back with its chime. */
export interface GymSnooze { day: string; until: number }
export function gymLater(day: string, now: number): GymSnooze { return { day, until: now + GYM.snooze }; }
/** Is the card for `day` put away by Later right now? */
export function gymSnoozed(s: GymSnooze | null | undefined, day: string, now: number) { return !!s && s.day === day && now < s.until; }

/** Quiet under PS Do Not Disturb? The Mac card yes (it follows meetings), the phone's ring never: it is an
 *  alarm (the developer, 2 Nov 2026). So the phone plan (gymPlan) never looks at DND. */
export function gymQuiet(what: "card" | "ring", dnd: Dnd | null | undefined, now: number) {
  return what === "card" && dndMutes(dnd, "meetings", now, "mac");
}

/** The card's words: "Gym in 2 h" / "Gym in 30 min" / "Gym now" and "08:00 today" (or "23:00 to 01:00 today"). */
export function gymCardText(c: { at: number; mins: number }, now: number, tz: string, time: string, end?: string) {
  const left = Math.round((c.at - now) / 60_000);
  const title = left <= 0 ? "Gym time" : left >= 60 && left % 60 === 0 ? `Gym in ${left / 60} h` : left > 60 ? `Gym in ${Math.floor(left / 60)} h ${left % 60} min` : `Gym in ${left} min`;
  const sub = `${end ? `${time} to ${end}` : time} ${dayKey(c.at, tz) === dayKey(now, tz) ? "today" : "tomorrow"}`;
  return { title, sub };
}

/** The list with one more day with a Yes; days older than GYM.keepDays are dropped. */
export function ackGym(list: string[] | undefined, day: string, now: number, tz: string): string[] {
  const oldest = addDays(dayKey(now, tz), -GYM.keepDays);
  return [...new Set([...(list || []), day])].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= oldest).sort().slice(-30);
}
/** Fired step ids worth keeping (yesterday on). */
export function pruneFired(fired: string[], now: number, tz: string) {
  const y = addDays(dayKey(now, tz), -1);
  return fired.filter((f) => f.slice(0, 10) >= y).slice(-80);
}

/** What the phone shell needs to remind and ring by itself while PS sleeps (ps-gos Gym.kt). Only times, never a
 *  title: the shell words it. The days with a Yes are left out. Each item carries its own ring time, end and, in nag
 *  mode, the first reminder and the interval (`before` and `ring` stay for a phone app older than V1.57). */
export function gymPlan(p: GymPrefs, now: number, tz: string, acked: string[]) {
  return {
    on: p.on, time: p.time, end: gymEnd(p), ringAt: gymRingAt(p), nag: p.nag,
    items: gymTimes(p, now, tz, 8).filter((g) => !acked.includes(g.day)).map((g) => ({ day: g.day, at: g.at, end: g.end, ring: g.ring, from: g.from, every: p.nag ? p.nagEvery * 60_000 : 0 })),
    acked: acked.slice(-14), before: [...GYM.before], ring: GYM.ring, grace: GYM.grace,
  };
}

// ---------- the Task API (Settings, AI task API, the "gym" switch) ----------
// The developer: "GET /v1/gym and PATCH /v1/gym to read and change: on, time, end time, days, nag start, nag interval, ring
// time... The API can never answer Yes for me." So nothing here ever touches settings.gymAck.
export const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export interface ApiGym { on: boolean; time: string; endTime: string; days: string[]; nag: boolean; nagStart: string; nagEvery: number; ringTime: string; saidYesToday: boolean }
export const API_GYM_FIELDS = ["on", "time", "endTime", "days", "nag", "nagStart", "nagEvery", "ringTime"] as const;
/** Fields that would say Yes: refused by name (unknown fields are refused anyway). */
export const API_GYM_YES = ["yes", "ack", "acknowledge", "acknowledged", "gymAck", "saidYes", "saidYesToday", "going", "done"];
export const API_NO_YES = "The API can never say Yes to the gym for the person. Only they can, on their Mac or phone.";
export function apiGym(p: GymPrefs, acked: string[], now: number, tz: string): ApiGym {
  const t = gymToday(p, now, tz);
  return { on: p.on, time: p.time, endTime: gymEnd(p), days: p.days.map((d) => DAY_NAMES[d]), nag: p.nag, nagStart: p.nagStart,
    nagEvery: p.nagEvery, ringTime: gymRingAt(p), saidYesToday: !!t && acked.includes(t.day) };
}
/** A PATCH body checked: the new prefs, or what is wrong (field and words). endTime or ringTime null: the old default. */
export function apiGymPatch(p: GymPrefs, b: Record<string, unknown>): { prefs: GymPrefs } | { field: string; message: string } {
  const next: GymPrefs = { ...p, days: [...p.days] };
  const hm = (k: string, v: unknown) => (okHm(v) ? null : { field: k, message: `${k} must be a time like "22:55" (24 hour, HH:MM).` });
  for (const [k, v] of Object.entries(b)) {
    if (k === "on" || k === "nag") { if (typeof v !== "boolean") return { field: k, message: `${k} must be true or false.` }; next[k] = v; }
    else if (k === "time") { const e = hm(k, v); if (e) return e; next.time = v as string; }
    else if (k === "nagStart") { const e = hm(k, v); if (e) return e; next.nagStart = v as string; }
    else if (k === "endTime") { if (v === null) next.end = ""; else { const e = hm(k, v); if (e) return e; next.end = v as string; } }
    else if (k === "ringTime") { if (v === null) next.ringAt = ""; else { const e = hm(k, v); if (e) return e; next.ringAt = v as string; } }
    else if (k === "nagEvery") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < NAG_MIN || v > NAG_MAX) return { field: k, message: `nagEvery must be whole minutes from ${NAG_MIN} to ${NAG_MAX}.` };
      next.nagEvery = v;
    } else if (k === "days") {
      if (!Array.isArray(v) || v.length > 7) return { field: k, message: `days must be a list like ["mon", "wed", "fri"] (sun to sat), or numbers 0 (Sunday) to 6.` };
      const out: number[] = [];
      for (const d of v) {
        const i = typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6 ? d : typeof d === "string" ? DAY_NAMES.indexOf(d.trim().toLowerCase().slice(0, 3) as typeof DAY_NAMES[number]) : -1;
        if (i < 0) return { field: k, message: `days must be a list like ["mon", "wed", "fri"] (sun to sat), or numbers 0 (Sunday) to 6.` };
        out.push(i);
      }
      next.days = [...new Set(out)].sort((a, b) => a - b);
    }
  }
  if (next.end === next.time) return { field: "endTime", message: "endTime must not be the same as time." };
  return { prefs: gymPrefs(next, p.on) };
}
