// The Clients workspace (PS 1.73, the developer 21 Nov 2026), its pure rules: no React, no DOM, no clock of its own, so
// tests/clientwork.test.ts checks every one. The screen is src/clients/, the saves are core/clientsact.ts.
//
// The developer's scheduling rules (spec: ps-handover-notes/clients-designs.md, 'Task scheduling'):
//  1. Two kinds of client task, and both land in the normal to-do list by themselves: repeating on the weekdays he picks
//     (type "daily" with a weekly rule on `repeat.days`, as core/repeat.ts already reads it), and one day tasks (type "once"
//     with `doOn`). One record per task, shown or kept out of sight: a task can never land twice and is never added or
//     deleted by hand. A repeating one unticks itself at the Reset for its next lit day, as every repeating task does.
//  2. Priority 1 or not: `Todo.p1`. Where it lands is worked out, never saved (sectionOf).
//  3. The day boundary is the person's day end (the countdown's 'Day ends', core/daycount.ts), never midnight. The developer's day
//     ends at 12:00 GST, so 12:00 Tue to 12:00 Wed is his Tuesday and Wednesday's tasks land at 12:00 Wednesday.
//     The countdown off: Settings 'Your work day ends at' (settings.dayEndsHour, core/daylog.ts workDayOf).
//     The same day applies to every repeating task with a rule in the to-do list (Gym on Mon Tue Thu Sat too).
//  4. A deadline and a separate do date: `deadline` (the day it is due, maybe a Google Calendar call) and `doOn` (the
//     day it lands, the deadline day unless he picks another, never after it). Moving the deadline keeps the gap.
// Nothing here reads or sends anything about 1Password or Signal.
import type { Stage, Todo } from "./model";
import { prevEnd, nextEnd, okHm, type CdPrefs } from "./daycount.ts";
import { cleanRepeat, isDueNow, isISO, nextAfter, plusDays, ruleDays, type Repeat } from "./repeat.ts";
import { waitsForDay } from "./scheduled.ts";

// ---------- the day ----------

/** How the person's day is cut. `on`: the countdown is on (then `prefs` and `tz` cut it, core/daycount.ts endsAround);
 *  off: `dayEndsHour` in this device's own time, the Reset's 'Your work day ends at'. */
export interface DayRule { on: boolean; prefs: Pick<CdPrefs, "mode" | "at" | "days">; tz: string; dayEndsHour: number }

/** A day that starts at or after this hour is named after the next date (a 23:00 day end: the day that starts Monday
 *  23:00 is Tuesday). Earlier starts keep the date they start on, as core/daylog.ts workDayOf names them: the developer's noon. */
export const LATE_START_HOUR = 18;

const pad = (n: number) => String(n).padStart(2, "0");
const localIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function wallIn(ts: number, tz: string): { iso: string; h: number } {
  let f: Intl.DateTimeFormat;
  try { f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }); }
  catch { f = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }); }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(ts)) if (p.type !== "literal") o[p.type] = p.value;
  return { iso: `${o.year}-${o.month}-${o.day}`, h: +o.hour % 24 };
}
/** The countdown cuts days only when it has an end time at all (a week with every day blank has none). */
const cdCuts = (r: DayRule) => r.on && (r.prefs.mode === "week" ? r.prefs.days.some(okHm) : okHm(r.prefs.at));

/** When the person's current day started (the last day end at or before `now`). */
export function dayStartAt(now: number, r: DayRule): number {
  if (cdCuts(r)) { const p = prevEnd(r.prefs, r.tz, now); if (p !== null) return p; }
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  d.setHours(r.dayEndsHour);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}
/** When the person's current day ends (the next day end after `now`): the moment the next day's tasks land. */
export function dayEndAt(now: number, r: DayRule): number {
  if (cdCuts(r)) { const n = nextEnd(r.prefs, r.tz, now); if (n !== null) return n; }
  const d = new Date(dayStartAt(now, r));
  d.setDate(d.getDate() + 1);
  return d.getTime();
}
/** The name of the day that starts at `start` ("YYYY-MM-DD"). */
function nameOf(start: number, r: DayRule): string {
  if (cdCuts(r)) { const w = wallIn(start, r.tz); return w.h >= LATE_START_HOUR ? plusDays(w.iso, 1) : w.iso; }
  const d = new Date(start);
  return d.getHours() >= LATE_START_HOUR ? plusDays(localIso(d), 1) : localIso(d);
}
/** Which day it is for the person at `now`: the day client tasks land on. The developer at 02:10 Wednesday: Tuesday. */
export function landDayAt(now: number, r: DayRule): string { return nameOf(dayStartAt(now, r), r); }

