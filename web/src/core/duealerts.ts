// PS 1.73: the Annoying reminder for tasks due today, and the Priority 1 alarm (the developer, 21 Nov 2026). Pure: no vault, no clock, no
// storage, so tests/duealerts.test.ts checks every rule.
//
// The developer: "if you have a priority one task that is one hour away from expiring, I want it to ring your phone ... say the task name
// and ... how long it's got left and you have to click I acknowledge", and: "If it's on the day, and you haven't completed a
// task and you've got like three hours left, then I want the annoying 15 minute reminders to keep popping up ... pin me against
// the wall."
//
// Nothing here is a second reminder system. Every item it works out is an ordinary Annoying reminder (core/remind.ts PlanItem)
// or an ordinary alarm ring (AlarmRing), handed to the same shells (ps-mac Reminders.swift, ps-gos Remind.kt and Gym.kt, the
// iPhone web app's card and Web Push) with the same buttons, typed word, snooze, colours and sound. What is new:
//  - which tasks are due (dueTasks): a Priority 1 task by its own 24 hour clock; a task with a due date by the end of that day
//    (the countdown's Day ends, never plain midnight). Client tasks come from the Clients workspace through `extra`
//    (src/duewatch.ts addDueSource "clients");
//  - the nag (dueNagItems): from `hours` before that end until the end, every snooze length until Done (which ticks the task),
//    the task ticked, or the window over;
//  - the P1 alarm (dueP1Items): `lead` minutes before a Priority 1 task is due (its 24 hours or the day end, the sooner), it
//    rings with one button, "I acknowledge", which only works once "yes" is typed (the developer: a click alone must not stop it);
//  - the ids are worked out from the task and its due moment (autoId), so every device makes the same one, and the answers
//    are kept in the reminders record's `auto` (core/remind.ts applyAct), so Done or I acknowledge on one device stops all.
//  - the clock: a Priority 1 task's 24 hours start when it became Priority 1. Shared with a squad that is Todo.p1At (G Squad
//    rules, untouched). For everyone else PS 1.73 keeps its own start, Todo.p1Since (p1OwnStamps), which never leaves the vault.
// Nothing here reads or sends anything about 1Password or Signal.
import { wall, zonedToTs } from "./tz.ts";
import { P1_WINDOW_MS, cleanStart } from "./squadp1.ts";
import {
  ALARM_LATER, ALL_DAYS, DUE_HOURS_DEF, DUE_LEAD_DEF, DUE_NAG_ID, DUE_NAG_PILL, DUE_P1_ID, DUE_P1_TEXT, DUE_P1_TITLE,
  DUE_P1_WORD, DUE_P1_YES, OPEN_WORDS, REM_ACCENT, REM_BG, REM_SNOOZE_DEF, REM_VOL_DEF, cleanReminder, inkFor, laterOf, oneLine, plainOf, wordOf, yesOf,
  type AlarmRing, type DueCfg, type PlanItem, type Reminder, type RemindRec, type RemState,
} from "./remind.ts";

const H = 3_600_000, M = 60_000;
export const DUE_PLAN_MAX = 20;          // nags in the plan at once (today's first, then the overdue ones, newest first)
export const DUE_P1_MAX = 12;
export const DUE_TEXT_MAX = 160;          // the words after {task} and {left} are filled in
export const DUE_OVERDUE_PILL = "Overdue";   // the small label on an overdue task's nag (the list's own word for it)
export const DUE_LOOK_AHEAD_MS = 36 * H;  // a window that starts later than this is not planned yet

