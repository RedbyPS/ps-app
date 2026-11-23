// Progress check-ins and task timers on the Dynamic Island (PS 1.77, the developer, 23 Nov 2026).
//
// What it does:
//  - Check-ins: while a task is being worked on, every 30 minutes (Settings, and per task) the island "buzzes": it shakes,
//    comes to the middle of the screen, opens into a card ("You've been working on this for 30 minutes") and goes back to its
//    spot. No sound, ever. Reduce motion: a calm card under the island, no flying and no shaking. Esc closes it at once.
//  - Timers: only on a task with an expected time that the person picked or typed (the task's `est`, PS 1.65 time estimates;
//    a time PS learned and filled in by itself, estBy "past", is no timer). It counts down from when work on the task began
//    (the time spent clock, core/timeest.ts, AFK breaks taken off), in one of four looks next to or under the task. When the
//    time is up the island buzzes too.
//  - Opt in (the developer: "opt in at first with the option to turn it off the first time it comes up"): OFF until the person says
//    yes. The first time it would buzz, the island buzzes once with the question "Want a check-in like this every 30 minutes?"
//    and Turn on or Not now. Either answer is kept (settings.island.progress.on) and the question never comes again; Esc or
//    no answer is no answer, and the Mac asks again at the next would-be buzz a day later (OFFER_AGAIN_MS). The switch is also in
//    Settings, Dynamic Island, with the interval and the look.
//
// Pure: no clock, no vault, no DOM. src/island.ts sends the Mac what it needs to count by itself (wall clock times, never a
// ticking number); ps-mac IslandProgressCore.swift has the SAME rules (its own unit test, tests/island-progress-test.sh) and
// IslandProgress.swift draws them. tests/islandprogress.test.ts checks every rule here.
import type { Todo } from "./model";
import { cleanEst, parseEst } from "./timeest.ts";

export const PROGRESS_FEATURE = "island-progress";

// ---------- the setting (settings.island.progress, synced) ----------
export type ProgressLook = "ring" | "sand" | "text" | "line";
/** on: true (switched on), false (Not now, or switched off), null (never answered: off, and the one question is still due). */
export interface ProgressPrefs { on: boolean | null; every: number; look: ProgressLook }
export const EVERY_DEFAULT = 30, EVERY_MIN = 5, EVERY_MAX = 240;
/** The quick picks for the interval (Settings and per task); any other time from 5 minutes to 4 hours can be typed. */
export const EVERY_CHOICES = [15, 30, 45, 60, 90] as const;
export const PROGRESS_DEFAULT: ProgressPrefs = { on: null, every: EVERY_DEFAULT, look: "ring" };
export const LOOKS: { k: ProgressLook; label: string; line: string }[] = [
  { k: "ring", label: "Ring", line: "A ring beside the task that empties anticlockwise." },
  { k: "sand", label: "Sand timer", line: "An hourglass that turns over at the start and runs down." },
  { k: "text", label: "Time left", line: "The time left in plain words, like 16m." },
  { k: "line", label: "Line", line: "A thin line under the task that shrinks to nothing." },
];
const isLook = (v: unknown): v is ProgressLook => LOOKS.some((x) => x.k === v);

/** Whole minutes from 5 to 240, or null. */
function minutes(v: unknown): number | null {
  const n = typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? Math.min(EVERY_MAX, Math.max(EVERY_MIN, Math.round(n))) : null;
}
export function progressPrefs(v: unknown): ProgressPrefs {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    on: o.on === true ? true : o.on === false ? false : null,
    every: minutes(o.every) ?? EVERY_DEFAULT,
    look: isLook(o.look) ? o.look : PROGRESS_DEFAULT.look,
  };
}
export const progressOn = (p: ProgressPrefs) => p.on === true;
/** The one question is still due: never answered. */
export const offerDue = (p: ProgressPrefs) => p.on === null;

// ---------- per task (Todo.checkEvery) ----------
/** A task's own interval: null is the Settings one, 0 is no check-ins on this task, else 5 to 240 minutes. */
export function cleanCheckEvery(v: unknown): number | null {
  if (v === 0) return 0;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? minutes(v) : null;
}
/** A typed interval ("20", "1h", "1:30"): 5 minutes to 4 hours, else null. */
export function parseEvery(typed: unknown): number | null {
  const m = parseEst(typed);
  return m !== null && m >= EVERY_MIN && m <= EVERY_MAX ? m : null;
}
/** The interval in use on this task: its own, else the Settings one. 0: no check-ins on it. */
export function everyFor(p: ProgressPrefs, t: Pick<Todo, "checkEvery"> | null | undefined): number {
  const own = cleanCheckEvery(t?.checkEvery);
  return own ?? p.every;
}
/** The expected time that gets a timer: one the person picked or typed, or (PS 1.77, the developer 23 Nov 2026) one PS learned from
 *  at least 5 clean real finishes (estBy "past", core/timeest.ts learnFrom), which counts as the task's expected time. 0: none. */