// ---------- landing ----------

/** A task that waits for its do date (a one day client task before its day), or (PS 1.75, core/scheduled.ts, while the
 *  "scheduled-tasks" switch is on) a one-off scheduled for a later day. Everything else shows as before. */
export function waitsToLand(t: Pick<Todo, "type" | "done"> & { doOn?: string | null; due?: string | null }, day: string): boolean {
  if (t.type === "once" && !t.done && isISO(t.doOn) && t.doOn > day) return true;
  return waitsForDay(t, day);
}
/** The day a waiting task lands on (its do date, or its scheduled day), else null. */
export function landsOn(t: Pick<Todo, "type" | "done"> & { doOn?: string | null; due?: string | null }, day: string): string | null {
  if (!waitsToLand(t, day)) return null;
  return isISO(t.doOn) ? t.doOn : (t.due ?? null);
}
/** Is the task in the to-do list on `day`? One day tasks from their do date until ticked and Reset; repeating ones on their
 *  lit days (core/repeat.ts isDueNow, read on the person's day). */
export function landed(t: Todo, day: string): boolean {
  if (t.clearedAt || t.aiInbox === true) return false;
  if (t.type === "daily") return isDueNow(t, day);
  return !waitsToLand(t, day);
}

export type Section = "p1" | "daily" | "prio";
export const SECTION_WORDS: Record<Section, string> = { p1: "Priority 1", daily: "Every day", prio: "Priorities" };
/** Where a task lands: Priority 1 when it is P1 (a repeating task too), else repeating in Every day, else Priorities. */
export function sectionOf(t: Pick<Todo, "p1" | "type">): Section {
  return t.p1 === true ? "p1" : t.type === "daily" ? "daily" : "prio";
}

// ---------- weekday repeats ----------

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
/** The chips M T W T F S S, Monday first, with the day number each one stands for (0 Sunday). */
export const CHIPS: { d: number; label: string; name: string }[] = [
  { d: 1, label: "M", name: "Mon" }, { d: 2, label: "T", name: "Tue" }, { d: 3, label: "W", name: "Wed" }, { d: 4, label: "T", name: "Thu" },
  { d: 5, label: "F", name: "Fri" }, { d: 6, label: "S", name: "Sat" }, { d: 0, label: "S", name: "Sun" },
];
export const dowOf = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

/** The rule for these weekdays: every day is no rule at all (so an older PS reads it right too); otherwise a weekly rule on
 *  those days starting on the first lit day from `from`. */
