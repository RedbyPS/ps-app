// Time spent, the saving half (PS 1.65; the rules are core/timeest.ts). Runs on the page that holds the vault (PS: the main window,
// the website, the phone): core/actions.ts calls it when Working on changes and on every tick, src/pomodoro.ts when a Pomodoro
// phase ends, and the Start button in a task's menu or Edit (from the Tab list as a "looks" patch { timeOp }).
//
// Every write goes through one lane, built on the newest copy, to the person's own fixed records (kind "ttime": one live record,
// one per month), owner only and sealed with the vault key; two devices merge (setMerger in core/actions.ts). Nothing goes to the
// G Squad, the hub or anyone else, and nothing here ever waits on the caller: a tick or a click is never slowed down by it.
import type { Todo } from "./model";
import { docs, put, remove, vaultStore, type Snapshot } from "./vault";
import { settingsData } from "./select";
import { feature } from "./features";
import { overdueZone } from "./overdue";
import * as T from "./timeest";

const can = (s: Snapshot) => s.status === "unlocked" && s.role === "owner" && !!s.userId && s.userId !== "ps-overlay";
/** Time spent is being measured for this person here (the feature, and Settings, Your list, Time spent). */
export function trackOn(s: Snapshot = vaultStore.get()): boolean {
  return can(s) && feature("time-estimates") && T.cleanTe(settingsData(s).timeEst).track;
}
/** Estimates are on (the feature, and Settings, Your list, Time estimates). */
export function estOn(s: Snapshot = vaultStore.get()): boolean {
  return s.status === "unlocked" && feature("time-estimates") && T.cleanTe(settingsData(s).timeEst).est;
}
const zone = (s: Snapshot) => overdueZone(settingsData(s).tmHomeTz);

let lane: Promise<unknown> = Promise.resolve();
/** One write at a time, each on the newest copy. Errors are swallowed: a lost note is retried by nothing, and never breaks a tick. */
function inLane(job: () => Promise<void>): Promise<void> {
  const p = lane.then(job).catch(() => {});
  lane = p;
  return p;
}

async function writeLive(s: Snapshot, live: T.TLive, ids: string[]) {
  const id = T.teRecId(s.userId!, "live");
  const now = Date.now();
  const exists = (tid: string) => { const d = s.docs.get(tid); return !!d && d.kind === "todo" && !(d.data as Todo).clearedAt; };
  await put(T.TE_KIND, T.dropGone(T.pruneLive(live, now), exists, now), { id, ws: null });
  for (const old of ids) if (old !== id) await remove(old);   // a copy under another id (never expected, kept tidy)
}
/** Change the live record: `f` gets the newest one and gives back the new one, or null for no change. */
function changeLive(f: (l: T.TLive, s: Snapshot) => T.TLive | null): Promise<void> {
  return inLane(async () => {
    const s = vaultStore.get();
    if (!trackOn(s)) return;
    const { live, liveIds } = T.foldTime(docs(T.TE_KIND, null));
    const next = f(live, s);
    if (next) await writeLive(s, next, liveIds);
  });
}

/** Working on, or Start: the task's clock starts (already running: nothing). */
export function clockStart(id: string, title?: string): Promise<void> {
  return changeLive((l, s) => {
    const d = s.docs.get(id);
    if (!d || d.kind !== "todo" || (d.data as Todo).done) return null;
    return T.startClock(l, id, title ?? (d.data as Todo).title, Date.now());
  });
}
/** Working on taken off, or Stop. */
export function clockStop(id: string): Promise<void> {
  return changeLive((l) => T.stopClock(l, id, Date.now()));
}
/** Working on cleared for every task. */
export function clockStopAll(): Promise<void> {
  return changeLive((l) => {
    let out: T.TLive | null = null;
    for (const id of T.runningIds(l)) out = T.stopClock(out ?? l, id, Date.now()) ?? out;
    return out;
  });
}