export type DueKind = "p1" | "dated" | "client";
export interface DueTask { id: string; title: string; kind: DueKind; dueAt: number; /** a P1: when it became Priority 1 (ms) */ start?: number }
/** What dueTasks needs to know about a task (core/model.ts Todo). */
export interface DueTodo {
  title?: unknown; type?: unknown; done?: unknown; clearedAt?: unknown; example?: unknown; aiInbox?: unknown; due?: unknown;
  p1?: unknown; p1At?: unknown; p1Since?: unknown; clientId?: unknown; repeat?: unknown; doneAt?: unknown; createdAt?: unknown;
}
export interface DueCtx {
  now: number;
  /** The zone the day ends in (src/daycount.ts dayZone). */
  tz: string;
  /** The first day end strictly after a moment (core/daycount.ts nextEnd on the countdown's prefs), null when none is set. */
  dayEndAfter: (t: number) => number | null;
  /** The last day end at or before a moment (core/daycount.ts prevEnd). Without it a day is taken as 24 hours. */
  dayEndAtOrBefore?: (t: number) => number | null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAY = /^\d{4}-\d{2}-\d{2}/;
const dayOf = (ts: number, tz: string) => { const w = wall(ts, tz); return `${w.y}-${pad(w.mo)}-${pad(w.d)}`; };
const hmOf = (ts: number, tz: string) => { const w = wall(ts, tz); return `${pad(w.h)}:${pad(w.mi)}`; };
const floorMin = (t: number) => Math.floor(t / M) * M;
const live = (t: DueTodo) => !t.done && !t.clearedAt && t.example !== true && t.aiInbox !== true;

/** When a dated task is due: the end of that day, the first day end after its date starts (with a noon day end, noon on that
 *  date; with a midnight one, the midnight after it). */
export function dayEndOf(date: string, ctx: Pick<DueCtx, "tz" | "dayEndAfter">): number | null {
  if (!DAY.test(date)) return null;
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return ctx.dayEndAfter(zonedToTs(y, m, d, 0, 0, ctx.tz));
}
/** The start of a Priority 1 task's 24 hours: the squad's clock (p1At) first, else its own (p1Since). */
export function p1Start(t: Pick<DueTodo, "p1At" | "p1Since">, now: number): string | null {
  return cleanStart(t.p1At, now) ?? cleanStart(t.p1Since, now);
}
/** A one off Priority 1 task (a repeating one has no 24 hour clock). */
const isP1 = (t: DueTodo) => t.p1 === true && t.type !== "daily";
/** Every task that is due, with the moment it is due, soonest first. The hook for other sources (the Clients workspace): their
 *  tasks come in `extra` and join the list (a task already here keeps the sooner moment). */
export function dueTasks(todos: { id: string; data: DueTodo }[], ctx: DueCtx, extra: DueTask[] = []): DueTask[] {
  const out = new Map<string, DueTask>();
  const add = (x: DueTask) => { const h = out.get(x.id); if (!h || x.dueAt < h.dueAt) out.set(x.id, x); };
  for (const { id, data: t } of todos) {
    if (!t || !live(t)) continue;
    const title = typeof t.title === "string" ? t.title : "";
    const dated = typeof t.due === "string" && DAY.test(t.due) ? dayEndOf(t.due, ctx) : null;
    if (isP1(t)) {
      // The developer, 21 Nov 2026: every P1 not done is due by the end of the day too, whatever its 24 hours say ("a P1 added 4 hours before
      // the day ends still rings that it's not done"). So the soonest of: its 24 hours, the next day end, the end of its date.
      const s = p1Start(t, ctx.now);
      const clock = s ? Date.parse(s) + P1_WINDOW_MS : null;
      // Only moments still to come: a P1 whose 24 hours already ran out (Missed) still rings before each day end until it is done.
      const at = [clock, ctx.dayEndAfter(ctx.now), dated].filter((x): x is number => x !== null && x > ctx.now).reduce((a, b) => Math.min(a, b), Infinity);
      if (Number.isFinite(at)) add({ id, title, kind: "p1", dueAt: at, ...(s ? { start: Date.parse(s) } : {}) });
      continue;
    }
    // Repeating tasks are never nagged here. Client tasks (repeating ones and the one day ones with Todo.doOn) come only through the
    // Clients hook (addDueSource "clients", src/clients/clientsday.ts clientDueTasks): the developer's day is named after the date it STARTS on
    // (12:00 Tue to 12:00 Wed is his Tuesday), which only Clients works out right (clients-build note, 21 Nov 2026).
    if (t.type === "daily") continue;
    if (dated !== null) add({ id, title, kind: typeof t.clientId === "string" && t.clientId ? "client" : "dated", dueAt: dated });
  }
  for (const x of extra) if (x && typeof x.id === "string" && Number.isFinite(x.dueAt)) add({ ...x, title: String(x.title ?? "") });
  return [...out.values()].sort((a, b) => a.dueAt - b.dueAt || (a.id < b.id ? -1 : 1));
}

// ---------- ids ----------
function hash(s: string): string {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < s.length; i++) { a = Math.imul(a ^ s.charCodeAt(i), 0x01000193) >>> 0; b = (Math.imul(b ^ s.charCodeAt(i), 0x85ebca6b) + a) >>> 0; }
  return (a.toString(36).padStart(7, "0") + b.toString(36).padStart(7, "0")).slice(0, 11);
}
/** The same id on every device for the same task and due moment: a new due date or a fresh P1 clock is a new item (its answers
 *  start again). "n": a nag, "p": a P1 alarm. */