export function repeatFor(days: number[], from: string): Repeat | null {
  const set = [...new Set(days.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
  if (!set.length || set.length === 7) return null;
  return cleanRepeat({ every: 1, unit: "week", from, days: set }, from);
}
/** The lit chips of a task: its rule's days, every day without a rule, the weekday of a plain weekly rule. */
export function daysOf(t: Pick<Todo, "type" | "repeat">): number[] {
  if (t.type !== "daily" || !t.repeat) return [...ALL_DAYS];
  const d = ruleDays(t.repeat);
  if (d) return [...d];
  if (t.repeat.unit === "week" && t.repeat.every === 1) return [dowOf(t.repeat.from)];
  if (t.repeat.unit === "day" && t.repeat.every === 1) return [...ALL_DAYS];
  return [];
}
/** Click one chip: the next set of days. At least one day stays lit. */
export function toggleDay(days: number[], d: number): number[] {
  const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
  return next.length ? [...new Set(next)].sort() : days;
}
/** The save for a repeating task on `days`, from the person's day `day`: its rule and the first lit day it is waiting on. */
export function repeatPatch(days: number[], day: string): Pick<Todo, "type" | "repeat" | "due"> {
  const r = repeatFor(days, day);
  if (!r) return { type: "daily", repeat: null, due: null };
  const due = days.includes(dowOf(day)) ? day : nextAfter(r, day);
  return { type: "daily", repeat: r, due };
}
/** "Every day", "Weekdays", "Weekends", "Mon Thu". */
export function daysWords(days: number[]): string {
  const k = [...new Set(days)].sort().join("");
  if (k === "0123456") return "Every day";
  if (k === "12345") return "Weekdays";
  if (k === "06") return "Weekends";
  return CHIPS.filter((c) => days.includes(c.d)).map((c) => c.name).join(" ");
}

// ---------- the do date and the deadline ----------

export interface Deadline {
  date: string;                 // YYYY-MM-DD
  time?: string | null;         // "15:00"
  eventId?: string | null;      // a Google Calendar call: the deadline follows it when it moves
  title?: string | null;        // the call's name
  gone?: boolean;               // the call was cancelled in the calendar
}
/** Days between the do date and the deadline (0 = the deadline day). */
export function gapOf(t: { doOn?: string | null; deadline?: Deadline | null }): number {
  if (!t.deadline || !isISO(t.deadline.date) || !isISO(t.doOn)) return 0;
  return Math.max(0, Math.round((Date.parse(t.deadline.date) - Date.parse(t.doOn)) / 86_400_000));
}
/** The do date `gap` days before the deadline. */
export const doOnFor = (deadline: string, gap: number) => plusDays(deadline, -Math.max(0, Math.round(gap)));
/** A do date he picked, kept on or before the deadline. */
export function clampDoOn(doOn: string, deadline: string): string { return doOn > deadline ? deadline : doOn; }
/** Moving the deadline (by hand, or the call moved in the calendar): the do date keeps its gap. */
export function moveDeadline(t: { doOn?: string | null; deadline?: Deadline | null }, next: Deadline): { deadline: Deadline; doOn: string } {
  return { deadline: next, doOn: doOnFor(next.date, gapOf(t)) };
}
/** A deadline that is a calendar call, against the events PS can see: the save when the call moved or was cancelled, else
 *  null. `seen`: the calendar covers the call's day (a call outside what was fetched is never called cancelled). */
export function followCall(t: { doOn?: string | null; deadline?: Deadline | null; done?: boolean },
  ev: { start: string; title?: string | null } | null, seen: boolean): { deadline: Deadline; doOn?: string } | null {
  const dl = t.deadline;
  if (!dl?.eventId || t.done) return null;
  if (!ev) return seen && !dl.gone ? { deadline: { ...dl, gone: true } } : null;
  const d = new Date(ev.start);
  if (!Number.isFinite(d.getTime())) return null;
  const date = localIso(d), time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (date === dl.date && time === (dl.time ?? null) && !dl.gone) return null;
  if (date === dl.date && !dl.gone) return { deadline: { ...dl, time } };
  return moveDeadline(t, { ...dl, date, time, gone: false });
}

// ---------- words ----------

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WDL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Tue 24 Nov". */
export function dayWords(iso: string): string {
  if (!isISO(iso)) return "";
  const [, m, d] = iso.split("-").map(Number);
  return `${WD[dowOf(iso)]} ${d} ${MO[m - 1]}`;
}
export const weekdayName = (iso: string) => (isISO(iso) ? WDL[dowOf(iso)] : "");
/** "the deadline day", "the day before the deadline", "3 days before the deadline". */
export function gapWords(gap: number): string {
  return gap <= 0 ? "the deadline day" : gap === 1 ? "the day before the deadline" : `${gap} days before the deadline`;
}
/** "Deadline: Thu 26 Nov 15:00" or "Deadline: call Sat 28 Nov 15:00". */
export function deadlineWords(dl: Deadline): string {
  return `Deadline: ${dl.eventId ? "call " : ""}${dayWords(dl.date)}${dl.time ? ` ${dl.time}` : ""}`;
}
/** The to-do list's pill on the day itself: 'Call today 15:00' or 'Deadline today'; else the deadline words. */
export function deadlinePill(dl: Deadline, day: string): string {
  if (dl.gone) return "Call cancelled";
  if (dl.date === day) return dl.eventId ? `Call today${dl.time ? ` ${dl.time}` : ""}` : "Deadline today";
  return deadlineWords(dl);
}
type TaskLike = Pick<Todo, "type" | "repeat" | "p1" | "done" | "due"> & { doOn?: string | null; deadline?: Deadline | null };
/** The grey line under a task: "Weekdays, in Every day" or "In Priorities on Fri 27 Nov, the day before the deadline". */
export function landWords(t: TaskLike): string {
  const sec = SECTION_WORDS[sectionOf(t)];
  if (t.type === "daily") return `${daysWords(daysOf(t))}, in ${sec}`;
  if (!isISO(t.doOn)) return `In ${sec}`;
  const base = `In ${sec} on ${dayWords(t.doOn)}`;
  return t.deadline ? `${base}, ${gapWords(gapOf(t))}` : base;
}
/** The purple line in the task box: exactly when it comes in. `endHm`: the day end ("12:00"). `day`: the person's day now. */
export function comesInWords(t: TaskLike, day: string, endHm: string): string {
  const sec = `In ${SECTION_WORDS[sectionOf(t)]}.`;
  if (t.type === "daily") {
    const dd = daysOf(t);
    return `Comes into your list by itself on ${daysWords(dd) === "Every day" ? "every day" : daysWords(dd)}, at ${endHm} when the day before ends. ${sec}`;
  }
  if (!isISO(t.doOn) || t.doOn <= day) return `It is in your list today, ${dayWords(day)}. ${sec}`;
  const before = plusDays(t.doOn, -1);
  const tail = t.deadline ? ` That is ${gapWords(gapOf(t))}.` : "";
  return `Comes into your list by itself at ${endHm} on ${dayWords(endDate(t.doOn, endHm))}, when your ${weekdayName(before)} ends. ${sec}${tail}`;
}
/** The calendar date the day before `doOn` ends on: the same date for a day end after noon starts (the developer's 12:00 lands
 *  Wednesday's tasks at 12:00 Wednesday), the date before for an evening day end. */
function endDate(doOn: string, endHm: string): string {
  const h = okHm(endHm) ? Number(endHm.slice(0, 2)) : 0;
  return h >= LATE_START_HOUR ? plusDays(doOn, -1) : doOn;
}
/** "Your day: Tue 24 Nov, ends Wed 12:00". */
export function yourDayWords(day: string, endTs: number, endHm: string): string {
  const d = new Date(endTs);
  return `Your day: ${dayWords(day)}, ends ${WD[d.getDay()]} ${endHm}`;
}

// ---------- the to-do list ----------

/** A client task (made in Clients: it carries the client). */
export const isClientTask = (t: Pick<Todo, "clientId">) => typeof t.clientId === "string" && !!t.clientId;

/** Every client task of one project, in the order shown in Clients (open first, then by order). */
export function projectTasks<T extends { id: string; data: Todo }>(list: T[], projectId: string): T[] {
  return list.filter((d) => d.data.projectId === projectId && !d.data.clearedAt && isClientTask(d.data))
    .sort((a, b) => Number(!!a.data.done) - Number(!!b.data.done) || (a.data.order ?? 0) - (b.data.order ?? 0));
}

/**
 * The hook for the due today nag (PS 1.73, p1-alarms-173: 3 hours before the day end, a 15 minute Annoying reminder): the client
 * tasks that are in the list on `day` and still open, each with why. A one day task is due today when its do date or its
 * deadline is today (or a do date already past and still open); a repeating one when today is one of its lit days.
 */
export interface DueToday<T> { doc: T; why: "do" | "deadline" | "repeat" | "late" }
export function clientDueToday<T extends { id: string; data: Todo }>(list: T[], day: string): DueToday<T>[] {
  const out: DueToday<T>[] = [];
  for (const d of list) {
    const t = d.data as Todo & { doOn?: string | null; deadline?: Deadline | null };
    if (!isClientTask(t) || t.done || !landed(t, day)) continue;
    if (t.type === "daily") { if (daysOf(t).includes(dowOf(day)) && (!t.due || t.due <= day)) out.push({ doc: d, why: "repeat" }); continue; }
    if (t.deadline?.date === day) out.push({ doc: d, why: "deadline" });
    else if (t.doOn === day) out.push({ doc: d, why: "do" });
    else if (isISO(t.doOn) && t.doOn < day) out.push({ doc: d, why: "late" });
  }
  return out;
}

// ---------- the stage line ----------

// PS 1.77 (the developer, 23 Nov 2026): a new project starts with no stages (the Kickoff, Build, Launch starter is gone); a template
// still lays out its own (layStages).
/** How many days a stage spans (both ends counted); 1 without dates. */
export function stageDays(s: Pick<Stage, "start" | "due">): number {
  if (!isISO(s.start) || !isISO(s.due)) return 1;
  return Math.max(1, Math.round((Date.parse(s.due) - Date.parse(s.start)) / 86_400_000) + 1);
}
/** Stages laid out one after another from `from`, each `days` long. */
export function layStages(list: { key?: string; name: string; days: number }[], from: string, key: () => string): Stage[] {
  let at = from;
  return list.map((s) => {
    const days = Math.max(1, Math.round(s.days) || 1);
    const st: Stage = { key: s.key || key(), name: s.name, start: at, due: plusDays(at, days - 1), doneAt: null, previews: [] };
    at = plusDays(at, days);
    return st;
  });
}
/** Each stage's share of the line (0 to 1, they add up to 1), short ones raised to `min` so their names stay readable. */
export function stageWidths(stages: Pick<Stage, "start" | "due">[], min = 0.08): number[] {
  if (!stages.length) return [];
  const days = stages.map(stageDays), total = days.reduce((a, b) => a + b, 0);
  const lo = Math.min(min, 1 / stages.length);
  let w = days.map((d) => d / total);
  for (let pass = 0; pass < 3; pass++) {
    const small = w.map((x) => x < lo), fixed = small.filter(Boolean).length * lo;
    const restSum = w.reduce((a, x, i) => a + (small[i] ? 0 : x), 0);
    w = w.map((x, i) => (small[i] ? lo : restSum > 0 ? (x / restSum) * (1 - fixed) : (1 - fixed) / (w.length - small.filter(Boolean).length)));
  }
  return w;
}
/** Where each stage edge sits on the line (0 to 1): edges[k] is the left edge of stage k, edges[n] = 1. */
export function stageEdges(widths: number[]): number[] {
  const out = [0];
  for (const w of widths) out.push(out[out.length - 1] + w);
  out[out.length - 1] = 1;
  return out;
}
/** The handle let go at `x` (0 to 1): the nearest stage edge, which is how many stages are done. */
export function snapEdge(edges: number[], x: number): number {
  let best = 0;
  for (let k = 1; k < edges.length; k++) if (Math.abs(edges[k] - x) < Math.abs(edges[best] - x)) best = k;
  return best;
}
/** Share of the project's days in finished stages, 0 to 100. */
export function percentDone(stages: Pick<Stage, "start" | "due">[], done: number): number {
  if (!stages.length) return 0;
  const days = stages.map(stageDays), total = days.reduce((a, b) => a + b, 0);
  const k = Math.max(0, Math.min(done, stages.length));
  return Math.round((days.slice(0, k).reduce((a, b) => a + b, 0) / total) * 100);
}
/** The handle on edge `k`: the stages before it done (keeping when they were done), the rest open, `current` = k. */
export function setDone<S extends Stage>(stages: S[], k: number, today: string): { stages: S[]; current: number } {
  const n = Math.max(0, Math.min(k, stages.length));
  return { stages: stages.map((s, i) => ({ ...s, doneAt: i < n ? s.doneAt || today : null })), current: n };
}
/** + at the end: a stage of three days starting the day after the last one ends (today with no stages). */
export function addStage(stages: Stage[], name: string, today: string, key: () => string): Stage[] {
  const last = stages[stages.length - 1];
  const from = last && isISO(last.due) ? plusDays(last.due, 1) : today;
  return [...stages, { key: key(), name, start: from, due: plusDays(from, 2), doneAt: null, previews: [] }];
}
/** Move stage `from` to place `to`: the dates follow the new order, laid out again from the first stage's start, each
 *  stage keeping its length. How many are done stays the same. */
export function moveStage<S extends Stage>(stages: S[], from: number, to: number, current: number): { stages: S[]; current: number } {
  if (from === to || from < 0 || from >= stages.length) return { stages, current };
  const list = [...stages];
  const [m] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(to, list.length)), 0, m);
  const start = stages.find((s) => isISO(s.start))?.start;
  if (start) {
    let at = start;
    for (let i = 0; i < list.length; i++) { const days = stageDays(list[i]); list[i] = { ...list[i], start: at, due: plusDays(at, days - 1) }; at = plusDays(at, days); }
  }
  const done = Math.max(0, Math.min(current, list.length));
  return { stages: list.map((s, i) => ({ ...s, doneAt: i < done ? s.doneAt || stages[i]?.doneAt || null : null })), current: done };
}
/** Remove stage `i`: the stages done before it stay done. */
export function removeStage<S extends Stage>(stages: S[], i: number, current: number): { stages: S[]; current: number } {
  if (i < 0 || i >= stages.length) return { stages, current };
  return { stages: stages.filter((_, j) => j !== i), current: i < current ? current - 1 : Math.min(current, stages.length - 1) };
}
/** 'Stage 2 of 3: Build', 'All stages done', 'No stages yet'. */
export function stageLine(stages: Pick<Stage, "name">[], current: number): string {
  if (!stages.length) return "No stages yet";
  if (current >= stages.length) return "All stages done";
  return `Stage ${current + 1} of ${stages.length}: ${stages[current].name}`;
}

