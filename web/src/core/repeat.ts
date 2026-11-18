// Repeating tasks and streaks. Pure date maths on "YYYY-MM-DD" strings, so it runs in tests too.
//
// A repeating task has type "daily" (it never leaves the list) plus an optional rule. No rule means
// every day. For anything longer (every other day, every week, month, year) the task's `due` is the
// occurrence it is waiting on and `repeat.from` is the first one, so months never drift (31 Jan,
// 28 Feb, 31 Mar).
//
// Streaks follow the developer's Reset button, not the clock: ticking a repeating task adds one, and a reset
// that finds it due and not done ends the streak. Midnight never touches it, so a 1am tick still
// counts for the day before. A task that is due today is never counted as missed: it gets until the
// reset after today.

export type RepeatUnit = "day" | "week" | "month" | "year";
/** `days` (PS 1.65, typed dates in plain words, core/nldates.ts): a weekly rule on several days of the week, 0 Sunday to
 *  6 Saturday ("every weekday" is [1, 2, 3, 4, 5]). Only with unit "week"; `from` is then the first of those days. A PS
 *  that does not know `days` reads the rule as every week (or every N weeks) on `from`'s day, which is the closest it has. */
export interface Repeat { every: number; unit: RepeatUnit; from: string; days?: number[] }

/** The fields this file reads and writes on a to-do. */
export interface RepeatTask {
  type: "daily" | "once";
  done: boolean;
  doneAt?: string | null;
  due?: string | null;
  repeat?: Repeat | null;
  streak?: number;
  streakTicked?: boolean;    // this round's tick already counted (so untick, tick again stays fair)
  bestStreak?: number;
}

const re = /^\d{4}-\d{2}-\d{2}$/;
export const isISO = (s: unknown): s is string => typeof s === "string" && re.test(s);
const parts = (iso: string) => iso.split("-").map(Number) as [number, number, number];
const fmt = (d: Date) => d.toISOString().slice(0, 10);
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