export const autoId = (kind: "n" | "p", taskId: string, dueAt: number) => `${kind}${hash(`${kind}:${taskId}:${Math.floor(dueAt / M)}`)}`;

// ---------- words ----------
/** "1 hour", "2 hours", "1 hour 30 mins", "45 mins", "1 min", "under a minute"; "no time" once it is past (an overdue task). */
export function leftLong(ms: number): string {
  if (ms <= 0) return "no time";
  if (!(ms >= M)) return "under a minute";
  const m = Math.round(ms / M), h = Math.floor(m / 60), r = m % 60;
  const p = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  return h ? (r ? `${p(h, "hour")} ${p(r, "min")}` : p(h, "hour")) : p(r, "min");
}
/** The words with {task} and {left} filled in, one line, at most DUE_TEXT_MAX. Empty words: the task's name. */
export function fillWords(tpl: string, title: string, leftMs: number): string {
  const name = oneLine(title, 400) || "Your task";
  const t = oneLine(tpl, 400);
  const s = t ? t.replace(/\{task\}/gi, name).replace(/\{left\}/gi, leftLong(leftMs)) : name;
  return s.length <= DUE_TEXT_MAX ? s : `${s.slice(0, DUE_TEXT_MAX - 3).trimEnd()}...`;
}

// ---------- the settings ----------
/** The settings when none were saved. The nag looks like your first Annoying reminder (its colours, sound, snooze and its typed
 *  word or one click), so it follows the rules you already set; with none, the task reminder's: Done, one click. Both are on for
 *  the developer's account and off for everyone else until switched on. */