// ---------- templates (kind "ptpl", owner private) ----------

export interface TplTask { title: string; p1?: boolean; days?: number[]; doDay?: number; deadlineDay?: number }
export interface ProjectTpl { name: string; stages: { name: string; days: number }[]; checklist: string[]; tasks: TplTask[]; createdAt: string }
export const TPL_MAX = 60;
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Save as template: stage names and lengths, the checklist, and the project's tasks, the client's name as {client} and
 *  dated tasks as 'day N of the project' (day 0 is the first stage's start). */
export function templateOf(o: { name: string; client: string; stages: Stage[]; checklist: { text: string }[];
  tasks: (Pick<Todo, "title" | "type" | "repeat" | "p1"> & { doOn?: string | null; deadline?: Deadline | null })[]; at: string; today: string }): ProjectTpl {
  const anon = (s: string) => (o.client.trim() ? s.replace(new RegExp(reEscape(o.client.trim()), "gi"), "{client}") : s);
  const start = o.stages.find((s) => isISO(s.start))?.start ?? o.today;
  const dayNo = (iso: string) => Math.round((Date.parse(iso) - Date.parse(start)) / 86_400_000);
  return {
    name: o.name.trim().slice(0, 80) || "Template",
    stages: o.stages.map((s) => ({ name: s.name, days: stageDays(s) })),
    checklist: o.checklist.map((c) => c.text).filter(Boolean).slice(0, 200),
    tasks: o.tasks.slice(0, 200).map((t) => {
      const base: TplTask = { title: anon(t.title), ...(t.p1 ? { p1: true } : {}) };
      if (t.type === "daily") return { ...base, days: daysOf(t) };
      if (t.deadline && isISO(t.deadline.date)) return { ...base, deadlineDay: dayNo(t.deadline.date), doDay: isISO(t.doOn) ? dayNo(t.doOn) : dayNo(t.deadline.date) };
      return isISO(t.doOn) ? { ...base, doDay: dayNo(t.doOn) } : base;
    }),
    createdAt: o.at,
  };
}
/** A clean template from anywhere (a newer build's fields are dropped from the copy, never from the record). */
export function cleanTpl(v: unknown): ProjectTpl | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const str = (x: unknown, n: number) => (typeof x === "string" ? x.slice(0, n) : "");
  const int = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x) : undefined);
  const stages = Array.isArray(o.stages) ? o.stages.flatMap((s) => (s && typeof s === "object" && str((s as Obj).name, 80) ? [{ name: str((s as Obj).name, 80), days: Math.max(1, int((s as Obj).days) ?? 1) }] : [])) : [];
  const checklist = Array.isArray(o.checklist) ? o.checklist.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.slice(0, 300)) : [];
  const tasks = Array.isArray(o.tasks) ? o.tasks.flatMap((x): TplTask[] => {
    if (!x || typeof x !== "object") return [];
    const t = x as Obj, title = str(t.title, 300);
    if (!title.trim()) return [];
    const days = Array.isArray(t.days) ? t.days.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 6) : undefined;
    return [{ title, ...(t.p1 === true ? { p1: true } : {}), ...(days?.length ? { days } : {}), ...(int(t.doDay) !== undefined ? { doDay: int(t.doDay) } : {}), ...(int(t.deadlineDay) !== undefined ? { deadlineDay: int(t.deadlineDay) } : {}) }];
  }) : [];
  const name = str(o.name, 80).trim();
  if (!name) return null;
  return { name, stages, checklist, tasks, createdAt: str(o.createdAt, 40) };
}
type Obj = Record<string, unknown>;
/** New project from a template: a copy laid out from `today` (stages, checklist steps, tasks with dates from today),
 *  {client} filled in. The copy is then his to edit; the template never changes. */
