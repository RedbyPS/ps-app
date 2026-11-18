// G Squad Priority 1 board (PS 1.68, feature "squad-p1-board"), Jan 18 Nov 2026: "a leaderboard for squad P1s, to compete ... hit
// rate and streak ... creative design that will not take a lot of space, very clear what it is, minimalistic". The Squad Priority 1
// panel in the Tab list shows one row per PERSON (not per task), ranked: their open P1 with the time left, their hit rate and their
// streak. Pure rules only (no screen, no network, no clock of its own), so tests/squadp1board.test.ts checks every one.
//
// Where the numbers come from (nothing new leaves anyone's device): the shared Priority 1 copies this PS already opens
// (core/squadp1.ts). Each copy carries its start (`s`), done (`x`) and done time (`xa`). This PS keeps a small log on its own
// device of how each P1 it saw ended: hit (done inside 24 hours) or miss (the 24 hours ran out, or it was done late). A P1 that
// vanished before PS saw how it ended (hidden from the squad, no longer Priority 1, deleted) is never counted. The hub only keeps
// a done copy for a day, so the history starts the day this PS starts counting, and every number says from when it counts.
import { cleanStart, firstName, p1Deadline, p1Rows, p1State, leftText, type P1Row } from "./squadp1.ts";
import { validTz, wall } from "./tz.ts";

export const BOARD_FEATURE = "squad-p1-board";
/** Hit rate covers this many days back (by when each P1 ended). */
export const RATE_DAYS = 30;
/** The log keeps this many days (the streak can look back this far). */
export const KEEP_DAYS = 90;
/** People with fewer counted P1s than this are listed under the ranked ones, without a place. */
export const RANK_MIN = 3;
/** How many people the panel shows before "more" (its own setting, the drag handle at its foot). */
export const ROWS_DEF = 5, ROWS_MIN = 1, ROWS_MAX = 12;
/** The time left turns amber under this, red only in the last 2 hours (Jan 18 Nov: "22h shows red, which is wrong"). */
export const AMBER_MS = 8 * 3_600_000, RED_MS = 2 * 3_600_000;
export const LOG_MAX = 4000;
const DAY = 86_400_000;

export type Outcome = "open" | "hit" | "miss";
/** One P1 this PS saw: who, the copy id, its start, how it ended (`at`: when it ended, ms). */
export interface Seen { m: string; id: string; s: string; o: Outcome; at?: number }
/** The log on this device. since: when this PS started counting. */
export interface P1Log { since: string; e: Record<string, Seen> }
export interface CopyIn { id: string; member: string; x: boolean; xa?: string | null; s?: string | null; e?: boolean; t?: string }

const ms = (v: unknown): number => (typeof v === "string" ? Date.parse(v) : NaN);
const UUIDISH = /^[A-Za-z0-9-]{1,60}$/;
const keyOf = (id: string, s: string) => `${id}@${s}`;

/** A log read back from storage, every field checked. null: nothing usable (start a new one). */
export function cleanP1Log(v: unknown): P1Log | null {
  const o = v as { since?: unknown; e?: unknown } | null;
  if (!o || typeof o !== "object" || !Number.isFinite(ms(o.since))) return null;
  const e: Record<string, Seen> = {};
  if (o.e && typeof o.e === "object") {
    for (const x of Object.values(o.e as Record<string, unknown>).slice(0, LOG_MAX)) {
      const r = x as Partial<Seen> | null;
      if (!r || typeof r.m !== "string" || !UUIDISH.test(r.m) || typeof r.id !== "string" || !UUIDISH.test(r.id)) continue;
      if (typeof r.s !== "string" || !Number.isFinite(ms(r.s)) || (r.o !== "open" && r.o !== "hit" && r.o !== "miss")) continue;
      const s = new Date(ms(r.s)).toISOString();
      const seen: Seen = { m: r.m, id: r.id, s, o: r.o };
      if (r.o !== "open") { if (typeof r.at !== "number" || !Number.isFinite(r.at)) continue; seen.at = r.at; }
      e[keyOf(r.id, s)] = seen;
    }
  }
  return { since: new Date(ms(o.since)).toISOString(), e };
}
export const newP1Log = (now: number): P1Log => ({ since: new Date(now).toISOString(), e: {} });

/** How one copy stands now. null: not a P1 copy, or done with no done time after its deadline (cannot tell if it was in time). */
export function outcomeOf(c: Pick<CopyIn, "x" | "xa" | "s">, now: number): { s: string; o: Outcome; at?: number } | null {
  const s = cleanStart(c.s, now);
  if (!s) return null;
  const dl = p1Deadline(s);
  if (c.x === true) {
    const xa = ms(c.xa);
    if (Number.isFinite(xa)) return xa <= dl ? { s, o: "hit", at: Math.min(xa, now) } : { s, o: "miss", at: dl };
    return now <= dl ? { s, o: "hit", at: now } : null;
  }
  return now >= dl ? { s, o: "miss", at: dl } : { s, o: "open" };
}

