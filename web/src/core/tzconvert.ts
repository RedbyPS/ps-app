// The per zone converter in the time zone panel (V1.36): the developer hovers Pacific, types "2pm", picks a day,
// and sees what that is in his own zone. Pure functions, so tests/tzconvert.test.ts can check them.
// Daylight saving is worked out for the chosen day in both zones, including the two awkward nights:
// the spring night a wall time never happens, and the autumn night it happens twice.
import { ZONES, isRenamed, tagOf, zoneList, offsetMin, wall, type Wall } from "./tz.ts";

export type Typed = { h: number; mi: number; zone?: string };

// Words that name one of the panel's zones, so "2pm PT" or "9am eastern" work too.
const ZONE_WORDS: Record<string, string> = {
  pt: "America/Los_Angeles", pst: "America/Los_Angeles", pdt: "America/Los_Angeles", pacific: "America/Los_Angeles",
  et: "America/New_York", est: "America/New_York", edt: "America/New_York", eastern: "America/New_York",
  ct: "America/Chicago", cst: "America/Chicago", cdt: "America/Chicago", central: "America/Chicago",
  mt: "America/Denver", mst: "America/Denver", mdt: "America/Denver", mountain: "America/Denver",
  uk: "Europe/London", gmt: "Europe/London", bst: "Europe/London", london: "Europe/London",
};

/** "2pm", "2 pm", "14:00", "14.00", "14,00", "2:30pm", "1430", "930", "2.30 p.m.", "noon", "2pm PT". Null when it is not a time. */
export function parseTyped(text: string): Typed | null {
  let s = text.toLowerCase().replace(/(\d)\s*([ap])\.?\s*m\.?/g, "$1$2m").replace(/\s+/g, " ").trim();
  if (!s) return null;
  let zone: string | undefined;
  const zm = s.match(/\s*\b([a-z]+)(?: time)?$/);
  if (zm && ZONE_WORDS[zm[1]]) { zone = ZONE_WORDS[zm[1]]; s = s.slice(0, zm.index).trim(); }
  if (s === "noon" || s === "midday") return { h: 12, mi: 0, zone };
  if (s === "midnight") return { h: 0, mi: 0, zone };
  // PS 1.75 (Jan, 22 Nov 2026: "it didn't recognize 22.15 or 22,15"): a comma and a closing dot count too ("22,15", "22.15.").
  const m = s.replace(/^(\d{1,2}[:.,h]\d{2})\.$/, "$1").match(/^(\d{1,2})(?:\s?[:.,h]\s?(\d{2})|\s?(\d{2}))?\s*(am|pm|a|p)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = m[2] ?? m[3] ? Number(m[2] ?? m[3]) : 0;
  const ap = m[4]?.[0];
  if (mi > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap === "p" ? 12 : 0);
  } else if (h > 23) return null;
  return { h, mi, zone };
}

