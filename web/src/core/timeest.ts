// Time estimates, real time spent and the overload warning (PS 1.65, request from the developer's AI, 17 Nov 2026: "A task can have
// an estimate (15 min, 30 min, 1 h, 2 h, or typed). PS measures how long a task really takes: from when the person starts it to the
// tick, minus AFK breaks, plus Pomodoro time spent on it. Kept only in the person's own vault, sealed ... Learning: when a task with
// the same or a very similar name is added again, PS shows 'Usually takes about 40 min' and fills in the estimate ... Overload
// warning: today's estimates against the free time today (working hours minus meetings). A line in the list, never a pop-up, never
// repeated.")
//
// What is here (pure: no vault, no clock of its own, no DOM; tests/timeest.test.ts checks every rule):
//  - the setting (three switches, all on, and the working hours), the estimate itself (choices, typed words, labels),
//  - the clock: spans of time per task (started by Working on or the Start button, stopped by taking Working on off, Stop or the
//    tick), Pomodoro pieces (work counts for the tasks being worked on, breaks are taken off), AFK breaks taken off,
//  - the two record shapes (kind "ttime", owner only, sealed with the vault key like the day log and Rewind) and how two devices
//    merge them: one "live" record (the clocks now) and one record per month (what each finished task really took),
//  - learning: similar names, the past times and "Usually takes about",
//  - free time today and the overload line, once per day.
// The page side (saving, the hooks in core/actions.ts) is src/timespent.ts; the screens are views/TimeEstimate.tsx.
import type { AwayEntry, Doc, Todo } from "./model";
import { wall, zonedToTs } from "./tz.ts";

export const TE_FEATURE = "time-estimates";
export const TE_KIND = "ttime";

// ---------- the setting ----------
/** est: estimates on tasks (and learning). track: real time spent. warn: the overload line. from, to: working hours ("HH:MM",
 *  a "to" before "from" runs past midnight, equal is the whole day). */
export interface TePrefs { est: boolean; track: boolean; warn: boolean; from: string; to: string }
export const TE_DEFAULT: TePrefs = { est: true, track: true, warn: true, from: "09:00", to: "17:00" };
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export function cleanTe(v: unknown): TePrefs {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    est: o.est !== false, track: o.track !== false, warn: o.warn !== false,
    from: typeof o.from === "string" && HHMM.test(o.from) ? o.from : TE_DEFAULT.from,
    to: typeof o.to === "string" && HHMM.test(o.to) ? o.to : TE_DEFAULT.to,
  };
}
const mins = (hm: string) => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };

// ---------- the words (every one for the developer's approval) ----------
export const TE_WORDS = {
  estimate: "Expected time",      // PS 1.77 (the developer: "expected time"); was "Estimate"
  noEstimate: "No time set",      // PS 1.77; was "No estimate"
  other: "Other",
  typeHint: "Type it, like 45 or 1h 30",
  set: "Set",
  start: "Start",
  stop: "Stop",
  running: "Timing",
  usually: (m: number) => `Usually takes about ${estLabel(m)}`,
  past: "Recent times",                   // PS 1.77; was "Past times"
  // PS 1.77 learning from real times (learnFrom): every one waits for the developer's approval
  learned: (n: number, m: number) => `Learned from your last ${n} times: ${estLabel(m)}`,
  learnsAfter: (n: number) => `PS learns the expected time after ${LEARN.need} times (${n} so far)`,
  learnIt: "Learn it",
  leftOut: "Left out",
  quick: "too quick",
  far: "far from the rest",
  learnedTip: "learned from your times",
  spentSoFar: (m: number) => `${estLabel(Math.max(1, m))} so far`,
  overload: (planned: number, free: number) => `You've planned ${hoursWords(planned)} with ${hoursWords(free)} free`,
  rethink: "Rethink",
  close: "Not now",
  settingsEst: "Time estimates",
  settingsEstLine: "Give a task an estimate. A new task with a name you used before gets its usual time.",
  settingsTrack: "Time spent",
  settingsTrackLine: "How long a task really takes, Working on or Start to the tick, less breaks. Only in your own vault.",
  settingsWarn: "Too much planned",
  settingsWarnLine: "A quiet line at the top of your list when today's estimates are more than your free time.",
  settingsHours: "Working hours",
  settingsHoursLine: "Free time is these hours minus your meetings. An end before the start runs past midnight.",
} as const;

// ---------- the estimate ----------
/** The quick picks (PS 1.77, the developer 23 Nov 2026: "10 min, 20 min, 30 min, 45 min, 1 h, 2 h, 5 h", and a box to type any time).
 *  Before 1.77: 15 min, 30 min, 1 h, 2 h. A stored 15 still shows, as a typed time. */