export function plusDays(iso: string, n: number) {
  const [y, m, d] = parts(iso);
  return fmt(new Date(Date.UTC(y, m - 1, d + n)));
}
/** Add months, keeping the day of the month where it fits (31st becomes the 28th, 30th or 31st). */
export function plusMonths(iso: string, n: number) {
  const [y, m, d] = parts(iso);
  const total = (m - 1) + n, ny = y + Math.floor(total / 12), nm = ((total % 12) + 12) % 12;
  return fmt(new Date(Date.UTC(ny, nm, Math.min(d, daysIn(ny, nm)))));
}
/** The k-th occurrence after `from` (k = 0 is `from` itself). */
export function occurrence(r: Repeat, k: number) {
  const n = k * r.every;
  return r.unit === "day" ? plusDays(r.from, n) : r.unit === "week" ? plusDays(r.from, n * 7)
    : r.unit === "month" ? plusMonths(r.from, n) : plusMonths(r.from, n * 12);
}
const dow = (iso: string) => { const [y, m, d] = parts(iso); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const dayNo = (iso: string) => { const [y, m, d] = parts(iso); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
/** The Monday that starts the week `iso` is in (weeks for "every other week" start on Monday). */
const mondayOf = (iso: string) => plusDays(iso, -((dow(iso) + 6) % 7));
/** A weekly rule on several days: the first of its days strictly after `after`, on a week that counts (every N weeks
 *  from the week of `from`), never before `from`. */
function nextOnDays(r: Repeat, days: number[], after: string) {
  const base = dayNo(mondayOf(r.from));
  let d = after < r.from ? plusDays(r.from, -1) : after;
  for (let i = 0; i < 7 * r.every + 7; i++) {
    d = plusDays(d, 1);
    const wk = Math.floor((dayNo(d) - base) / 7);
    if (days.includes(dow(d)) && wk % r.every === 0) return d;
  }
  return plusDays(after, 1);   // unreachable with a clean rule
}
/** The days of a weekly rule on several days, or null for an ordinary rule. */
export function ruleDays(r: Pick<Repeat, "unit" | "days"> | null | undefined): number[] | null {
  return r && r.unit === "week" && Array.isArray(r.days) && r.days.length ? r.days : null;
}

/** The first occurrence strictly after `after`. */
export function nextAfter(r: Repeat, after: string) {
  const days = ruleDays(r);
  if (days) return nextOnDays(r, days, after);
  // Jump close first, then step: keeps a ten year old "every day" rule fast.
  const [fy, fm] = parts(r.from), [ay, am] = parts(after);
  const spanDays = (Date.UTC(ay, am - 1, parts(after)[2]) - Date.UTC(fy, fm - 1, parts(r.from)[2])) / 86400000;
  const unitDays = r.unit === "day" ? 1 : r.unit === "week" ? 7 : r.unit === "month" ? 28 : 365;
  let k = Math.max(0, Math.floor(spanDays / (unitDays * r.every)) - 2);
  let d = occurrence(r, k);
  while (d <= after) d = occurrence(r, ++k);
  return d;
}

/** Every day is the plain daily task (no rule, or every 1 day). */
export const isEveryDay = (t: RepeatTask) => t.type === "daily" && (!t.repeat || (t.repeat.unit === "day" && t.repeat.every === 1));
export const isRepeating = (t: RepeatTask) => t.type === "daily";

/** Should it show as something to do today? Longer repeats wait out of sight until they are due. */
export function isDueNow(t: RepeatTask, today: string) {
  if (!isRepeating(t) || isEveryDay(t)) return true;
  return !t.due || t.due <= today || t.done;
}

/** "Every day", "Every other day", "Every 3 days", "Every week", "Every 2 weeks", "Every month", "Every year". */
export function repeatLabel(r?: Repeat | null) {
  if (!r || (r.unit === "day" && r.every === 1)) return "Every day";
  const days = ruleDays(r);
  if (days) return daysLabel(days, r.every);
  if (r.every === 1) return `Every ${r.unit}`;
  if (r.every === 2 && r.unit === "day") return "Every other day";
  return `Every ${r.every} ${r.unit}s`;
}

const WD3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Every weekday", "Every weekend", "Every Mon and Thu", "Every other week: Mon, Wed and Fri", "Every 3 weeks: Tue". */
export function daysLabel(days: number[], every = 1) {
  const key = [...days].sort().join("");
  const head = every === 1 ? "Every" : every === 2 ? "Every other week:" : `Every ${every} weeks:`;
  if (key === "12345") return every === 1 ? "Every weekday" : `${head} weekdays`;
  if (key === "06") return every === 1 ? "Every weekend" : `${head} weekends`;
  const names = [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => WD3[d]);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return `${head} ${list}`;
}
/** Clean days of the week: whole numbers 0 to 6, each once, in order. Null when none are left. */
export function cleanDays(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out = [...new Set(v.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6) as number[])].sort();
  return out.length ? out : null;
}

/** Clean a rule from anywhere (the Tab list, a package). Null means every day. */
export function cleanRepeat(r: unknown, fallbackFrom: string): Repeat | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const unit = (["day", "week", "month", "year"] as const).find((u) => u === o.unit);
  const every = Math.round(Number(o.every));
  if (!unit || !Number.isFinite(every) || every < 1 || every > 365) return null;
  if (unit === "day" && every === 1) return null;
  const from = isISO(o.from) ? o.from : fallbackFrom;
  const days = unit === "week" ? cleanDays(o.days) : null;
  // One day only is an ordinary weekly rule, kept on that day; several days start on the first of them from `from`.
  if (days && days.length === 1) return { every, unit, from: dow(from) === days[0] ? from : nextOnDays({ every, unit, from }, days, plusDays(from, -1)) };
  if (days) { const first = days.includes(dow(from)) ? from : nextOnDays({ every, unit, from }, days, plusDays(from, -1)); return { every, unit, from: first, days }; }
  return { every, unit, from };
}

/** The changes to make when the task is ticked or unticked. */
export function tickPatch(t: RepeatTask, at: string): Partial<RepeatTask> {
  const done = !t.done;
  const base: Partial<RepeatTask> = { done, doneAt: done ? at : null };
  if (!isRepeating(t)) return base;
  const streak = t.streak || 0;
  if (done && !t.streakTicked) {
    const next = streak + 1;
    return { ...base, streak: next, streakTicked: true, bestStreak: Math.max(t.bestStreak || 0, next) };
  }
  if (!done && t.streakTicked) return { ...base, streak: Math.max(0, streak - 1), streakTicked: false };
  return base;
}