/** The log after looking at the copies held now. An ending is final (a miss never turns into a hit). A P1 reopened gets a new
 *  start, so it is a new entry; the old open entry of the same copy goes. Open entries nobody saw end are dropped two days
 *  after their deadline (never counted). Old entries go after KEEP_DAYS. */
export function observeP1(log: P1Log | null, copies: readonly CopyIn[], now: number): { log: P1Log; changed: boolean } {
  const base = log ?? newP1Log(now);
  const e: Record<string, Seen> = { ...base.e };
  let changed = !log;
  const openById = new Map<string, string[]>();
  for (const [k, v] of Object.entries(e)) if (v.o === "open") { const l = openById.get(v.id) ?? []; l.push(k); openById.set(v.id, l); }
  for (const c of copies) {
    if (!c || c.e || typeof c.id !== "string" || !UUIDISH.test(c.id) || typeof c.member !== "string" || !UUIDISH.test(c.member)) continue;
    const out = outcomeOf(c, now);
    if (!out) continue;
    const k = keyOf(c.id, out.s);
    for (const old of openById.get(c.id) ?? []) if (old !== k && e[old]) { delete e[old]; changed = true; }
    const had = e[k];
    if (had && had.o !== "open") continue;
    if (had && had.o === out.o && had.m === c.member) continue;
    e[k] = { m: c.member, id: c.id, s: out.s, o: out.o, ...(out.at !== undefined ? { at: out.at } : {}) };
    changed = true;
  }
  for (const [k, v] of Object.entries(e)) {
    const end = v.o === "open" ? p1Deadline(v.s) + 2 * DAY : v.at!;
    if (end < now - (v.o === "open" ? 0 : KEEP_DAYS * DAY)) { delete e[k]; changed = true; }
  }
  const keys = Object.keys(e);
  if (keys.length > LOG_MAX) {
    keys.sort((a, b) => (e[a].at ?? ms(e[a].s)) - (e[b].at ?? ms(e[b].s)));
    for (const k of keys.slice(0, keys.length - LOG_MAX)) delete e[k];
    changed = true;
  }
  return { log: changed ? { since: base.since, e } : base, changed };
}

// ---------- the numbers ----------
export interface P1Stats {
  hits: number; total: number;
  /** Whole percent, null with nothing counted. */
  rate: number | null;
  /** Days in a row (days with a P1 only) where every P1 that ended was done inside 24 hours. */
  streak: number;
  /** When the hit rate starts counting (ms): 30 days back, or later when this PS started counting later. */
  from: number;
}
const pad = (n: number) => String(n).padStart(2, "0");
function dayKey(ts: number, tz: string): string { const w = wall(ts, validTz(tz) ? tz : "UTC"); return `${w.y}-${pad(w.mo)}-${pad(w.d)}`; }

export function p1Stats(log: P1Log | null, member: string, now: number, tz: string): P1Stats {
  // Counting starts when this PS started (or at the earliest ending it saw, a P1 that had already run out when it first looked).
  let first = log ? ms(log.since) : now;
  for (const v of Object.values(log?.e ?? {})) if (v.at !== undefined && v.at < first) first = v.at;
  const from = Math.max(now - RATE_DAYS * DAY, first);
  let hits = 0, total = 0;
  const days = new Map<string, boolean>();   // day -> every P1 that ended that day was a hit
  for (const v of Object.values(log?.e ?? {})) {
    if (v.m !== member || v.o === "open" || v.at === undefined || v.at > now + 60_000) continue;
    if (v.at >= from) { total++; if (v.o === "hit") hits++; }
    const d = dayKey(v.at, tz);
    days.set(d, (days.get(d) ?? true) && v.o === "hit");
  }
  let streak = 0;
  for (const d of [...days.keys()].sort().reverse()) { if (!days.get(d)) break; streak++; }
  return { hits, total, rate: total ? Math.round((hits / total) * 100) : null, streak, from };
}

// ---------- the board ----------
export interface P1Person { member: string; name: string; me: boolean; rows: P1Row[]; stats: P1Stats; place: number | null }
/** One row per person with a P1 now or a P1 counted, ranked: hit rate, then streak, then hits; fewer than RANK_MIN counted go
 *  below the ranked, without a place. Your own row is in it too ("You"). */
export function p1Board(i: { log: P1Log | null; copies: readonly CopyIn[]; members: readonly { id: string; name: string; me: boolean }[]; now: number; tz: string }): P1Person[] {
  const live = new Set(i.members.map((m) => m.id));
  const rows = p1Rows(i.copies.map((c) => ({ ...c, t: typeof c.t === "string" ? c.t : "" })), { me: "\u0000", live, now: i.now });
  const byMember = new Map<string, P1Row[]>();
  for (const r of rows) { const l = byMember.get(r.member) ?? []; l.push(r); byMember.set(r.member, l); }
  const out: P1Person[] = [];
  for (const m of i.members) {
    const stats = p1Stats(i.log, m.id, i.now, i.tz);
    const mine = byMember.get(m.id) ?? [];
    if (!mine.length && !stats.total && !stats.streak) continue;
    out.push({ member: m.id, name: m.me ? "You" : m.name, me: m.me, rows: mine.slice(0, 12), stats, place: null });
  }
  const ranked = (p: P1Person) => p.stats.total >= RANK_MIN;
  out.sort((a, b) => Number(ranked(b)) - Number(ranked(a)) || (b.stats.rate ?? -1) - (a.stats.rate ?? -1) || b.stats.streak - a.stats.streak
    || b.stats.hits - a.stats.hits || firstName(a.name).localeCompare(firstName(b.name)) || a.member.localeCompare(b.member));
  let place = 0;
  for (const p of out) if (ranked(p)) p.place = ++place;
  return out;
}