export const EST_CHOICES = [10, 20, 30, 45, 60, 120, 300] as const;
export const EST_MAX = 24 * 60;
/** A stored estimate: whole minutes from 1 to 24 hours, anything else is none. */
export function cleanEst(v: unknown): number | null {
  const n = typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.min(EST_MAX, Math.round(n)) : null;
}
/** "15 min", "1 h", "1 h 30 min", "2 h". */
export function estLabel(m: number): string {
  const n = Math.max(0, Math.round(m)), h = Math.floor(n / 60), r = n % 60;
  return h === 0 ? `${r} min` : r === 0 ? `${h} h` : `${h} h ${r} min`;
}
/** Short, for the badge on a task: "15m", "1h", "1h30". */
export function estShort(m: number): string {
  const n = Math.max(0, Math.round(m)), h = Math.floor(n / 60), r = n % 60;
  return h === 0 ? `${r}m` : r === 0 ? `${h}h` : `${h}h${String(r).padStart(2, "0")}`;
}
/** For the overload line: under an hour in minutes (to 5), from an hour in half hours ("1.5 h", "9 h"). */
export function hoursWords(m: number): string {
  const n = Math.max(0, m);
  if (n < 60) return `${Math.round(n / 5) * 5} min`;
  const h = Math.round(n / 30) / 2;
  return `${h} h`;
}
/** What a person typed as an estimate: "45", "45m", "45 min", "1h", "1.5h", "1h 30", "1h30m", "1:30", "90 minutes", "2 hours".
 *  A plain number is minutes. Null when it cannot be read or is out of range. */
export function parseEst(typed: unknown): number | null {
  if (typeof typed !== "string") return null;
  const s = typed.trim().toLowerCase().replace(/,/g, ".").replace(/\s+/g, " ");
  if (!s) return null;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,2}):([0-5]\d)$/.exec(s))) return cleanEst(+m[1] * 60 + +m[2]);
  if ((m = /^(\d+(?:\.\d+)?) ?(m|min|mins|minute|minutes)?$/.exec(s))) return cleanEst(+m[1]);
  if ((m = /^(\d+(?:\.\d+)?) ?(h|hr|hrs|hour|hours)(?: ?(\d{1,2}) ?(m|min|mins|minute|minutes)?)?$/.exec(s))) {
    const total = +m[1] * 60 + (m[3] ? +m[3] : 0);
    return total >= 1 && total <= EST_MAX ? cleanEst(total) : null;
  }
  return null;
}

// ---------- spans of time ----------
export type Span = [number, number];   // [start ms, end ms]; an end of 0 is still running
/** Spans joined where they touch or overlap, in order. Running spans are closed at `now`. */
export function unionSpans(list: Span[], now = Infinity): Span[] {
  const l = list.map(([s, e]): Span => [s, e || now]).filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s).sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const [s, e] of l) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
export const spanTotal = (l: Span[]) => unionSpans(l).reduce((n, [s, e]) => n + (e - s), 0);
/** The time of `a` that `b` covers. */
export function overlapMs(a: Span[], b: Span[]): number {
  const x = unionSpans(a), y = unionSpans(b);
  let n = 0, j = 0;
  for (const [s, e] of x) {
    while (j < y.length && y[j][1] <= s) j++;
    for (let k = j; k < y.length && y[k][0] < e; k++) n += Math.max(0, Math.min(e, y[k][1]) - Math.max(s, y[k][0]));
  }
  return n;
}
/** AFK and other breaks (settings.awayLog, seconds) as spans in ms. */
export const awaySpans = (log: AwayEntry[] | undefined): Span[] =>
  (log || []).filter((a) => a && Number.isFinite(a.s) && Number.isFinite(a.e) && a.e > a.s).map((a): Span => [a.s * 1000, a.e * 1000]);

// ---------- the live record: the clocks running now ----------
/** One task's clock: its title (for the month record) and its spans since it was last finished. */
export interface TClock { n: string; sp: Span[] }
/** A Pomodoro phase that ended: [start, end, 1 for a break, the tasks being worked on]. Keyed by the phase id (core/pomodoro.ts),
 *  which is the same on every device, so two devices noting it make one piece. */
export type TPomo = [number, number, 0 | 1, string[]];
export interface TLive {
  t: "live"; v: 1; at: number;
  run: Record<string, TClock>;
  /** When each task was last finished: spans that began before it belong to that round, not the next. */
  end: Record<string, number>;
  /** Time already counted for a task that was unticked again, added to its next finish: [minutes, when]. */
  carry: Record<string, [number, number]>;
  pomo: Record<string, TPomo>;
}
export const TL = { title: 80, spans: 60, tasks: 120, pomoKeepMs: 3 * 86_400_000, endKeepMs: 45 * 86_400_000, idleKeepMs: 14 * 86_400_000, carryMs: 12 * 3_600_000 };
export const emptyLive = (at = 0): TLive => ({ t: "live", v: 1, at, run: {}, end: {}, carry: {}, pomo: {} });

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
const cut = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, TL.title);
const okSpan = (x: unknown): x is Span => Array.isArray(x) && x.length === 2 && num(x[0]) > 0 && (x[1] === 0 || num(x[1]) >= num(x[0]));