export type Ymd = { y: number; mo: number; d: number };
/** The calendar day it is now in a zone. */
export function todayIn(tz: string, now = Date.now()): Ymd {
  const w = wall(now, tz);
  return { y: w.y, mo: w.mo, d: w.d };
}
/** A calendar day moved by whole days (month and year ends handled). */
export function addDays(day: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(day.y, day.mo - 1, day.d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
/** Whole days from a to b (b - a). */
export function daysBetween(a: Ymd, b: Ymd) {
  return Math.round((Date.UTC(b.y, b.mo - 1, b.d) - Date.UTC(a.y, a.mo - 1, a.d)) / 86400000);
}

/** One answer: the real moment, the wall clock in the target zone, and the day it lands on there
 *  compared with the day typed (+1 = the next day). */
export type Hit = { ts: number; at: Wall; dayDiff: number };
export type Conversion =
  | { kind: "ok"; hit: Hit }
  // Autumn: clocks go back, so the time happens twice. first is the earlier one (still summer time).
  // jumpFrom and jumpTo are the wall clock either side of the change, in minutes after midnight
  // (2:00 goes back to 1:00 is 120 and 60).
  | { kind: "twice"; first: Hit; second: Hit; jumpFrom: number; jumpTo: number }
  // Spring: clocks jump forward, so the time never happens (2:00 jumps to 3:00 is 120 and 180).
  // hit is the typed time read as if the clocks had not jumped yet, which the clocks show as that
  // much later (2:30 reads as 3:30).
  | { kind: "missing"; jumpFrom: number; jumpTo: number; hit: Hit };

/** The clock change around a moment: the wall clock just before it and just after it. */
function jumpNear(ts: number, tz: string) {
  const before = offsetMin(ts - 86400000, tz), after = offsetMin(ts + 86400000, tz);
  let lo = ts - 86400000, hi = ts + 86400000;
  while (hi - lo > 60000) { const m = Math.floor((lo + hi) / 2); if (offsetMin(m, tz) === before) lo = m; else hi = m; }
  const at = Math.floor(hi / 60000) * 60000;   // changes happen on the minute
  const wallMin = (o: number) => { const d = new Date(at + o * 60000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  return { jumpFrom: wallMin(before), jumpTo: wallMin(after) };
}

/** A wall clock time on a day in one zone, in another zone. */
export function convertWall(day: Ymd, h: number, mi: number, from: string, to: string): Conversion {
  const guess = Date.UTC(day.y, day.mo - 1, day.d, h, mi);
  // The zone's offset a day either side: on an ordinary day they match; on a change day they are the
  // offsets before and after the change. Daylight saving changes are months apart, so this is safe.
  const offs = [...new Set([offsetMin(guess - 86400000, from), offsetMin(guess + 86400000, from), offsetMin(guess, from)])];
  const valid = offs.map((o) => guess - o * 60000).filter((ts) => offsetMin(ts, from) === (guess - ts) / 60000);
  const hit = (ts: number): Hit => {
    const at = wall(ts, to);
    return { ts, at, dayDiff: daysBetween(day, { y: at.y, mo: at.mo, d: at.d }) };
  };
  const uniq = [...new Set(valid)].sort((a, b) => a - b);
  if (uniq.length === 1) return { kind: "ok", hit: hit(uniq[0]) };
  if (uniq.length >= 2) {
    const a = uniq[0], b = uniq[uniq.length - 1];
    return { kind: "twice", first: hit(a), second: hit(b), ...jumpNear(a, from) };
  }
  // Never happens: before the jump the zone ran on the earlier offset, so read it with that one.
  const ts = guess - offsetMin(guess - 86400000, from) * 60000;
  return { kind: "missing", ...jumpNear(ts, from), hit: hit(ts) };
}

/** "+1 day", "-1 day", "+2 days", "" for the same day. */
export function dayTag(n: number) {
  if (!n) return "";
  return `${n > 0 ? "+" : "-"}${Math.abs(n)} day${Math.abs(n) === 1 ? "" : "s"}`;
}

/** The short name of a panel zone ("PT", or a short name of your own like "CET"), or "" for any other zone. */
export function zoneShort(tz: string) {
  const z = zoneList().find((x) => x.id === tz) ?? ZONES.find((x) => x.id === tz);
  return !z ? "" : isRenamed(z) && tagOf(z) === z.label ? z.label : z.short || "";
}
/** The name of a panel zone ("Pacific"), or the city for any other zone. */
export function zoneName(tz: string) { return (zoneList().find((z) => z.id === tz) ?? ZONES.find((z) => z.id === tz))?.label || tz.split("/").pop()!.replace(/_/g, " "); }

// ---------- scrolling the time (the developer, 7 Nov 2026) ----------
// Scroll over the hour and it moves an hour a notch; over the minutes, a quarter hour a notch (minutes
// off the quarter snap to it first: 2:07 goes up to 2:15 and down to 2:00). Up is later. Past midnight
// the day moves with it. What the developer typed keeps its look: "2pm" becomes "3pm", "14:00" becomes "15:00",
// "1430" becomes "1445", and a zone word at the end ("2pm PT") stays.

export type Part = "hour" | "min" | "half";
/** Minutes per notch over the minutes. */
export const MIN_STEP = 15;
/** Minutes per click of the small up and down arrows next to the typed time (and per arrow key), V1.65. */
export const HALF_STEP = 30;
const gridOf = (part: Part) => (part === "half" ? HALF_STEP : part === "min" ? MIN_STEP : 0);

/** A time moved by n hours or n quarter hours. snap: an hour step from an off the hour start lands on
 *  the hour (used when the box was empty and the start is the clock now). days: how many midnights it
 *  crossed (+1 = into the next day). */
export function shiftTime(h: number, mi: number, part: Part, n: number, snap = false): { h: number; mi: number; days: number } {
  const grid = gridOf(part) || (snap ? 60 : 0);
  let t = h * 60 + mi;
  if (grid && n) t = (n > 0 ? Math.floor(t / grid) : Math.ceil(t / grid)) * grid;
  t += n * (gridOf(part) || 60);
  const days = Math.floor(t / 1440);
  t -= days * 1440;
  return { h: Math.floor(t / 60), mi: t % 60, days };
}

/** Where the hour and the minutes sit in what the developer typed (character positions, end not included), and
 *  where the time itself ends (before any zone word). Null when it is not a time. */
export type Spans = { hour: [number, number]; min: [number, number] | null; end: number };
export function timeSpans(text: string): Spans | null {
  if (!parseTyped(text)) return null;
  const w = text.match(/noon|midday|midnight/i);
  if (w) return { hour: [w.index!, w.index! + w[0].length], min: null, end: w.index! + w[0].length };
  const m = text.match(/(\d{1,4})(?:(\s?[:.,h]\s?| )(\d{2}))?/i);
  if (!m) return null;
  const at = m.index!, run = m[1];
  let hour: [number, number], min: [number, number] | null = null;
  if (m[3]) { hour = [at, at + run.length]; const ms = at + run.length + m[2].length; min = [ms, ms + 2]; }
  else if (run.length >= 3) { hour = [at, at + run.length - 2]; min = [at + run.length - 2, at + run.length]; }
  else hour = [at, at + run.length];
  const after = at + m[0].length;
  const ap = text.slice(after).match(/^\s*[ap]\.?\s*(?:m\.?)?/i);
  return { hour, min, end: after + (ap ? ap[0].length : 0) };
}

/** How the developer wrote the time, so a stepped time keeps the same look. */
type Look = { h12: boolean; upper: boolean; space: boolean; m: boolean; sep: string; pad: boolean; hasMin: boolean; zone: string };
function lookOf(text: string): Look | null {
  const sp = timeSpans(text);
  if (!sp) return null;
  const core = text.slice(sp.hour[0], sp.end);
  const zone = text.slice(sp.end).replace(/\s+$/, "");
  if (/^(noon|midday|midnight)$/i.test(core)) return { h12: true, upper: false, space: false, m: true, sep: ":", pad: false, hasMin: false, zone };
  const ap = core.match(/(\s*)([ap])\.?\s*(m)?\.?$/i);
  const hourStr = text.slice(sp.hour[0], sp.hour[1]);
  const sep = sp.min ? text.slice(sp.hour[1], sp.min[0]) : ":";
  return {
    h12: !!ap, upper: !!ap && ap[2] === ap[2].toUpperCase(), space: !!ap && ap[1].length > 0, m: !ap || !!ap[3],
    sep, pad: hourStr.length === 2 && hourStr[0] === "0", hasMin: !!sp.min, zone,
  };
}

function writeTime(h: number, mi: number, k: Look) {
  const mm = String(mi).padStart(2, "0");
  if (k.h12) {
    const ap = (h < 12 ? "a" : "p") + (k.m ? "m" : "");
    return `${h % 12 || 12}${k.hasMin ? k.sep + mm : ""}${k.space ? " " : ""}${k.upper ? ap.toUpperCase() : ap}${k.zone}`;
  }
  const hh = k.pad || (k.sep === "" && h === 0) ? String(h).padStart(2, "0") : String(h);
  return `${hh}${k.hasMin ? k.sep + mm : ""}${k.zone}`;
}

/** One scroll step on what the developer typed: the new text and the midnights it crossed. When the box is
 *  empty (or not a time yet) it starts from start (the clock now in that zone), written in the clock
 *  style the panel uses (h12). Null when there is nothing to start from. */
export function stepTyped(text: string, part: Part, n: number, start?: { h: number; mi: number; h12: boolean }): { text: string; days: number } | null {
  const typed = parseTyped(text);
  const look = typed ? lookOf(text) : null;
  if (typed && look) {
    const r = shiftTime(typed.h, typed.mi, part, n);
    return { text: writeTime(r.h, r.mi, { ...look, hasMin: look.hasMin || part !== "hour" || r.mi !== 0 }), days: r.days };
  }
  if (!start || text.trim()) return null;
  const r = shiftTime(start.h, start.mi, part, n, true);
  const k: Look = { h12: start.h12, upper: false, space: false, m: true, sep: ":", pad: false, hasMin: !start.h12 || r.mi !== 0, zone: "" };
  return { text: writeTime(r.h, r.mi, k), days: r.days };
}

/** Which part a character position points at: the minutes (and the am or pm after them) or the hour
 *  (everything else, empty space included, so scrolling anywhere on the box moves the hour). */
export function partAt(text: string, pos: number): Part {
  const sp = timeSpans(text);
  if (!sp || pos < sp.hour[1] || pos >= sp.end) return "hour";
  return "min";
}

// A wheel or trackpad turned into steps. A mouse notch is one step (a fast spin can arrive as one event
// worth several notches, and moves that many). A trackpad, or a Magic Mouse, sends a stream of small pixel
// moves that keeps going after the fingers lift, so: the first move of a gesture steps at once, then they
// add up and step every WHEEL_PX, at most one step every WHEEL_MS, so one swipe never fires dozens of
// steps. A pause of WHEEL_GAP starts a new gesture.
export const WHEEL_PX = 60, WHEEL_MS = 50, WHEEL_GAP = 220;
export type Wheel = { acc: number; last: number; lastStep: number };
export const newWheel = (): Wheel => ({ acc: 0, last: -1e9, lastStep: -1e9 });
/** How many mouse notches one wheel event is: lines or pages (Firefox) are one; Chrome sends 100 px a
 *  notch, so a whole multiple of 100 is that many (at most 5). 0 means a smooth pixel scroll. */
export function notchesOf(delta: number, mode: number): number {
  if (!delta) return 0;
  if (mode !== 0) return 1;
  return Number.isInteger(delta) && delta % 100 === 0 ? Math.min(5, Math.abs(delta) / 100) : 0;
}
/** v: how far it moved towards later. notches: from notchesOf. Returns the steps to take (signed). */
export function wheelStep(s: Wheel, v: number, t: number, notches = 0): number {
  if (!v) return 0;
  const fresh = t - s.last > WHEEL_GAP;
  s.last = t;
  const dir = Math.sign(v);
  if (notches) { s.acc = 0; s.lastStep = t; return dir * notches; }
  if (fresh && Math.abs(v) >= 4) { s.acc = 0; s.lastStep = t; return dir; }
  if (fresh) s.acc = dir * WHEEL_PX * 0.7;                    // a feather light start: a little more to go
  else if (dir !== Math.sign(s.acc)) s.acc = 0;               // turned round: start again that way
  s.acc += v;
  if (Math.abs(s.acc) < WHEEL_PX) return 0;
  if (t - s.lastStep < WHEEL_MS) { s.acc = dir * Math.min(Math.abs(s.acc), WHEEL_PX); return 0; }
  s.acc -= dir * WHEEL_PX;
  s.lastStep = t;
  return dir;
}

/** The phone: a finger dragged up the time moves it later, one step every DRAG_PX. done is the steps
 *  already taken in this drag; returns the steps to take now. */
export const DRAG_PX = 26;
export function dragSteps(dyUp: number, done: number): number {
  return Math.trunc(dyUp / DRAG_PX) - done;
}