/** What the collapsed row shows on its right: the open P1 with the least time left (and how many more are open), else Missed, else
 *  a tick for one done lately, else nothing. */
export type Lead = { kind: "open"; left: number; more: number; row: P1Row } | { kind: "missed"; row: P1Row } | { kind: "done"; row: P1Row } | { kind: "none" };
export function leadOf(rows: readonly P1Row[], now: number): Lead {
  const open = rows.filter((r) => p1State(r, now).kind === "open").sort((a, b) => p1Deadline(a.s) - p1Deadline(b.s));
  if (open.length) return { kind: "open", left: p1Deadline(open[0].s) - now, more: open.length - 1, row: open[0] };
  const missed = rows.find((r) => p1State(r, now).kind === "missed");
  if (missed) return { kind: "missed", row: missed };
  const done = rows.find((r) => r.x);
  return done ? { kind: "done", row: done } : { kind: "none" };
}
/** The colour of a time left: green, amber under 8 hours, red only in the last 2 hours (and once it ran out). */
export function leftTone(leftMs: number): "ok" | "warn" | "bad" {
  return !(leftMs > RED_MS) ? "bad" : leftMs <= AMBER_MS ? "warn" : "ok";
}
/** "2h left" (the panel and the G Squad Tasks screen). */
export const leftWords = (leftMs: number) => `${leftText(leftMs)} left`;

/** How many people the panel shows (its own saved setting, missing = 5). */
export function rowsOf(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= ROWS_MIN ? Math.min(ROWS_MAX, Math.round(n)) : ROWS_DEF;
}

// ---------- the words on hover (every number says what it is) ----------
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDate(ts: number, tz: string): string { const w = wall(ts, validTz(tz) ? tz : "UTC"); return `${w.d} ${MONTHS[w.mo - 1]}`; }
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The window in words: "last 30 days", or "since 18 Nov (when this PS started counting)". */
export function windowWords(s: P1Stats, now: number, tz: string): string {
  return now - s.from >= RATE_DAYS * DAY - 60_000 ? `last ${RATE_DAYS} days` : `since ${shortDate(s.from, tz)} (when this PS started counting)`;
}
export function rateTip(p: Pick<P1Person, "me" | "name" | "stats">, now: number, tz: string): string {
  const s = p.stats, who = p.me ? "You" : firstName(p.name);
  if (s.rate === null) return `No hit rate yet: ${who === "You" ? "you have" : `${who} has`} no Priority 1 task finished or run out, ${windowWords(s, now, tz)}.`;
  return `${s.rate}%: ${who} finished ${s.hits} of ${plural(s.total, "Priority 1 task")} inside 24 hours, ${windowWords(s, now, tz)}.`;
}
export function streakTip(p: Pick<P1Person, "me" | "name" | "stats">): string {
  const s = p.stats, who = p.me ? "you" : firstName(p.name);
  if (!s.streak) return `No streak: the last day ${who} had a Priority 1 task, one ran out. A day with every one done inside 24 hours starts it again.`;
  return `${s.streak} day streak: every Priority 1 task done inside 24 hours, ${plural(s.streak, "day")} in a row. Days with no Priority 1 task do not break it.`;
}
export function placeTip(p: Pick<P1Person, "place" | "stats">): string {
  if (p.place === null) return `Not ranked yet: needs ${RANK_MIN} Priority 1 tasks finished or run out (has ${p.stats.total}).`;
  return `Place ${p.place}: ranked by hit rate, then streak.`;
}
export function leadTip(l: Lead, now: number): string {
  if (l.kind === "open") return `${leftWords(l.left)}: time left of the 24 hours for "${l.row.t}"${l.more ? `, and ${l.more} more open` : ""}.`;
  if (l.kind === "missed") return `Missed: the 24 hours for "${l.row.t}" ran out ${leftText(now - p1Deadline(l.row.s))} ago.`;
  if (l.kind === "done") return `Done: "${l.row.t}"`;
  return "No Priority 1 task open right now.";
}
export function headTip(log: P1Log | null, now: number, tz: string): string {
  const since = log ? ms(log.since) : now;
  return `Who finishes their Priority 1 tasks inside 24 hours. Ranked by hit rate, then streak. This PS counts since ${shortDate(since, tz)}.`;
}