/** A stored live record read safely: anything odd is dropped, never thrown. */
export function cleanLive(v: unknown): TLive {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, any>;
  const out = emptyLive(num(o.at) || 0);
  if (o.t !== "live") return out;
  for (const [id, c] of Object.entries(o.run && typeof o.run === "object" ? o.run : {})) {
    const sp = Array.isArray((c as TClock)?.sp) ? (c as TClock).sp.filter(okSpan).slice(-TL.spans) : [];
    if (sp.length) out.run[id] = { n: cut((c as TClock).n), sp: sp.map(([s, e]) => [s, e] as Span) };
  }
  for (const [id, t] of Object.entries(o.end && typeof o.end === "object" ? o.end : {})) if (num(t) > 0) out.end[id] = t as number;
  for (const [id, c] of Object.entries(o.carry && typeof o.carry === "object" ? o.carry : {}))
    if (Array.isArray(c) && num(c[0]) >= 0 && num(c[1]) > 0) out.carry[id] = [c[0], c[1]];
  for (const [id, p] of Object.entries(o.pomo && typeof o.pomo === "object" ? o.pomo : {}))
    if (Array.isArray(p) && num(p[0]) > 0 && num(p[1]) >= num(p[0]) && Array.isArray(p[3])) out.pomo[id] = [p[0], p[1], p[2] ? 1 : 0, p[3].filter((x: unknown) => typeof x === "string").slice(0, 20)];
  return out;
}

/** Spans of one task from two copies: the same start is the same span (a stop seen on either copy wins: the earlier end). */
function mergeSpans(a: Span[], b: Span[]): Span[] {
  const by = new Map<number, number>();
  for (const [s, e] of [...a, ...b]) {
    if (!by.has(s)) { by.set(s, e); continue; }
    const had = by.get(s)!;
    by.set(s, had === 0 ? e : e === 0 ? had : Math.min(had, e));
  }
  return [...by].sort((x, y) => x[0] - y[0]).map(([s, e]) => [s, e] as Span).slice(-TL.spans);
}
/** Spans that began after the task's last finish (the ones before belong to a round already counted). */
const afterEnd = (sp: Span[], end: number | undefined) => (end ? sp.filter(([s]) => s > end) : sp);

/** Two copies of the live record into one, whichever came first. Merging a copy with itself changes nothing. */
export function mergeLive(x: TLive, y: TLive): TLive {
  const a = cleanLive(x), b = cleanLive(y);
  const out = emptyLive(Math.max(a.at, b.at));
  for (const id of new Set([...Object.keys(a.end), ...Object.keys(b.end)])) out.end[id] = Math.max(a.end[id] ?? 0, b.end[id] ?? 0);
  for (const id of new Set([...Object.keys(a.carry), ...Object.keys(b.carry)])) {
    const p = a.carry[id], q = b.carry[id];
    out.carry[id] = !p ? q! : !q ? p : p[1] >= q[1] ? p : q;
  }
  for (const id of new Set([...Object.keys(a.run), ...Object.keys(b.run)])) {
    const p = a.run[id], q = b.run[id];
    const sp = afterEnd(mergeSpans(p?.sp ?? [], q?.sp ?? []), out.end[id]);
    if (sp.length) out.run[id] = { n: (p && q ? (a.at >= b.at ? p.n : q.n) : (p ?? q)!.n), sp };
  }
  for (const id of new Set([...Object.keys(a.pomo), ...Object.keys(b.pomo)])) {
    const p = a.pomo[id], q = b.pomo[id];
    out.pomo[id] = !p ? q! : !q ? p : [Math.min(p[0], q[0]), Math.max(p[1], q[1]), (p[2] || q[2]) as 0 | 1, [...new Set([...p[3], ...q[3]])].slice(0, 20)];
  }
  return out;
}

/** Old things out: Pomodoro pieces after 3 days, finish marks after 45, a clock with nothing running after 14, carries after 12 hours;
 *  at most 120 clocks (the oldest go). */
export function pruneLive(l: TLive, now: number): TLive {
  const out = structuredClone(l);
  for (const [id, p] of Object.entries(out.pomo)) if (now - p[1] > TL.pomoKeepMs) delete out.pomo[id];
  for (const [id, t] of Object.entries(out.end)) if (now - t > TL.endKeepMs) delete out.end[id];
  for (const [id, c] of Object.entries(out.carry)) if (now - c[1] > TL.carryMs) delete out.carry[id];
  for (const [id, c] of Object.entries(out.run)) {
    const last = Math.max(...c.sp.map(([s, e]) => e || Infinity));
    if (last !== Infinity && now - last > TL.idleKeepMs) delete out.run[id];
  }
  const ids = Object.keys(out.run);
  if (ids.length > TL.tasks) {
    const lastOf = (id: string) => Math.max(...out.run[id].sp.map(([s, e]) => e || now + s));
    for (const id of ids.sort((p, q) => lastOf(p) - lastOf(q)).slice(0, ids.length - TL.tasks)) delete out.run[id];
  }
  return out;
}