export function dueDefaults(rec: RemindRec | null, red: boolean): DueCfg {
  const first = rec ? plainOf(rec).find((r) => r.on) ?? plainOf(rec)[0] : undefined;
  const base = {
    on: red, label: "", text: "", at: "09:00", until: "21:00", days: [...ALL_DAYS], tz: "", later: "", edited: 0,
  };
  const nag = cleanReminder({
    ...base, id: DUE_NAG_ID, snooze: first?.snooze ?? REM_SNOOZE_DEF, yes: "Done",
    word: first && !first.click ? first.word : "", click: first ? first.click : true,
    bg: first?.bg ?? REM_BG, accent: first?.accent ?? REM_ACCENT, sound: first?.sound === "own" ? "soft" : first?.sound ?? "none", vol: first?.vol ?? REM_VOL_DEF,
  })!;
  const p1 = cleanReminder({ ...base, id: DUE_P1_ID, alarm: true, text: DUE_P1_TEXT, yes: DUE_P1_YES, word: DUE_P1_WORD, bg: "#2a0d0d", accent: "#ef4444", sound: "alarm", vol: 1 })!;
  return { nag, hours: DUE_HOURS_DEF, p1, lead: DUE_LEAD_DEF, edited: 0 };
}
export const dueCfgOf = (rec: RemindRec | null, red: boolean): DueCfg => rec?.due ?? dueDefaults(rec, red);
/** One change to the due settings (the record's other parts stay). Its edited time moves on, so a merge keeps this copy. */
export function patchDue(rec: RemindRec, red: boolean, change: { nag?: Partial<Reminder>; p1?: Partial<Reminder>; hours?: number; lead?: number }, now: number): RemindRec {
  const cur = dueCfgOf(rec, red);
  const nag = cleanReminder({ ...cur.nag, ...(change.nag ?? {}), id: DUE_NAG_ID }) ?? cur.nag;
  const p1 = cleanReminder({ ...cur.p1, ...(change.p1 ?? {}), id: DUE_P1_ID, alarm: true }) ?? cur.p1;
  delete nag.task; delete nag.date; delete nag.alarm;
  const clampN = (v: number | undefined, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.round(Math.max(lo, Math.min(hi, v))) : d);
  const due: DueCfg = { nag, p1, hours: clampN(change.hours, 1, 12, cur.hours), lead: clampN(change.lead, 5, 720, cur.lead), edited: Math.max(now, cur.edited + 1) };
  return { ...rec, due, at: Math.max(now, rec.at) };
}

// ---------- what the shells get ----------
export interface DueOpts {
  /** Tasks that already carry a reminder of their own (Settings, On your tasks): no second nag for them. */
  ownTaskReminders?: ReadonlySet<string>;
}
const stateOf = (rec: RemindRec | null, id: string): RemState | undefined => rec?.auto?.[id];

/** The nags as reminder plan items: one per task due, a once window from `hours` before it is due until it is due.
 *  Overdue (its moment has passed, not done; the developer via the main chat, 21 Nov 2026: "nag them too ... straight away, not waiting for
 *  the 3 hour window"): a window over the whole of the day it is in now (the last day end to the next one), so it comes at once and
 *  every snooze length after, until it is done, snoozed, given a new date, or the day ends (then the next day's window, a new id). */
export function dueNagItems(tasks: DueTask[], rec: RemindRec | null, red: boolean, ctx: Pick<DueCtx, "now" | "tz" | "dayEndAfter" | "dayEndAtOrBefore">, o: DueOpts = {}): PlanItem[] {
  const cfg = dueCfgOf(rec, red), r = cfg.nag;
  if (!r.on) return [];
  const out: PlanItem[] = [];
  const late = (t: DueTask) => t.dueAt <= ctx.now;
  // Today's first (soonest first), then the overdue ones (the most recent first), so old ones never crowd out today's.
  const order = [...tasks.filter((t) => !late(t)), ...tasks.filter(late).sort((a, b) => b.dueAt - a.dueAt)];
  const next = ctx.dayEndAfter(ctx.now);
  for (const t of order) {
    if (out.length >= DUE_PLAN_MAX) break;
    if (o.ownTaskReminders?.has(t.id)) continue;
    let start: number, end: number, until: number, id: string, pill = r.label || DUE_NAG_PILL;
    if (late(t)) {
      if (next === null) continue;
      end = floorMin(next);
      start = floorMin(Math.max(t.dueAt, ctx.dayEndAtOrBefore?.(ctx.now) ?? end - 24 * H));
      until = end - M;   // never the same clock time as the start (a window of exactly a day reads as none)
      id = autoId("n", t.id, end);
      pill = r.label || DUE_OVERDUE_PILL;
    } else {
      end = until = floorMin(t.dueAt); start = end - cfg.hours * H;
      if (start > ctx.now + DUE_LOOK_AHEAD_MS) continue;
      id = autoId("n", t.id, t.dueAt);
    }
    if (until <= start) continue;
    const s = stateOf(rec, id);
    out.push({
      id, on: true, pill, text: fillWords(r.text, t.title, t.dueAt - Math.max(ctx.now, start)),
      at: hmOf(start, ctx.tz), until: hmOf(until, ctx.tz), days: [...ALL_DAYS], tz: ctx.tz,
      snooze: r.snooze, later: laterOf(r), yes: yesOf(r), word: wordOf(r), click: r.click, bg: r.bg, accent: r.accent, ink: inkFor(r.bg),
      sound: r.sound === "own" ? "soft" : r.sound, vol: r.vol, done: s?.done ?? "", snoozeUntil: s?.snoozeUntil ?? 0, stateAt: s?.at ?? 0,   // own sound files are per reminder id: the soft chime here
      task: t.id, date: dayOf(start, ctx.tz), open: OPEN_WORDS,
    });
  }
  return out;
}
/** A Priority 1 alarm's moment: `lead` minutes before it is due (its 24 hours or the day end, the sooner), to the minute; never
 *  before the task became Priority 1 (one made 30 minutes before the day ends rings at once, not "an hour ago"). */