/**
 * What the Reset button does to a repeating task, or null to leave it alone.
 * Done: untick it, keep the streak, and move a longer repeat on to its next date.
 * Not done and missed: the streak ends (an every day task is missed whenever it is not done;
 * a longer one only once its date is before today). It stays on the list either way.
 */
export function resetPatch(t: RepeatTask, today: string): Partial<RepeatTask> | null {
  if (!isRepeating(t)) return null;
  const every = isEveryDay(t);
  if (t.done) {
    const p: Partial<RepeatTask> = { done: false, doneAt: null, streakTicked: false };
    if (!every && t.repeat) p.due = nextAfter(t.repeat, today);
    return p;
  }
  const missed = every || (!!t.due && t.due < today);
  if (missed && ((t.streak || 0) > 0 || t.streakTicked)) return { streak: 0, streakTicked: false };
  return null;
}

/** Does this Reset end the task's round (PS 1.68, for its mini tasks' streaks, core/subtasks.ts resetSubs)? Done, or
 *  missed (an every day task not done, a longer one whose date is before today). A longer repeat not due yet: no. */
export function roundOver(t: RepeatTask, today: string): boolean {
  if (!isRepeating(t)) return false;
  return t.done || isEveryDay(t) || (!!t.due && t.due < today);
}

/** The feature switch for the streak badges (features.json, Settings, Your list). */
export const STREAK_FEATURE = "task-streaks";

/** The streak's hover words (PS 1.68, feature "task-streaks"): "7 days in a row", "3 weeks in a row", "4 times in a
 *  row" for the other rules (every other day, weekdays, chosen days), plus the best when it is higher. */
export function streakWords(n: number, r?: Repeat | null, best?: number): string {
  const k = Math.max(0, Math.round(n || 0));
  const unit = !r || (r.unit === "day" && r.every === 1) ? "day" : r.every === 1 && !ruleDays(r) && r.unit !== "day" ? r.unit : "time";
  const head = `${k} ${unit}${k === 1 ? "" : "s"} in a row`;
  const b = Math.round(best || 0);
  return b > k ? `${head}. Best: ${b}` : head;
}

// ---------- the editors ----------
export type RepeatKind = "once" | "daily" | "repeat";
export interface RepeatDraft { kind: RepeatKind; every: number; unit: RepeatUnit; from: string }

export function draftOf(t: Partial<RepeatTask> | null, today: string): RepeatDraft {
  if (!t || t.type !== "daily") return { kind: "once", every: 1, unit: "week", from: t?.due || today };
  if (isEveryDay(t as RepeatTask)) return { kind: "daily", every: 1, unit: "week", from: today };
  const r = t.repeat!;
  return { kind: "repeat", every: r.every, unit: r.unit, from: t.due || r.from };
}

/** The type, rule and date to save. One-offs keep the date the editor gives them. */
export function patchOf(d: RepeatDraft, today: string, prev?: Partial<RepeatTask> | null):
  { type: "daily" | "once"; repeat: Repeat | null; due?: string | null } {
  if (d.kind === "once") return { type: "once", repeat: null };
  const r = d.kind === "repeat" ? cleanRepeat({ every: d.every, unit: d.unit, from: isISO(d.from) ? d.from : today }, today) : null;
  if (!r) return { type: "daily", repeat: null, due: null };
  const same = prev?.repeat && prev.repeat.every === r.every && prev.repeat.unit === r.unit && prev.due === r.from;
  if (same) return { type: "daily", repeat: prev!.repeat!, due: prev!.due! };
  // The first date it is due: the start date, or the next one on the schedule if that has passed.
  const due = r.from >= today ? r.from : nextAfter(r, plusDays(today, -1));
  return { type: "daily", repeat: r, due };
}

export const REPEAT_PRESETS: { key: string; label: string; every: number; unit: RepeatUnit }[] = [
  { key: "2-day", label: "Every other day", every: 2, unit: "day" },
  { key: "1-week", label: "Every week", every: 1, unit: "week" },
  { key: "2-week", label: "Every 2 weeks", every: 2, unit: "week" },
  { key: "1-month", label: "Every month", every: 1, unit: "month" },
  { key: "3-month", label: "Every 3 months", every: 3, unit: "month" },
  { key: "1-year", label: "Every year", every: 1, unit: "year" },
];