/** Clocks of tasks that are gone (deleted, cleared) are let go, once their newest span is 6 hours old (a task made on another device
 *  may reach this one after its clock does). */
export function dropGone(l: TLive, exists: (id: string) => boolean, now: number): TLive {
  const gone = Object.keys(l.run).filter((id) => !exists(id) && now - Math.max(...l.run[id].sp.map(([s]) => s)) > 6 * 3_600_000);
  if (!gone.length) return l;
  const out = structuredClone(l);
  for (const id of gone) delete out.run[id];
  return out;
}

/** Is this task's clock running now? */
export const isRunning = (l: TLive, id: string) => !!l.run[id]?.sp.some(([, e]) => e === 0);
/** The task ids with a clock running. */
export const runningIds = (l: TLive) => Object.keys(l.run).filter((id) => isRunning(l, id));

/** Start a task's clock (Working on, or Start). Already running: unchanged (null). */
export function startClock(l: TLive, id: string, title: string, now: number): TLive | null {
  if (isRunning(l, id)) return null;
  const out = structuredClone(l);
  const c = out.run[id] ?? { n: cut(title), sp: [] };
  c.n = cut(title) || c.n;
  // A start inside the moment of the last finish (a tick and a start in the same millisecond) is moved just past it.
  const at = Math.max(now, (out.end[id] ?? 0) + 1);
  c.sp = [...c.sp, [at, 0] as Span].slice(-TL.spans);
  out.run[id] = c;
  out.at = now;
  return out;
}
/** Stop a task's clock (Working on taken off, or Stop). Not running: unchanged (null). */
export function stopClock(l: TLive, id: string, now: number): TLive | null {
  if (!isRunning(l, id)) return null;
  const out = structuredClone(l);
  out.run[id].sp = out.run[id].sp.map(([s, e]): Span => [s, e === 0 ? Math.max(s, now) : e]);
  out.at = now;
  return out;
}

/** The minutes a task took this round: its spans and the Pomodoro work done on it, without AFK breaks and Pomodoro breaks,
 *  plus any time carried over from an untick. Spans still running count up to `now`. */
export function spentMin(l: TLive, id: string, now: number, away: Span[]): number {
  return Math.max(0, Math.round(spentMs(l, id, now, away) / 60_000));
}
/** The same in milliseconds (PS 1.77, the island's progress check-ins and task timers, core/islandprogress.ts): the island counts
 *  on from it by itself, so it must not jump by the rounding each time the page sends it. Carried minutes count as whole minutes. */
export function spentMs(l: TLive, id: string, now: number, away: Span[]): number {
  const end = l.end[id] ?? 0;
  const own = afterEnd(l.run[id]?.sp ?? [], end).map(([s, e]): Span => [s, e === 0 ? now : Math.min(e, now)]);
  const pieces = Object.values(l.pomo).filter((p) => p[0] > end && p[0] < now);
  const work = unionSpans([...own, ...pieces.filter((p) => !p[2] && p[3].includes(id)).map((p): Span => [p[0], Math.min(p[1], now)])]);
  const off = [...away, ...pieces.filter((p) => p[2]).map((p): Span => [p[0], p[1]])];
  const ms = spanTotal(work) - overlapMs(work, off);
  const carry = l.carry[id] && l.carry[id][1] > end ? l.carry[id][0] : 0;
  return Math.max(0, ms + carry * 60_000);
}
/** When this round of a task began: its first span since it was last finished (null: never started this round). */
export function roundStart(l: TLive, id: string): number | null {
  const own = afterEnd(l.run[id]?.sp ?? [], l.end[id] ?? 0);
  return own.length ? Math.min(...own.map(([s]) => s)) : null;
}

/** The tick: the round's minutes are worked out, the clock is cleared and the finish is marked. `minutes` null: nothing was timed
 *  (never started), so nothing is recorded. */
export function finishClock(l: TLive, id: string, now: number, away: Span[]): { live: TLive; minutes: number | null; title: string } {
  const timed = (l.run[id]?.sp.length ?? 0) > 0 || Object.values(l.pomo).some((p) => !p[2] && p[3].includes(id) && p[0] > (l.end[id] ?? 0))
    || (!!l.carry[id] && l.carry[id][1] > (l.end[id] ?? 0));
  const title = l.run[id]?.n ?? "";
  if (!timed) return { live: l, minutes: null, title };
  const minutes = spentMin(l, id, now, away);
  const out = structuredClone(l);
  delete out.run[id];
  delete out.carry[id];
  out.end[id] = Math.max(now, out.end[id] ?? 0);
  out.at = now;
  return { live: out, minutes, title };
}
/** Clocks still running on tasks that are already ticked: the tick happened on a device that had not yet seen the clock start (it
 *  recorded nothing), so this device's clock would run on for days and the next tick of a repeating task would count all of it.
 *  "finish": the clock started before the tick, so the round ends at the tick. "stop": it started after the tick (a start on a copy
 *  that did not know yet), so it just stops. */