export const p1RingAt = (dueAt: number, lead: number, start?: number) => Math.max(floorMin(dueAt - lead * M), start ? Math.ceil(start / M) * M : 0);

/** The P1 alarms: one ring per Priority 1 task, for the Mac's card (a plan item that rings) and the phone's ring (AlarmRing).
 *  Acknowledged ones and ones whose 24 hours are over are left out, so a phone ringing one stops. */
export function dueP1Items(tasks: DueTask[], rec: RemindRec | null, red: boolean, ctx: Pick<DueCtx, "now" | "tz">): { items: PlanItem[]; rings: AlarmRing[] } {
  const cfg = dueCfgOf(rec, red), r = cfg.p1;
  const items: PlanItem[] = [], rings: AlarmRing[] = [];
  if (!r.on) return { items, rings };
  for (const t of tasks) {
    if (t.kind !== "p1" || items.length >= DUE_P1_MAX) continue;
    if (t.dueAt <= ctx.now) continue;   // its 24 hours are over: the row says Missed, nothing rings
    const at = p1RingAt(t.dueAt, cfg.lead, t.start);
    if (at >= t.dueAt) continue;
    if (at < ctx.now - 6 * H || at > ctx.now + DUE_LOOK_AHEAD_MS) continue;
    const id = autoId("p", t.id, t.dueAt), s = stateOf(rec, id), day = dayOf(at, ctx.tz);
    const text = fillWords(r.text || DUE_P1_TEXT, t.title, t.dueAt - at);
    const title = r.label || DUE_P1_TITLE, yes = r.yes || DUE_P1_YES, word = r.word || DUE_P1_WORD;
    if (s?.done !== day) rings.push({ id, day, at, title, text, yes, later: ALARM_LATER, bg: r.bg, accent: r.accent, ink: inkFor(r.bg), one: true, word });
    items.push({
      // The Mac card may open any time from the ring until the 24 hours run out (a card only opens while you are at the Mac, so a
      // 10 minute window could miss you); its sound rings ALARM_RING_MIN at most (ps-mac Reminders.swift `ring`).
      id, on: true, pill: title, text, at: hmOf(at, ctx.tz), until: hmOf(floorMin(t.dueAt), ctx.tz), days: [...ALL_DAYS], tz: ctx.tz,
      // The developer: a click alone must not stop it. I acknowledge opens the box, and only the word (yes) typed clears it, on every device.
      snooze: 5, later: ALARM_LATER, yes, word, click: false, bg: r.bg, accent: r.accent, ink: inkFor(r.bg),
      sound: r.sound === "own" ? "alarm" : r.sound, vol: r.vol, done: s?.done ?? "", snoozeUntil: s?.snoozeUntil ?? 0, stateAt: s?.at ?? 0,
      // `task` is set only so an older Mac or phone keeps the one day (they drop `date` without a task); I acknowledge never
      // ticks it (autoTask and src/duewatch.ts dueTaskOf leave "p" ids alone) and there is no Open task button (open "").
      task: t.id, date: day, open: "", one: true, ring: true,
    });
  }
  return { items, rings };
}
/** The task behind a worked out item: Done on a nag ticks it. A P1 alarm ("p") never ticks its task. */
export function autoTask(items: PlanItem[], id: string): string | null {
  if (!id.startsWith("n")) return null;
  const i = items.find((x) => x.id === id);
  return i && i.task ? i.task : null;
}