export function timerMin(t: Pick<Todo, "est" | "estBy"> | null | undefined): number {
  if (!t || t.estBy === "off") return 0;
  return cleanEst(t.est) ?? 0;
}

// ---------- the words (every one waits for the developer's approval; no em or en dashes) ----------
/** {t} is a length of time ("30 minutes", "1 hour 5 minutes"); the Mac fills it in the same way (IslandProgressCore.swift). */
export const PROGRESS_WORDS = {
  working: "You've been working on this for {t}",
  left: "{t} left",
  up: "Time's up",
  over: "{t} over",
  ask: "Want a check-in like this every {t}?",
  turnOn: "Turn on",
  notNow: "Not now",
  askNote: "You can change this any time in Settings, Dynamic Island.",
} as const;
export const fill = (w: string, t: string) => w.replace("{t}", t);
/** "1 minute", "30 minutes", "1 hour", "1 hour 5 minutes", "2 hours". */
export function durWords(min: number): string {
  const n = Math.max(0, Math.round(min)), h = Math.floor(n / 60), m = n % 60;
  const one = (x: number, w: string) => `${x} ${w}${x === 1 ? "" : "s"}`;
  if (h === 0) return one(m, "minute");
  return m === 0 ? one(h, "hour") : `${one(h, "hour")} ${one(m, "minute")}`;
}
/** The time left as the Text look shows it: whole minutes rounded up, "16m", "1h", "1h 5m". */
export function leftShort(ms: number): string {
  const n = Math.max(0, Math.ceil(ms / 60_000)), h = Math.floor(n / 60), m = n % 60;
  return h === 0 ? `${m}m` : m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// ---------- what the island is sent ----------
export interface ProgressIsland {
  id: string;
  title: string;
  /** ms: now minus the time spent this round (AFK and Pomodoro breaks taken off). The Mac counts on from it by itself. */
  since: number;
  /** ms: when this round of the task began (keys the buzzes, so a new round starts again at the first check-in). */
  round: number;
  /** Minutes between check-ins; 0: none on this task. */
  every: number;
  /** The expected time in minutes (a timer); 0: none. */
  est: number;
  look: ProgressLook;
  /** Switched on. false with `ask`: only the one question, at the first would-be buzz, and no timer yet. */
  on: boolean;
  ask: boolean;
  /** Do Not Disturb mutes the island: the timer still shows, nothing buzzes. */
  quiet: boolean;
  words: typeof PROGRESS_WORDS;
}
export interface ProgressInput {
  prefs: ProgressPrefs;
  /** feature(PROGRESS_FEATURE), and the time spent clock switched on (Settings, Your list, Time spent). */
  featureOn: boolean;
  trackOn: boolean;
  /** The island's task (core/island.ts islandState): a dimmed next up task is not being worked on. */
  task: { id: string; title: string; dim: boolean } | null;
  todo: Pick<Todo, "done" | "est" | "estBy" | "checkEvery"> | undefined;
  /** ms spent this round (core/timeest.ts spentMs); null: its clock is not running. */
  spent: number | null;
  round: number | null;
  now: number;
  quiet: boolean;
}
/** null: nothing to count (switched off and answered, no task being worked on, its clock stopped, or nothing set to buzz). */
export function progressIsland(i: ProgressInput): ProgressIsland | null {
  const p = i.prefs;
  if (!i.featureOn || !i.trackOn || (!progressOn(p) && !offerDue(p))) return null;
  if (!i.task || i.task.dim || !i.todo || i.todo.done || i.spent === null || !Number.isFinite(i.spent)) return null;
  const every = everyFor(p, i.todo), est = timerMin(i.todo);
  if (!every && !est) return null;
  const since = Math.round(i.now - Math.max(0, i.spent));
  return { id: i.task.id, title: i.task.title, since, round: Math.round(Math.min(since, i.round ?? since)), every, est, look: p.look,
    on: progressOn(p), ask: offerDue(p), quiet: i.quiet, words: PROGRESS_WORDS };
}

// ---------- when it buzzes (the Mac runs the same rules, IslandProgressCore.swift) ----------
/** A check-in missed by more than this (the Mac asleep, a meeting, Do Not Disturb) is skipped, never caught up later. */
export const GRACE_MS = 5 * 60_000;
/** An unanswered question (Esc, or it timed out) asks again at the next would-be buzz this long after (the Mac keeps the time). */
export const OFFER_AGAIN_MS = 20 * 3_600_000;
/** How long a check-in card stays before the island goes back (a click or Esc closes it sooner). The question waits longer. */
export const SHOW_MS = 7_000, ASK_SHOW_MS = 45_000;
export type BuzzKind = "check" | "up" | "offer";
export interface Buzz { kind: BuzzKind; keys: string[]; minutes: number; leftMs: number | null }
export const buzzKey = (p: Pick<ProgressIsland, "id" | "round">, what: string) => `${p.id}.${Math.round(p.round).toString(36)}.${what}`;

/** The buzz due now, or null. `done`: the keys already buzzed (or skipped). A check-in and the time up at the same moment are
 *  one buzz (the time up). Switched off with the question due: the first would-be buzz is the question instead. */
export function buzzDue(p: ProgressIsland, now: number, done: ReadonlySet<string> = new Set()): Buzz | null {
  const el = now - p.since;
  if (!(el > 0)) return null;
  const keys: string[] = [];
  let up = false;
  if (p.est > 0) {
    const at = p.est * 60_000, k = buzzKey(p, "up");
    if (el >= at && el - at < GRACE_MS && !done.has(k)) { keys.push(k); up = true; }
  }
  if (p.every > 0) {
    const step = p.every * 60_000, n = Math.floor(el / step), k = buzzKey(p, String(n));
    if (n >= 1 && el - n * step < GRACE_MS && !done.has(k)) keys.push(k);
  }
  if (!keys.length) return null;
  const leftMs = p.est > 0 ? p.est * 60_000 - el : null;
  if (!p.on) return p.ask ? { kind: "offer", keys, minutes: Math.floor(el / 60_000), leftMs } : null;
  return { kind: up ? "up" : "check", keys, minutes: Math.floor(el / 60_000), leftMs };
}

/** What keeps a due buzz from showing now. It is tried again a moment later, until GRACE_MS has passed. */
export interface BuzzBlock {
  islandOff: boolean;      // the island is switched off (Settings, Dynamic Island, Off)
  away: boolean;           // "Disappear for 30 minutes" or "for this meeting", or hidden with its grab line
  meeting: boolean;        // a meeting is on now (a real one: people or a call link)
  hidden: boolean;         // not on screen: over a full screen app where it does not show, or behind a protected app
  takeover: boolean;       // a Pomodoro break, a stand-up or another island moment holds the island
  busy: boolean;           // another card is out of the island (the shared queue)
  idle: boolean;           // no key or mouse for 5 minutes, or the screen is locked
  quiet: boolean;          // Do Not Disturb
}
export const IDLE_MS = 5 * 60_000;
export function buzzBlocked(b: BuzzBlock): keyof BuzzBlock | null {
  const order: (keyof BuzzBlock)[] = ["islandOff", "away", "hidden", "meeting", "quiet", "idle", "takeover", "busy"];
  return order.find((k) => b[k]) ?? null;
}
/** The question again after Esc or no answer: not before OFFER_AGAIN_MS. */
export const offerAgain = (lastShown: number | null, now: number) => lastShown === null || now - lastShown >= OFFER_AGAIN_MS;

// ---------- the timer ----------
/** ms left of the expected time (never below 0), or null with no timer. */
export function leftMs(p: Pick<ProgressIsland, "since" | "est">, now: number): number | null {
  return p.est > 0 ? Math.max(0, p.est * 60_000 - (now - p.since)) : null;
}
/** How much of the expected time is left, 1 at the start to 0 when it is up (the ring, the sand and the line). */
export function leftFrac(p: Pick<ProgressIsland, "since" | "est">, now: number): number {
  const l = leftMs(p, now);
  return l === null ? 0 : Math.min(1, l / (p.est * 60_000));
}
/** The timer shows: switched on, an expected time, and some of it left (the ring is gone when the time is up). */
export const timerShows = (p: ProgressIsland | null, now: number) => !!p && p.on && p.est > 0 && (leftMs(p, now) ?? 0) > 0;

/** The card's lines for a buzz: the task is the headline, a line under it, then these words. */
export function buzzWords(p: ProgressIsland, b: Buzz): { main: string; sub: string | null; ask: string | null } {
  const w = p.words;
  const main = fill(w.working, durWords(Math.max(1, b.minutes)));
  let sub: string | null = null;
  if (b.kind === "up") sub = w.up;
  else if (p.est > 0 && b.leftMs !== null) sub = b.leftMs > 0 ? fill(w.left, durWords(Math.ceil(b.leftMs / 60_000))) : fill(w.over, durWords(Math.max(1, Math.floor(-b.leftMs / 60_000))));
  const ask = b.kind === "offer" ? fill(w.ask, durWords(p.every || EVERY_DEFAULT)) : null;
  return { main, sub, ask };
}

// ---------- the answer to the one question ----------
/** What an answer from the island saves ({type:"islandAction", action:"progressAsk", id:"on"|"off"}): only while it is due. */
export function progressAskPatch(answer: unknown, island: unknown): { progress: ProgressPrefs } | null {
  if (answer !== "on" && answer !== "off") return null;
  const p = progressPrefs((island as { progress?: unknown } | null | undefined)?.progress);
  if (!offerDue(p)) return null;
  return { progress: { ...p, on: answer === "on" } };
}