export function tickedElsewhere(l: TLive, doneAt: (id: string) => number | null): { id: string; at: number; how: "finish" | "stop" }[] {
  const out: { id: string; at: number; how: "finish" | "stop" }[] = [];
  for (const id of runningIds(l)) {
    const at = doneAt(id);
    if (at === null || !Number.isFinite(at) || at <= 0) continue;
    const start = Math.min(...afterEnd(l.run[id].sp, l.end[id]).filter(([, e]) => e === 0).map(([s0]) => s0));
    if (!Number.isFinite(start)) continue;
    out.push({ id, at, how: start < at ? "finish" : "stop" });
  }
  return out;
}
/** An untick soon after a tick: the minutes recorded come back as a carry, added to the next finish. */
export function carryBack(l: TLive, id: string, minutes: number, now: number): TLive {
  const out = structuredClone(l);
  out.carry[id] = [Math.max(0, Math.round(minutes)), now];
  out.at = now;
  return out;
}

/** A Pomodoro run changed from `was` to `next` (core/pomodoro.ts PomoRun, on the device that made the change or saw a phase end).
 *  The phase that ended or paused becomes a piece: start from its id, end when it stopped (its own end when it ran out). */
export function pomoPiece(was: { id: string; phase: string; endsAt: number; left: number | null; wait: boolean } | null,
  next: { id: string; left: number | null } | null, now: number, working: string[]): [string, TPomo] | null {
  if (!was || was.wait || was.left !== null) return null;   // only a phase that was running
  if (next && next.id === was.id && next.left === null) return null;   // still the same phase, still running
  const m = /^[wsl]([0-9a-z]{1,12})$/.exec(was.id);
  const start = m ? parseInt(m[1], 36) : NaN;
  if (!Number.isFinite(start) || start <= 0) return null;
  const end = Math.min(now, was.endsAt > 0 ? was.endsAt : now);
  if (end <= start) return null;
  return [was.id, [start, end, was.phase === "work" ? 0 : 1, was.phase === "work" ? working.slice(0, 20) : []]];
}
export function addPomo(l: TLive, piece: [string, TPomo], now: number): TLive {
  return pruneLive(mergeLive(l, { ...emptyLive(now), pomo: { [piece[0]]: piece[1] } }), now);
}

// ---------- the month records: what each finished task really took ----------
/** One finished task: title, minutes, the estimate it had (0 = none), when it was ticked; x: unticked again (not counted). */
export interface TDone { n: string; m: number; e: number; at: number; x?: 1 }
export interface TMonth { t: "month"; v: 1; mo: string; at: number; r: Record<string, TDone> }
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const TM = { perMonth: 600, keepMonths: 24 };

export function cleanTMonth(v: unknown): TMonth | null {
  const o = (v && typeof v === "object" ? v : null) as Record<string, any> | null;
  if (!o || o.t !== "month" || typeof o.mo !== "string" || !MONTH.test(o.mo)) return null;
  const r: Record<string, TDone> = {};
  for (const [k, x] of Object.entries(o.r && typeof o.r === "object" ? o.r : {})) {
    const d = x as Partial<TDone>;
    if (!d || typeof d !== "object" || !(num(d.m) >= 0) || !(num(d.at) > 0)) continue;
    r[k] = { n: cut(d.n), m: Math.round(d.m!), e: cleanEst(d.e) ?? 0, at: d.at!, ...(d.x ? { x: 1 as const } : {}) };
  }
  return { t: "month", v: 1, mo: o.mo, at: num(o.at) || 0, r };
}
/** Two copies of a month into one: every finish from both, an untick seen on either wins. */
export function mergeTMonth(x: TMonth, y: TMonth): TMonth {
  const a = cleanTMonth(x), b = cleanTMonth(y);
  if (!a || !b) return (a || b || x)!;
  const r: Record<string, TDone> = { ...a.r };
  for (const [k, d] of Object.entries(b.r)) r[k] = !r[k] ? d : { ...r[k], ...(r[k].x || d.x ? { x: 1 as const } : {}) };
  const keys = Object.keys(r).sort((p, q) => r[q].at - r[p].at).slice(0, TM.perMonth);
  return { t: "month", v: 1, mo: a.mo, at: Math.max(a.at, b.at), r: Object.fromEntries(keys.map((k) => [k, r[k]])) };
}
/** The month a finish belongs to, in the person's zone. */
export function monthOf(ts: number, tz: string): string { const w = wall(ts, tz); return `${w.y}-${String(w.mo).padStart(2, "0")}`; }
export const doneKey = (id: string, at: number) => `${id}.${Math.round(at).toString(36)}`;
/** A finish added to its month. */
export function addDone(m: TMonth | null, mo: string, id: string, d: TDone): TMonth {
  const base = m ?? { t: "month" as const, v: 1 as const, mo, at: 0, r: {} };
  return mergeTMonth(base, { t: "month", v: 1, mo, at: d.at, r: { [doneKey(id, d.at)]: d } });
}
/** The newest finish of a task not yet unticked, within the last 12 hours (for an untick): its key and record. */
export function lastDoneOf(months: TMonth[], id: string, now: number): { mo: string; key: string; d: TDone } | null {
  let best: { mo: string; key: string; d: TDone } | null = null;
  for (const m of months) for (const [k, d] of Object.entries(m.r))
    if (k.startsWith(id + ".") && !d.x && now - d.at <= TL.carryMs && d.at <= now + 60_000 && (!best || d.at > best.d.at)) best = { mo: m.mo, key: k, d };
  return best;
}
export function undoDone(m: TMonth, key: string, now: number): TMonth {
  const out = cleanTMonth(m)!;
  if (out.r[key]) out.r[key] = { ...out.r[key], x: 1 };
  out.at = now;
  return out;
}