// ---------- your own Priority 1 clock ----------
/** What to write on your tasks so every one off Priority 1 has its own start time (p1Since) and no other task does. It is the
 *  squad's clock when there is one (p1At), else now; a P1 that was done and opened again starts afresh; a task that left
 *  Priority 1 (or became a repeating one) loses it. Cleared tasks are left alone (nothing to write for them). */
/** PS 1.75 (core/scheduled.ts): `waits` says a task is scheduled for a later day; it has no clock until that day (an old stamp is
 *  taken off). `landStart` is when the person's current day started: a task that waited (added before it) and is new in
 *  Priority 1 today with `due` on `landDay` starts its 24 hours then, the moment it landed, even if PS was closed over the day end. */
export type P1StampOpts = { waits?: (t: DueTodo) => boolean; landStart?: number; landDay?: string };
/** Break-it 1.75: `updatedAt` and `pending` are the doc's (core/model.ts Doc). A task changed after it landed (made P1 at 15:00, or
 *  an edit not synced yet) starts from now: only a task left as it was since before its day started counts from the day start. */
export function p1OwnStamps(todos: { id: string; data: DueTodo; updatedAt?: string | null; pending?: boolean }[], now: number, o: P1StampOpts = {}): { id: string; p1Since: string | null }[] {
  const out: { id: string; p1Since: string | null }[] = [];
  const nowIso = new Date(now).toISOString();
  for (const { id, data: t, updatedAt, pending } of todos) {
    if (!t || t.clearedAt || t.example === true) continue;
    const own = cleanStart(t.p1Since, now);
    if (!isP1(t) || t.aiInbox === true) { if (t.p1Since) out.push({ id, p1Since: null }); continue; }
    // Break-it 1.75: a waiting task gets nothing written. Taking an old stamp off would fight a 1.74 device, which stamps every P1
    // it shows (each write wakes the other device: a loop). Its clock is set when it lands (below).
    if (o.waits?.(t)) continue;
    if (t.done) continue;
    const squad = cleanStart(t.p1At, now);
    const landing = o.landStart !== undefined && Number.isFinite(o.landStart) && o.landStart <= now && !!o.landDay && t.due === o.landDay;
    // A stamp from before its day started (written while it waited, by a 1.74 device or before it got its day) starts again at
    // the landing, once: the 24 hours count from its day.
    if (own && landing && Date.parse(own) < o.landStart!) { out.push({ id, p1Since: squad && Date.parse(squad) >= o.landStart! ? squad : new Date(o.landStart!).toISOString() }); continue; }
    if (own) {
      const doneAt = typeof t.doneAt === "string" ? Date.parse(t.doneAt) : NaN;
      if (Number.isFinite(doneAt) && doneAt >= Date.parse(own)) out.push({ id, p1Since: squad && Date.parse(squad) > doneAt ? squad : nowIso });   // opened again
      continue;
    }
    // Landed today after waiting for its day: its clock starts when the day started (never before it was added, never later than now).
    const made = typeof t.createdAt === "string" ? Date.parse(t.createdAt) : NaN;
    const changed = typeof updatedAt === "string" ? Date.parse(updatedAt) : NaN;
    const landed = landing && Number.isFinite(made) && made < o.landStart! && pending !== true && Number.isFinite(changed) && changed < o.landStart!
      ? new Date(o.landStart!).toISOString() : null;
    out.push({ id, p1Since: squad ?? landed ?? nowIso });
  }
  return out;
}