export function fromTemplate(tpl: ProjectTpl, client: string, today: string, key: () => string): {
  stages: Stage[]; checklist: { id: string; text: string; done: boolean; at: null }[];
  tasks: (Pick<Todo, "title" | "type" | "repeat" | "due" | "p1"> & { doOn?: string | null; deadline?: Deadline | null })[];
} {
  const fill = (s: string) => s.replace(/\{client\}/g, client);
  const stages = layStages(tpl.stages, today, key);
  const checklist = tpl.checklist.map((text) => ({ id: key(), text: fill(text), done: false, at: null }));
  const tasks = tpl.tasks.map((t) => {
    const base = { title: fill(t.title), ...(t.p1 ? { p1: true } : {}) };
    if (t.days?.length) return { ...base, ...repeatPatch(t.days, today) };
    const doOn = t.doDay !== undefined ? plusDays(today, Math.max(0, t.doDay)) : null;
    if (t.deadlineDay !== undefined) {
      const date = plusDays(today, Math.max(0, t.deadlineDay));
      return { ...base, type: "once" as const, repeat: null, due: null, doOn: doOn ? clampDoOn(doOn, date) : date, deadline: { date } };
    }
    return { ...base, type: "once" as const, repeat: null, due: null, doOn };
  });
  return { stages, checklist, tasks };
}

// ---------- clients ----------

/** The tab colours, given in turn to clients that have none. */
/** PS 1.77: how long an Undo (Archive, Delete) stays on screen; a Delete waits this long before it happens. */
export const undoWindow = 8000;
export const CLIENT_COLOURS = ["#F28B6B", "#7FB7F5", "#8FD19E", "#E7B35A", "#C49BF0", "#F27BA8", "#5FC9C2", "#B8C26A"];
export function colourOf(c: { colour?: string | null }, index: number): string {
  return typeof c.colour === "string" && /^#[0-9a-fA-F]{6}$/.test(c.colour) ? c.colour : CLIENT_COLOURS[((index % CLIENT_COLOURS.length) + CLIENT_COLOURS.length) % CLIENT_COLOURS.length];
}
/** The orders after dragging tab `from` to place `to` (lower is further left). */
export function reorder<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const out = [...list];
  const [m] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, m);
  return out;
}