/** The fixed record id for a person's live record or one month (a valid v4 shaped id made from both, so every device writes the same one). */
export function teRecId(userId: string, what: string): string {
  const str = `ttime|${userId}|${what}`;
  const h = [0x811c9dc5, 0x1b873593, 0xcc9e2d51, 0x85ebca6b];
  for (let i = 0; i < str.length; i++) for (let k = 0; k < 4; k++) { h[k] = Math.imul(h[k] ^ (str.charCodeAt(i) + k * 31), 0x01000193 + 2 * k) >>> 0; h[k] ^= h[(k + 1) % 4] >>> 13; }
  const x = h.map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-8${x.slice(17, 20)}-${x.slice(20, 32)}`;
}

/** Every stored "ttime" record folded: one live record and one per month (several copies, from older builds or two devices, merge). */
export function foldTime(stored: { id: string; data: unknown }[]): { live: TLive; liveIds: string[]; months: Map<string, { rec: TMonth; ids: string[] }> } {
  let live = emptyLive();
  const liveIds: string[] = [];
  const months = new Map<string, { rec: TMonth; ids: string[] }>();
  for (const d of stored) {
    const o = d.data as { t?: unknown } | null;
    if (o?.t === "live") { live = mergeLive(live, cleanLive(o)); liveIds.push(d.id); continue; }
    const m = cleanTMonth(o);
    if (!m) continue;
    const had = months.get(m.mo);
    months.set(m.mo, had ? { rec: mergeTMonth(had.rec, m), ids: [...had.ids, d.id] } : { rec: m, ids: [d.id] });
  }
  return { live, liveIds, months };
}

// ---------- learning: the same or a very similar name ----------
const STOP = new Set(["a", "an", "the", "to", "for", "of", "on", "in", "at", "my", "and", "with", "about"]);
/** A title's words for matching: lower case, no accents, no punctuation, small words and plural s off. */
export function nameWords(title: string): string[] {
  return String(title || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/).filter((w) => w && !STOP.has(w)).map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}
export const nameKey = (title: string) => nameWords(title).join(" ");
function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = ` ${s} `;
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); }
  return m;
}
/** How alike two titles are, 0 to 1: the same words (in any order) is 1, otherwise the letter pairs they share. */
export function likeness(a: string, b: string): number {
  const ka = nameKey(a), kb = nameKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  const wa = [...new Set(ka.split(" "))].sort().join(" "), wb = [...new Set(kb.split(" "))].sort().join(" ");
  if (wa === wb) return 1;
  const x = bigrams(ka), y = bigrams(kb);
  let both = 0, all = 0;
  for (const [g, n] of x) { both += Math.min(n, y.get(g) ?? 0); all += n; }
  for (const n of y.values()) all += n;
  return all ? (2 * both) / all : 0;
}
/** Very similar: at least this alike, and both names long enough to judge (a short name must match exactly). */
export const LIKE_MIN = 0.82;
export const similar = (a: string, b: string) => {
  const ka = nameKey(a), kb = nameKey(b);
  if (!ka || !kb) return false;
  if (ka.length < 5 || kb.length < 5) return ka === kb;
  return likeness(a, b) >= LIKE_MIN;
};

/** Every finish kept (not unticked), newest first. */
export function allDone(months: Iterable<TMonth>): (TDone & { id: string })[] {
  const out: (TDone & { id: string })[] = [];
  for (const m of months) for (const [k, d] of Object.entries(m.r)) if (!d.x && d.m > 0) out.push({ ...d, id: k.split(".")[0] });
  return out.sort((a, b) => b.at - a.at);
}
/** The past times of tasks with this name (the same task's earlier rounds count too), newest first, at most `n`. Same name first;
 *  only when there is none, the most alike very similar name. */
/** Each title's key, worked out once and kept (titles repeat a lot; PS 1.77 relearns every open task after a finish). */
const keyMemo = new Map<string, string>();
function memoKey(t: string): string {
  let v = keyMemo.get(t);
  if (v === undefined) { if (keyMemo.size > 5000) keyMemo.clear(); v = nameKey(t); keyMemo.set(t, v); }
  return v;
}
export function pastTimes(done: (TDone & { id: string })[], title: string, o: { n?: number; id?: string } = {}): number[] {
  const n = o.n ?? 6, key = nameKey(title);
  if (!key) return [];
  // Runs on every new task (core/actions.ts addTodo, on the main thread) over up to 24 months of finishes: each title's key is
  // worked out once, and each distinct name is compared once (not twice per finish, as before 17 Nov).
  const k = memoKey;
  const exact = done.filter((d) => (o.id && d.id === o.id) || k(d.n) === key);
  if (exact.length) return exact.slice(0, n).map((d) => d.m);
  let best = 0, bestKey = "";
  const seen = new Set<string>();
  for (const d of done) {
    const dk = k(d.n);
    if (!dk || seen.has(dk)) continue;
    seen.add(dk);
    if (!similar(d.n, title)) continue;
    const l = likeness(d.n, title);
    if (l > best) { best = l; bestKey = dk; }
  }
  return bestKey ? done.filter((d) => k(d.n) === bestKey).slice(0, n).map((d) => d.m) : [];
}
/** "Usually takes about": the middle of the past times, rounded (to 5 minutes under 2 hours, then 10, then 15 from 4 hours). Null with none. */
export function usualMin(times: number[]): number | null {
  const l = times.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!l.length) return null;
  const mid = l.length % 2 ? l[(l.length - 1) / 2] : (l[l.length / 2 - 1] + l[l.length / 2]) / 2;
  const step = mid < 120 ? 5 : mid < 240 ? 10 : 15;
  return Math.max(5, Math.round(mid / step) * step);
}
// ---------- learning from how long a task really took (PS 1.77, the developer, 23 Nov 2026) ----------
// "after lets say 5 times of you completing the same task, it will say the expected time on the task which is the most common/
// average time you usually complete that same task. Also ignore abnormalies ... if you tick it in 2 mins then ignore that, pick
// the most accurate data."
//  - quick: a finish under 2 minutes is a quick tick, not real work (left out).
//  - far: a finish more than 3 times the middle of the recent ones, or under a third of it, is far from the rest (left out). A
//    ratio, not the IQR fence: task times spread by ratio (30 to 45 minutes, sometimes an hour), and with only 5 to 10 finishes
//    the quartiles are too shaky (the fence then drops ordinary times or keeps the 5 hour one). Middle x 3 keeps every normal
//    day and drops the 5 hour day of a 30 to 45 minute task; middle / 3 drops a 10 minute rush of a 40 minute task.
//  - Then the newest 20 clean finishes; with at least 5 of them, the expected time is their middle, rounded as usualMin does.
//  - Fewer than 5 clean finishes: no learned time at all.
export const LEARN = { need: 5, keep: 20, look: 60, quickMin: 2, far: 3 } as const;
export interface LeftOut { m: number; why: "quick" | "far" }
export interface Learned { min: number | null; used: number[]; out: LeftOut[] }
const middle = (l: number[]) => { const x = [...l].sort((a, b) => a - b); return x.length % 2 ? x[(x.length - 1) / 2] : (x[x.length / 2 - 1] + x[x.length / 2]) / 2; };
/** The learned time from past finishes (minutes, newest first): what was used, what was left out and why (only the left out ones
 *  among the finishes looked at, newest first, for Edit). */
export function learnFrom(times: number[]): Learned {
  const all = times.filter((x) => Number.isFinite(x) && x > 0).slice(0, LEARN.look);
  const real = all.filter((x) => x >= LEARN.quickMin);
  if (!real.length) return { min: null, used: [], out: all.map((m) => ({ m, why: "quick" as const })) };
  const mid = middle(real.slice(0, LEARN.keep));
  const isFar = (x: number) => x > mid * LEARN.far || x < mid / LEARN.far;
  const used: number[] = [], out: LeftOut[] = [];
  for (const m of all) {
    if (used.length >= LEARN.keep) break;
    if (m < LEARN.quickMin) out.push({ m, why: "quick" });
    else if (isFar(m)) out.push({ m, why: "far" });
    else used.push(m);
  }
  return { min: used.length >= LEARN.need ? usualMin(used) : null, used, out };
}
/** The learned time for a task: its own earlier rounds and tasks with the same (or, with none, a very similar) name. */
export const learnedFor = (done: (TDone & { id: string })[], title: string, id?: string): Learned => learnFrom(pastTimes(done, title, { n: LEARN.look, id }));

/** Whose expected time a task has: "own" (picked or typed, or No time set picked: PS never touches it), "learned" (PS's, from real
 *  times), or "none" yet (PS may learn one). */
export function estOwner(t: Pick<Todo, "est" | "estBy">): "own" | "learned" | "none" {
  if (t.estBy === "off") return "own";
  if (t.estBy === "past") return cleanEst(t.est) ? "learned" : "none";
  return cleanEst(t.est) ? "own" : "none";
}
/** The changes that bring each open task's learned time up to date: a new or changed learned time, or a learned time taken off
 *  (fewer than 5 clean finishes, including old ones learned from a single time before 1.77). Own times are never touched. */
export function relearn(tasks: { id: string; data: Pick<Todo, "title" | "est" | "estBy" | "done" | "example"> }[], done: (TDone & { id: string })[]): { id: string; est: number | null; estBy: "past" | null }[] {
  const out: { id: string; est: number | null; estBy: "past" | null }[] = [];
  for (const { id, data: t } of tasks) {
    if (t.done || t.example || estOwner(t) === "own") continue;
    const m = learnedFor(done, t.title, id).min;
    const had = t.estBy === "past" ? cleanEst(t.est) : null;
    if (m === had) continue;
    out.push(m ? { id, est: m, estBy: "past" } : { id, est: null, estBy: null });
  }
  return out;
}

/** "2 min (too quick), 5 h (far from the rest)". */
export const outWords = (l: LeftOut[]) => l.map((o) => `${estLabel(o.m)} (${o.why === "quick" ? TE_WORDS.quick : TE_WORDS.far})`).join(", ");
/** "35, 50, 40 min" (newest first), or "1 h 10 min, 50 min" when any is an hour or more. */
export function pastWords(times: number[]): string {
  if (!times.length) return "";
  return times.some((m) => m >= 60) ? times.map(estLabel).join(", ") : `${times.join(", ")} min`;
}

// ---------- free time today and the overload line ----------
/** The working hours that hold `now`, or the next ones that start today, in the person's zone: [start, end] and the day they
 *  started on ("YYYY-MM-DD"). Hours past midnight (22:00 to 06:00) at 02:00 are last night's. Equal hours: the whole day. */
export function workWindow(now: number, p: Pick<TePrefs, "from" | "to">, tz: string): { s: number; e: number; day: string } {
  const a = mins(p.from), b = mins(p.to);
  const at = (dayOffset: number, m: number) => { const w = wall(now, tz); const d = new Date(Date.UTC(w.y, w.mo - 1, w.d + dayOffset)); return zonedToTs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), Math.floor(m / 60), m % 60, tz); };
  const dayAt = (dayOffset: number) => { const w = wall(now, tz); const d = new Date(Date.UTC(w.y, w.mo - 1, w.d + dayOffset)); return d.toISOString().slice(0, 10); };
  const len = (b - a + 1440) % 1440 || 1440;
  const yS = at(-1, a), yE = yS + len * 60_000;
  if (b <= a && now < yE && now >= yS) return { s: yS, e: yE, day: dayAt(-1) };
  const s = at(0, a);
  return { s, e: s + len * 60_000, day: dayAt(0) };
}
/** Free minutes left in the working hours: from now (or their start) to their end, less the meetings in that time (overlapping
 *  meetings count once, all day events never). */
export function freeMin(win: { s: number; e: number }, now: number, busy: { start: number; end: number; allDay?: boolean }[]): number {
  const from = Math.max(win.s, now);
  if (from >= win.e) return 0;
  const taken = unionSpans(busy.filter((b) => !b.allDay).map((b): Span => [Math.max(b.start, from), Math.min(b.end, win.e)]));
  return Math.max(0, Math.round(((win.e - from) - spanTotal(taken)) / 60_000));
}
/** The estimates still to do today: open tasks on today's list with an estimate, less the time already spent on the ones running. */
export function plannedMin(tasks: { id: string; est?: number | null; done?: boolean }[], spent: (id: string) => number = () => 0): number {
  let n = 0;
  for (const t of tasks) { const e = cleanEst(t.est); if (!t.done && e) n += Math.max(0, e - spent(t.id)); }
  return n;
}
/** Too much: at least 15 minutes more planned than free. */
export const OVER_MIN = 15;
/** The overload line: shown while today has more planned than free, the working hours are not over, and it was not already
 *  closed, acted on or gone by itself today (`seenDay`, synced). Null: no line. */
export function overloadLine(f: { on: boolean; planned: number; free: number; now: number; win: { s: number; e: number; day: string }; seenDay?: string | null }): { text: string; day: string } | null {
  if (!f.on || f.now >= f.win.e || f.seenDay === f.win.day) return null;
  if (f.planned - f.free < OVER_MIN || f.planned <= 0) return null;
  return { text: TE_WORDS.overload(f.planned, f.free), day: f.win.day };
}

/** Today's tasks for the plan: open, not due on a later day. (The list's own rule picks the repeating ones that are due.) */
export function todayTasks(list: Doc<Todo>[], today: string): Doc<Todo>[] {
  return list.filter((d) => !d.data.done && !(typeof d.data.due === "string" && d.data.due.slice(0, 10) > today));
}