/** A tick: what the round took goes into its month, the clock is cleared. A task never started records nothing. */
export function clockFinish(id: string, at?: number): Promise<void> {
  return inLane(async () => {
    const s = vaultStore.get();
    if (!trackOn(s)) return;
    const d = s.docs.get(id);
    const t = d?.kind === "todo" ? (d.data as Todo) : null;
    if (!t || t.example) return;
    // The tick's own time (the task's doneAt) when it is the tick just made: then this device and one that catches the tick later
    // (lookTicked) write the very same finish key, and the merge keeps one, never two.
    const tickAt = t.done && t.doneAt ? Date.parse(t.doneAt) : Number.NaN;
    const now = at ?? (Number.isFinite(tickAt) && Math.abs(Date.now() - tickAt) < 60_000 ? tickAt : Date.now()), st = settingsData(s);
    const all = T.foldTime(docs(T.TE_KIND, null));
    if (at !== undefined && !T.isRunning(all.live, id)) return;   // a catch up (below) that another device or tick already did
    const f = T.finishClock(all.live, id, now, T.awaySpans(st.awayLog));
    if (f.minutes === null) return;
    await writeLive(s, f.live, all.liveIds);
    if (f.minutes < 1) return;   // under a minute: a tick straight after a start, not a real time
    const mo = T.monthOf(now, zone(s));
    const had = all.months.get(mo);
    const rec = T.addDone(had?.rec ?? null, mo, id, { n: (t.title || f.title).replace(/\s+/g, " ").trim().slice(0, T.TL.title), m: f.minutes, e: T.cleanEst(t.est) ?? 0, at: now });
    const recId = T.teRecId(s.userId!, mo);
    await put(T.TE_KIND, rec, { id: recId, ws: null });
    for (const old of had?.ids || []) if (old !== recId) await remove(old);
  });
}
/** An untick: the last finish (within 12 hours) is taken back and its minutes carry over to the next tick. */
export function clockUntick(id: string): Promise<void> {
  return inLane(async () => {
    const s = vaultStore.get();
    if (!trackOn(s)) return;
    const now = Date.now();
    const all = T.foldTime(docs(T.TE_KIND, null));
    const last = T.lastDoneOf([...all.months.values()].map((m) => m.rec), id, now);
    if (!last) return;
    const m = all.months.get(last.mo)!;
    await put(T.TE_KIND, T.undoDone(m.rec, last.key, now), { id: T.teRecId(s.userId!, last.mo), ws: null });
    await writeLive(s, T.carryBack(all.live, id, last.d.m, now), all.liveIds);
  });
}

/** A task ticked on another device that had not seen its clock start yet: the clock here is finished as of that tick (or just
 *  stopped), so it never runs on for days. Looked at after vault changes, a moment later, only while a clock is running. Two devices
 *  doing it make the same records (the same finish key), so the merge keeps one. */
let lookTimer: ReturnType<typeof setTimeout> | null = null;
function lookTicked() {
  lookTimer = null;
  const s = vaultStore.get();
  if (!trackOn(s)) return;
  const { live } = T.foldTime(docs(T.TE_KIND, null));
  if (!T.runningIds(live).length) return;
  const doneAt = (id: string) => {
    const d = s.docs.get(id);
    const t = d?.kind === "todo" ? (d.data as Todo) : null;
    if (!t?.done || !t.doneAt) return null;
    const ms = Date.parse(t.doneAt);
    return Number.isFinite(ms) ? ms : null;
  };
  const now = Date.now();
  let later = Infinity;
  for (const x of T.tickedElsewhere(live, doneAt)) {
    // The device that ticked may have had the clock after all: its own finish (under its own key) reaches this one with the tick or
    // just after. Only a tick older than TICK_GRACE_MS with the clock still running here is one that recorded nothing.
    if (now - x.at < TICK_GRACE_MS) { later = Math.min(later, x.at + TICK_GRACE_MS - now); continue; }
    if (x.how === "finish") void clockFinish(x.id, x.at);
    else void changeLive((l) => T.stopClock(l, x.id, Math.max(Date.now(), x.at)));
  }
  if (later !== Infinity && lookTimer === null) lookTimer = setTimeout(lookTicked, later + 500);
}
const TICK_GRACE_MS = 2 * 60_000;
if (typeof window !== "undefined") vaultStore.subscribe(() => { if (lookTimer === null) lookTimer = setTimeout(lookTicked, 1500); });

/** A Pomodoro phase changed on this device (src/pomodoro.ts): the phase that ended becomes a piece, with the tasks worked on. */
export function notePomo(was: Parameters<typeof T.pomoPiece>[0], next: Parameters<typeof T.pomoPiece>[1], working: string[]): void {
  const piece = T.pomoPiece(was, next, Date.now(), working);
  if (piece) void changeLive((l) => T.addPomo(l, piece, Date.now()));
}

/** The Start and Stop buttons (a task's menu and Edit), here or from the Tab list. */
export type TimeOp = { op: "start" | "stop"; id: string };
export function cleanTimeOp(v: unknown): TimeOp | null {
  const o = v && typeof v === "object" ? v as Record<string, unknown> : null;
  return o && (o.op === "start" || o.op === "stop") && typeof o.id === "string" && o.id.length <= 64 ? { op: o.op, id: o.id } : null;
}
export const runTimeOp = (o: TimeOp) => (o.op === "start" ? clockStart(o.id) : clockStop(o.id));

/** Learning, for a new task: the usual time of tasks with the same or a very similar name, or null. */
export function learnedEst(title: string, s: Snapshot = vaultStore.get()): number | null {
  if (!estOn(s) || s.status !== "unlocked") return null;
  const { months } = T.foldTime(docs(T.TE_KIND, null));
  return T.usualMin(T.pastTimes(T.allDone([...months.values()].map((m) => m.rec)), title));
}
