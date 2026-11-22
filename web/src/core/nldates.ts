// Dates in plain words (PS 1.65, the developer's request for 1.65: "In every place a task is added (Quick add, the Add task window,
// the phone, the website), typing a date or repeat in plain words sets it ... The recognised words light up as a small chip
// while typing, the date and repeat fill in, and the words come out of the title. Clicking the chip undoes it, so a title
// like 'Friday deck' can stay as typed. Parsed offline on the device, in the person's own time zone. English first.")
//
// ONE parser for every place a task is typed or spoken. Pure: no DOM, no network, no clock of its own (the caller passes
// `now`), so tests/nldates.test.ts runs it as it is and the voice capture builder calls the same function.
//
// ---------------------------------------------------------------------------------------------------------------------
// THE API
//
//   parseTaskText(text, now, tz, opts?) -> ParsedTask | null
//
//   text  what was typed or said, for example "call the bank tomorrow at 10" or "gym every weekday 7am".
//   now   the moment to read it from: a Date or epoch ms (Date.now()).
//   tz    the person's IANA time zone, for example "Asia/Dubai" (PS: core/overdue.ts overdueZone(settings.tmHomeTz)).
//   opts  { dayEndsHour?: number   PS settings.dayEndsHour. A night owl's "tomorrow" typed before min(dayEndsHour, 5)
//                                  o'clock means the day that is starting, not the one after it. 0 or left out: midnight.
//           dayFirst?: boolean     "4/12" is 4 December (true) or 12 April (false, the default). Only after on, by or due,
//                                  or with a year ("4/12/2027"), so "1/2 cup" stays text.
//           hour12?: boolean       the chip says "9am" instead of "09:00".
//           keep?: string[]        phrases (lower case, as in a hit's `raw`) to leave as text: the ones the person said no to. }
//
//   Returns null when nothing in the text is a date, time or repeat. Otherwise:
//     title   the text with the recognised words taken out and the spacing tidied ("call the bank").
//     hits    where each recognised phrase sits in `text` ([start, end), `raw` as typed), to paint it.
//     kind    "once" (a one-off task), "daily" (PS's Every day task) or "repeat" (a longer repeat).
//     due     "YYYY-MM-DD" the day it is due: a one-off's date, a repeat's first round. Null for "daily", and for a
//             one-off with no date. Dates are wall dates in `tz`, so a daylight saving change never moves them.
//     time    "HH:MM" (24 hour, in `tz`) when a time was given, else null. PS keeps a task's time as a reminder on the
//             task (core/remind.ts): reminderOf(result) says when it pops up.
//     repeat  PS's rule (core/repeat.ts Repeat: every, unit, from, and days for a weekly rule on several days) when kind
//             is "repeat", else null. Ready to save: due is its first round.
//     label   the chip's words: "Tomorrow, 10:00", "Fri 21 Nov", "Every other Fri, 15:00", "Every weekday, 07:00".
//     key     names this suggestion; it stays the same while the rest of the title is typed around it.
//
// Only one date, one time and one repeat are taken (the last of each); any other date words stay in the title.
// The chip's state (said no, a pick in Advanced wins) is NlState below; views/NlDates.tsx draws it.
// ---------------------------------------------------------------------------------------------------------------------
//
// The rules, in plain words (the tests hold the full list):
// - "today", "tomorrow" (and tmrw, tmr, tomorow, tommorow), "the day after tomorrow".
// - A day name: the next one, today counting ("Friday" on a Friday is today). "this Friday" the same. "next Friday" the
//   next one after today (never today). "Friday after next" a week after that. "Friday next week" the Friday of next week.
//   Short names that are also words (mon, wed, sat, sun) count only after on, by, due, this or next.
// - "next week" next Monday, "next month" the 1st of next month, "next year" 1 January, "this weekend" or "the weekend"
//   Saturday (today on a Saturday or Sunday), "next weekend" the Saturday of next week.
// - "in 3 days", "in two weeks", "in a month", "in 2 hours", "in 30 min", "in half an hour", "in 3 working days",
//   "3 days from now", "a week from today". Hours and minutes count real time, so they are right across a clock change.
// - "end of the week" Friday, "end of the month", "end of next month", "end of the year", "start of next month", eom, eow,
//   eoy, "end of day" and eod (today).
// - "on the 15th", "by the 3rd", "the 15th of next month": the next such day that exists ("on the 31st" in November is
//   31 December). "March 3", "3 March", "3rd of March", "Mar 3 2027": without a year, the next one (today counting).
//   "2026-12-01". "on 4/12".
// - Times: "9am", "9:30pm", "5p", "at 5", "at 17:00", "9:30", "noon", "midnight" (23:59 of that day), "5 o'clock",
//   "this morning" (09:00), "tomorrow afternoon" (14:00), "in the evening" (18:00), "tonight". A time with no am or pm:
//   1 to 6 is afternoon, 7 to 11 morning, unless "morning", "evening" or "tonight" says otherwise. A time with no day:
//   today, or tomorrow once it has passed ("at 9" at 10am is 21:00 today).
// - Repeats: "every day", "daily", "every other day", "every 3 days", "every week", "weekly", "every Monday", "every other
//   Friday", "every second Friday", "biweekly", "fortnightly", "every Mon and Thu", "every weekday", "weekdays", "every
//   weekend", "mondays", "every month", "monthly", "every 15th", "every month on the 15th", "the 1st of every month",
//   "every quarter", "every year", "yearly", "every March 3", "every morning" (and the rest with a time). "starting
//   Monday" or another date sets when a repeat starts.
// - Not taken, left as text: "every first Monday of the month", "every last Friday", "every hour", "last Friday",
//   "every now and then", a bare number, a bare month name, "may", "1/2".
import { DEVICE_TZ, validTz, wall } from "./tz.ts";
import { newTaskReminder, type Reminder } from "./remind.ts";
import { daysLabel, nextAfter, plusDays, plusMonths, type Repeat, type RepeatDraft, type RepeatUnit } from "./repeat.ts";
import type { AddOpts } from "./quickadd.ts";

export type NlKind = "once" | "daily" | "repeat";
export interface NlHit { start: number; end: number; raw: string; part: "date" | "time" | "repeat" }
export interface ParsedTask {
  title: string;
  hits: NlHit[];
  kind: NlKind;
  due: string | null;
  time: string | null;
  repeat: Repeat | null;
  label: string;
  key: string;
}
/** `numDates` (PS 1.75, only while "scheduled-tasks" is on, views/NlDates.tsx): also read dates typed in numbers with nothing
 *  around them ("25.11", "25/11", "25 11", "the 25th"). Off: exactly the 1.74 forms. */
export interface NlOpts { dayEndsHour?: number; dayFirst?: boolean; hour12?: boolean; keep?: readonly string[]; today?: string; numDates?: boolean }

/** A "tomorrow" typed before this hour (or the person's work day end, if earlier) means the day that is starting. */
export const NIGHT_MAX = 5;
/** Part of the day times. */
export const PART_TIMES: Record<string, [number, number]> = { morning: [9, 0], afternoon: [14, 0], evening: [18, 0], night: [21, 0] };

// ---------- small date helpers on "YYYY-MM-DD" ----------
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const ymd = (s: string) => s.split("-").map(Number) as [number, number, number];
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const weekdayOf = (s: string) => { const [y, m, d] = ymd(s); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
/** The first day on or after `from` that is this day of the week. */
const onOrAfter = (from: string, wd: number) => plusDays(from, (wd - weekdayOf(from) + 7) % 7);
const mondayOf = (s: string) => plusDays(s, -((weekdayOf(s) + 6) % 7));
const endOfMonth = (s: string) => { const [y, m] = ymd(s); return iso(y, m, daysIn(y, m)); };
const firstOfNextMonth = (s: string) => { const [y, m] = ymd(s); return m === 12 ? iso(y + 1, 1, 1) : iso(y, m + 1, 1); };
/** The next day `dom` of a month, on or after `from`, in a month that has it. */
function nextDom(from: string, dom: number): string | null {
  if (dom < 1 || dom > 31) return null;
  let [y, m, d] = ymd(from);
  if (d > dom) { m++; if (m > 12) { m = 1; y++; } }
  for (let i = 0; i < 13; i++) {
    if (dom <= daysIn(y, m)) return iso(y, m, dom);
    m++; if (m > 12) { m = 1; y++; }
  }
  return null;
}
/** Month `m` day `d` on or after `from` (a year that has it: 29 February waits for a leap year). */
function nextMonthDay(from: string, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const [fy] = ymd(from);
  for (let y = fy; y < fy + 9; y++) {
    if (d > daysIn(y, m)) continue;
    const s = iso(y, m, d);
    if (s >= from) return s;
  }
  return null;
}
const plusWorkDays = (from: string, n: number) => {
  let d = from;
  while (n > 0) { d = plusDays(d, 1); const w = weekdayOf(d); if (w !== 0 && w !== 6) n--; }
  return d;
};

// ---------- words ----------
const WD_NAMES: [string, number, boolean][] = [
  // name, day, needs a word before it (also an ordinary English word)
  ["sunday", 0, false], ["sun", 0, true], ["sundy", 0, false],
  ["monday", 1, false], ["mon", 1, true], ["mondy", 1, false],
  ["tuesday", 2, false], ["tues", 2, false], ["tue", 2, false], ["tuseday", 2, false], ["tusday", 2, false],
  ["wednesday", 3, false], ["weds", 3, false], ["wed", 3, true], ["wensday", 3, false], ["wednsday", 3, false], ["wedensday", 3, false], ["wedsday", 3, false],
  ["thursday", 4, false], ["thurs", 4, false], ["thur", 4, false], ["thu", 4, false], ["thrusday", 4, false], ["thurday", 4, false], ["thursady", 4, false],
  ["friday", 5, false], ["fri", 5, false], ["firday", 5, false], ["fridy", 5, false],
  ["saturday", 6, false], ["sat", 6, true], ["saterday", 6, false], ["saturady", 6, false],
];
const WD = new Map(WD_NAMES.map(([n, d, s]) => [n, { d, strict: s }]));
const alt = (xs: string[]) => [...xs].sort((a, b) => b.length - a.length).join("|");
const WD_RE = alt(WD_NAMES.map((x) => x[0]));
const WD_PLURAL_RE = alt(WD_NAMES.filter((x) => !x[2] && x[0].endsWith("day")).map((x) => `${x[0]}s`));

const MONTHS: [string, number][] = [
  ["january", 1], ["jan", 1], ["february", 2], ["febuary", 2], ["feb", 2], ["march", 3], ["mar", 3], ["april", 4], ["apr", 4],
  ["may", 5], ["june", 6], ["jun", 6], ["july", 7], ["jul", 7], ["august", 8], ["aug", 8], ["september", 9], ["sept", 9], ["sep", 9],
  ["october", 10], ["oct", 10], ["november", 11], ["nov", 11], ["december", 12], ["dec", 12],
];
const MO = new Map(MONTHS);
const MO_RE = alt(MONTHS.map((x) => x[0]));

const NUM_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, "a couple of": 2, "couple of": 2, "a couple": 2, "a few": 3, few: 3 };
const NUM_RE = String.raw`(\d{1,3}|a couple of|couple of|a couple|a few|few|an|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;
const numOf = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUM_WORDS[s] ?? NaN);
const EVERY_N: Record<string, number> = { other: 2, second: 2, "2nd": 2, third: 3, "3rd": 3, fourth: 4, "4th": 4 };
const EVERY_N_RE = String.raw`(other|second|2nd|third|3rd|fourth|4th|\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;
const everyN = (s: string | undefined) => (!s ? 1 : EVERY_N[s] ?? numOf(s));
const ORD_WORDS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, fifteenth: 15, twentieth: 20, thirtieth: 30 };
const ORD_RE = String.raw`(\d{1,2})(?:st|nd|rd|th)|(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|fifteenth|twentieth|thirtieth)`;
const ordOf = (num: string | undefined, word: string | undefined) => (num ? Number(num) : word ? ORD_WORDS[word] : NaN);

const TOMORROW_RE = "tomorrow|tomorow|tommorow|tommorrow|tommorw|tomorro|tmrw|tmrrw|tmr|tmw|2moro|2morrow";
// Before and after every phrase: not inside a word, a number, a link or an address; and not "Friday's".
const B = String.raw`(?<![\p{L}\p{N}_/#.@\-])`;
// "on the 3rd floor" is a place, not a date.
const NOT_PLACE = String.raw`(?!\s+(?:floor|place|time|try|attempt|round|row|page|step|grade|level|street|st|avenue|ave|edition|anniversary|birthday|year|person|one|item|line|option|draft|version|chapter|lesson|week|day|month))`;
// A number with a unit or a currency after it is an amount, not a date ("25.11 kg", "12.10 EUR", "25/11 %").
const NOT_UNIT = String.raw`(?!\s*(?:%|\u20ac|\$|\u00a3|\u00b0|(?:eur|euro|euros|usd|gbp|czk|kc|kg|g|km|m|cm|mm|ml|l|lb|lbs|oz|h|hrs?|hours?|mins?|minutes?|x|percent|pct|points?|pts|pages?|people|persons?|pcs|pieces?|times|kcal|cal|kb|mb|gb|tb|mph|kmh|kph)(?![\p{L}])))`;
// Break-it 1.75: a bare number pair after a word that counts or names a number is not a date ("score 26.10", "page 25.10",
// "team of 25 12", "line 29 11", "chapter 25 11", "age 28 12"), nor one end of a range ("25.11-28.11" stays text).
const NOT_COUNT = String.raw`(?<!(?:^|[^\p{L}])(?:score|scores|page|pages|pg|p|chapter|chapters|ch|line|lines|room|rm|age|aged|grade|level|lvl|bus|tram|flight|train|route|version|ver|v|rate|ratio|team|of|to|set|sets|vote|votes|size|step|steps|track|seat|row|gate|platform|weight|price|total|sum|rank|round|table|code|pin|no|nr|number|apt|flat|unit|item|items|qty|x|reps|lap|laps|hole|holes|bib|verse|psalm|exercise|ex|question|q|task|issue|ticket|order|invoice|ref|id)\s+)(?<!\d\s?[-\u2013]\s?)`;
const NOT_RANGE = String.raw`(?!\s?[-\u2013]\s?\d)`;
const E = String.raw`(?![\p{L}\p{N}_])(?![.@/][\p{L}\p{N}])(?!['\u2019]s(?![\p{L}]))`;
const PRE = String.raw`(?:(?:on|by|due|for|until|till|before|starting|start|from|beginning|commencing)\s+(?:on\s+|from\s+)?)?`;

// ---------- candidates ----------
type Time = { h: number; mi: number; sure: boolean };
type RepSpec = { every: number; unit: RepeatUnit; wd?: number; days?: number[]; dom?: number; md?: [number, number]; daily?: boolean };
type Cand = {
  start: number; end: number;
  part: "date" | "time" | "repeat" | "block";
  date?: string;                 // a date
  time?: Time;                   // a time
  bias?: "am" | "pm";            // morning or evening words: how to read a time with no am or pm
  ms?: number;                   // "in 2 hours": real time from now
  rep?: RepSpec;
  dt?: boolean;                  // "in 2 hours": the date and the exact time, no other time is taken
  afterDate?: boolean;           // "morning" only right after a date or repeat ("tomorrow morning", "every Friday evening")
};

type Ctx = { today: string; tomorrow: string; nowH: number; nowMi: number; nowMs: number; tz: string; opts: NlOpts };

function scan(lower: string, re: RegExp, fn: (m: RegExpExecArray) => Omit<Cand, "start" | "end"> | null, out: Cand[]) {
  re.lastIndex = 0;
  for (let m = re.exec(lower); m; m = re.exec(lower)) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    const c = fn(m);
    if (c) out.push({ ...c, start: m.index, end: m.index + m[0].length });
  }
}
const rx = (s: string) => new RegExp(`${B}(?:${s})${E}`, "gu");

function weekdayDate(c: Ctx, wd: number, mode: string | undefined, suffix: string | undefined): string {
  const m = (mode || "").replace(/\s+/g, " ");
  const suf = (suffix || "").trim().replace(/\s+/g, " ");
  if (suf === "next week") return plusDays(mondayOf(c.today), 7 + ((wd + 6) % 7));
  if (suf === "this week") return plusDays(mondayOf(c.today), (wd + 6) % 7);
  let d = m === "next" || m === "the following" || m === "following" ? onOrAfter(plusDays(c.today, 1), wd) : onOrAfter(c.today, wd);
  if (suf === "after next") d = plusDays(d, 7);
  return d;
}

function gather(lower: string, c: Ctx): Cand[] {
  const out: Cand[] = [];
  const t = c.today;

  // ----- blockers: things PS cannot keep, left as text (and nothing inside them is taken) -----
  scan(lower, rx(String.raw`(?:(?:every|each)\s+)?(?:first|1st|second|2nd|third|3rd|fourth|4th|last)\s+(?:${WD_RE})s?\s+(?:of|in)\s+(?:the|each|every|this|next|a)\s+month`), () => ({ part: "block" }), out);
  scan(lower, rx(String.raw`(?:every|each)\s+(?:first|1st|third|3rd|fourth|4th|last)\s+(?:${WD_RE})s?`), () => ({ part: "block" }), out);
  scan(lower, rx(String.raw`(?:every|each)\s+(?:\d+\s+|other\s+|few\s+|couple\s+of\s+)?(?:hours?|hrs?|minutes?|mins?|seconds|secs|now|time|one\s+of)`), () => ({ part: "block" }), out);
  scan(lower, rx(String.raw`(?:last|past|previous)\s+(?:${WD_RE}|week|month|year|night|weekend)`), () => ({ part: "block" }), out);
  scan(lower, rx(String.raw`yesterday`), () => ({ part: "block" }), out);
  scan(lower, rx(String.raw`(?:except|but\s+not|excluding|apart\s+from|not\s+on)\s+(?:on\s+)?(?:${WD_RE})s?`), () => ({ part: "block" }), out);
  scan(lower, rx(String.raw`(?<!(?:every|each)\s+)(?:the\s+)?(?:first|1st|second|2nd|third|3rd|fourth|4th|last)\s+(?:${WD_RE})s?`), () => ({ part: "block" }), out);

  // ----- dates -----
  scan(lower, rx(String.raw`${PRE}today`), () => ({ part: "date", date: t }), out);
  scan(lower, rx(String.raw`${PRE}(?:${TOMORROW_RE})`), () => ({ part: "date", date: c.tomorrow }), out);
  scan(lower, rx(String.raw`${PRE}(?:the\s+)?day\s+after\s+(?:${TOMORROW_RE})|overmorrow`), () => ({ part: "date", date: plusDays(c.tomorrow, 1) }), out);
  scan(lower, rx(String.raw`tonight|tonite`), () => ({ part: "date", date: t, bias: "pm" }), out);
  scan(lower, rx(String.raw`this\s+(morning|afternoon|evening)`), (m) => {
    const [h, mi] = PART_TIMES[m[1]];
    return { part: "date", date: t, time: { h, mi, sure: true }, bias: m[1] === "morning" ? "am" : "pm" };
  }, out);
  // Day names.
  scan(lower, rx(String.raw`${PRE}(?:(this\s+coming|this|coming|next|the\s+following|following|the)\s+)?(${WD_RE})(\s+after\s+next|\s+next\s+week|\s+this\s+week)?`), (m) => {
    const w = WD.get(m[2]);
    if (!w) return null;
    // "sat", "sun", "wed", "mon" alone are words; with a word before or a time after ("wed 5pm") they are days.
    if (w.strict && m[0].trim().length === m[2].length && !/^\s*,?\s*(?:at\s+|@\s*)?\d/.test(m.input.slice(m.index + m[0].length))) return null;
    if (m[1] === "the" && !m[3]) return null;                          // "the sun"
    return { part: "date", date: weekdayDate(c, w.d, m[1], m[3]) };
  }, out);
  scan(lower, rx(String.raw`${PRE}(?:the\s+)?(next|this|coming)\s+(week|weekend|month|year)`), (m) => {
    const [mode, what] = [m[1], m[2]];
    if (what === "week") return mode === "next" ? { part: "date", date: plusDays(mondayOf(t), 7) } : null;
    if (what === "weekend") {
      const sat = weekdayOf(t) === 0 ? t : onOrAfter(t, 6);
      return { part: "date", date: mode === "next" ? plusDays(mondayOf(t), 12) : sat };
    }
    if (what === "month") return mode === "next" ? { part: "date", date: firstOfNextMonth(t) } : null;
    return mode === "next" ? { part: "date", date: iso(ymd(t)[0] + 1, 1, 1) } : null;
  }, out);
  scan(lower, rx(String.raw`(?:on|at|over|for|by)\s+(?:the\s+)?weekend`), () => ({ part: "date", date: weekdayOf(t) === 0 ? t : onOrAfter(t, 6) }), out);
  // In 3 days, in 2 hours.
  scan(lower, rx(String.raw`(?:in|within)\s+${NUM_RE}\s+(?:(business|working|work)\s+)?(days?|weeks?|wks?|months?|mos?|years?|yrs?|hours?|hrs?|h|minutes?|mins?)`), (m) => {
    const n = numOf(m[1]);
    if (!Number.isFinite(n) || n < 1 || n > 999) return null;
    return amount(c, n, m[3], !!m[2]);
  }, out);
  scan(lower, rx(String.raw`in\s+(?:half\s+an\s+hour|a\s+half\s+hour|an\s+hour\s+and\s+a\s+half)`), (m) => amount(c, m[0].includes("and a half") ? 90 : 30, "minutes", false), out);
  scan(lower, rx(String.raw`${NUM_RE}\s+(days?|weeks?|months?|years?)\s+from\s+(now|today|(?:${TOMORROW_RE}))`), (m) => {
    const n = numOf(m[1]);
    if (!Number.isFinite(n) || n < 1 || n > 999) return null;
    const base = m[3] === "now" || m[3] === "today" ? t : c.tomorrow;
    return { part: "date", date: addUnit(base, n, m[2]) };
  }, out);
  // End of, start of.
  scan(lower, rx(String.raw`(?:(?:by|at|on|before|until)\s+)?(?:the\s+)?end\s+of\s+(?:the\s+|this\s+)?(next\s+)?(day|week|month|year|quarter)|eod|eow|eom|eoy|cob|close\s+of\s+business`), (m) => {
    const w = m[0];
    const next = !!m[1];
    const what = m[2] ?? (w.endsWith("eod") || w === "cob" || w.includes("business") ? "day" : w === "eow" ? "week" : w === "eom" ? "month" : "year");
    if (what === "day") return next ? null : { part: "date", date: t };
    if (what === "week") {
      const fri = onOrAfter(t, 5);   // on a Saturday or Sunday: the coming Friday
      return { part: "date", date: next ? plusDays(fri, 7) : fri };
    }
    if (what === "month") return { part: "date", date: next ? endOfMonth(firstOfNextMonth(t)) : endOfMonth(t) };
    if (what === "quarter") {
      const [y, mo] = ymd(t); const qEnd = Math.ceil(mo / 3) * 3 + (next ? 3 : 0);
      const yy = y + Math.floor((qEnd - 1) / 12), mm = ((qEnd - 1) % 12) + 1;
      return { part: "date", date: iso(yy, mm, daysIn(yy, mm)) };
    }
    const y = ymd(t)[0] + (next ? 1 : 0);
    return { part: "date", date: iso(y, 12, 31) };
  }, out);
  scan(lower, rx(String.raw`(?:(?:by|at|on)\s+)?(?:the\s+)?(?:start|beginning)\s+of\s+(?:the\s+)?next\s+(week|month|year)`), (m) => ({
    part: "date", date: m[1] === "week" ? plusDays(mondayOf(t), 7) : m[1] === "month" ? firstOfNextMonth(t) : iso(ymd(t)[0] + 1, 1, 1),
  }), out);
  // Month and day.
  scan(lower, rx(String.raw`${PRE}(?:(${MO_RE})\.?\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?|(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${MO_RE}))(?:,?\s+(\d{4}))?`), (m) => {
    const mo = MO.get(m[1] ?? m[4])!, d = Number(m[2] ?? m[3]);
    const y = m[5] ? Number(m[5]) : null;
    if (y !== null) return d >= 1 && d <= daysIn(y, mo) ? { part: "date", date: iso(y, mo, d) } : null;
    const date = nextMonthDay(t, mo, d);
    return date ? { part: "date", date } : null;
  }, out);
  // On the 15th.
  scan(lower, rx(String.raw`(?:(on|by|due|for|before|until|starting|from)\s+)(?:the\s+)?(?:${ORD_RE})(?:\s+of\s+(?:the|this)\s+month)?${NOT_PLACE}|(?:the\s+)?(?:${ORD_RE})\s+of\s+(the|this|next)\s+month`), (m) => {
    const dom = ordOf(m[2] ?? m[4], m[3] ?? m[5]);
    if (!Number.isFinite(dom)) return null;
    if (m[6] === "next") { const f = firstOfNextMonth(t); const [y, mo] = ymd(f); return dom <= daysIn(y, mo) ? { part: "date", date: iso(y, mo, dom) } : null; }
    const date = nextDom(t, dom);
    return date ? { part: "date", date } : null;
  }, out);
  // 2026-12-01, on 4/12, 4/12/2027.
  scan(lower, rx(String.raw`${PRE}(\d{4})-(\d{2})-(\d{2})`), (m) => {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo) ? { part: "date", date: iso(y, mo, d) } : null;
  }, out);
  const num = c.opts.numDates === true;
  scan(lower, num ? rx(String.raw`(?<![$\u20ac\u00a3\u00a5])${NOT_COUNT}(?:(on|by|due|for|until)\s+)?(\d{1,2})/(\d{1,2})(?:/(\d{4}|\d{2}))?${NOT_UNIT}${NOT_RANGE}`)
    : rx(String.raw`(?:(on|by|due|for|until)\s+)?(\d{1,2})/(\d{1,2})(?:/(\d{4}|\d{2}))?`), (m) => {
    const a = Number(m[2]), b = Number(m[3]);
    // PS 1.75 (numDates): "25/11" alone is a date when one number is over 12 (so it cannot be a fraction like 1/2), never "24/7".
    if (!m[1] && !m[4] && !(num && (a > 12 || b > 12) && a <= 31 && b <= 31 && !(a === 24 && b === 7))) return null;
    let mo = c.opts.dayFirst ? b : a, d = c.opts.dayFirst ? a : b;
    if (mo > 12 && d <= 12) [mo, d] = [d, mo];
    if (mo < 1 || mo > 12 || d < 1) return null;
    if (m[4]) { const y = m[4].length === 2 ? 2000 + Number(m[4]) : Number(m[4]); return d <= daysIn(y, mo) ? { part: "date", date: iso(y, mo, d) } : null; }
    const date = nextMonthDay(t, mo, d);
    return date ? { part: "date", date } : null;
  }, out);

  // PS 1.75 (Jan, 22 Nov 2026: "if we just type some number like a date, it should work as well"): day first with dots,
  // "25.11", "25.11.", "25.11.2026", and "25 11". Alone (no on, by or year, no closing dot) only when it cannot be a time or a
  // decimal: the day is 24 or more and the month has two digits ("25.11"; "22.15", "10.30", "9.30", "2.5" stay as they are).
  if (num) scan(lower, rx(String.raw`(?<![$\u20ac\u00a3\u00a5])${NOT_COUNT}(?:(on|by|due|for|until|before|starting|from)\s+)?(\d{1,2})\.(\d{1,2})(?:(\.)(\d{4})?)?${NOT_UNIT}${NOT_RANGE}`), (m) => {
    const d = Number(m[2]), mo = Number(m[3]);
    const sure = !!m[1] || !!m[4];
    if (!sure && !(d >= 24 && m[3].length === 2)) return null;
    if (mo < 1 || mo > 12 || d < 1) return null;
    if (m[5]) { const y = Number(m[5]); return d <= daysIn(y, mo) ? { part: "date", date: iso(y, mo, d) } : null; }
    const date = nextMonthDay(t, mo, d);
    return date ? { part: "date", date } : null;
  }, out);
  // "25 11": with on or by, or alone at the very end with a day over 12 ("gym 25 11"), never in the middle of numbers.
  if (num) scan(lower, rx(String.raw`(?<![$\u20ac\u00a3\u00a5\d]\s?)${NOT_COUNT}(?:(on|by|due|for|until|from)\s+)?(\d{1,2})\s(\d{1,2})(?=\s*$)`), (m) => {
    const d = Number(m[2]), mo = Number(m[3]);
    if (!m[1] && (d < 13 || (d === 24 && mo === 7))) return null;
    if (mo < 1 || mo > 12 || d < 1) return null;
    const date = nextMonthDay(t, mo, d);
    return date ? { part: "date", date } : null;
  }, out);
  // "the 25th" alone, at the end or before a time or a comma ("pay rent the 25th", "the 3rd at 10"); "the 3rd floor" stays.
  if (num) scan(lower, rx(String.raw`the\s+(\d{1,2})(?:st|nd|rd|th)(?=\s*(?:$|[,;!?)]|\.(?!\S)|(?:at\s+|@\s*)?\d))`), (m) => {
    const date = nextDom(t, Number(m[1]));
    return date ? { part: "date", date } : null;
  }, out);

  // ----- times -----
  // A range ("3-4pm", "10am to 11am", "from 9 to 5"): its start.
  scan(lower, rx(String.raw`(?:(?:from|at|@)\s*)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*(?:-|to|until|till|\u2013)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?`), (m) => {
    if (!m[3] && !m[6] && !/^(from|at|@)/.test(m[0])) return null;   // "1-2" or "2 to 3" alone: not a time
    let h = Number(m[1]); const mi = m[2] ? Number(m[2]) : 0, h2 = Number(m[4]);
    if (h > 23 || mi > 59 || h2 > 23 || (m[5] && Number(m[5]) > 59)) return null;
    // "3-4pm": the pm is the start's too; "11-1pm" starts in the morning.
    const ap = m[3] ?? (m[6] && h <= 12 && h2 <= 12 && h < (h2 % 12 || 12) ? m[6] : m[6] === "pm" ? "am" : undefined);
    if (ap) { if (h < 1 || h > 12) return null; if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0; }
    // "from 9 to 5" with no am or pm: a working day, from the morning.
    return { part: "time", time: { h, mi, sure: !!ap || h === 0 || h >= 13 || (h < 12 && h > h2) } };
  }, out);
  scan(lower, rx(String.raw`(?:(?:at|@|by|around)\s*)?(\d{1,2})(?:[:.](\d{2}))?(?:\s*(a\.m\.|p\.m\.|am|pm)|(a|p))`), (m) => {
    let h = Number(m[1]); const mi = m[2] ? Number(m[2]) : 0;
    if (m[4] === "a" && !/^(at|@)/.test(m[0])) return null;   // "1a" is a room or a step; "at 9a" and "5p" are times
    const ap = (m[3] ?? m[4]).startsWith("p") ? "pm" : "am";
    if (h < 1 || h > 12 || mi > 59) return null;
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return { part: "time", time: { h, mi, sure: true } };
  }, out);
  scan(lower, rx(String.raw`(?:(?:at|@|by|around)\s*)?([01]?\d|2[0-3])[:h]([0-5]\d)(?![:.,]?\d)`), (m) => {
    if (/h/.test(m[0].replace(/^\D*/, "")) && !/^(at|@)/.test(m[0])) return null;   // "3h30" only after at
    const h = Number(m[1]), mi = Number(m[2]);
    return { part: "time", time: { h, mi, sure: h === 0 || h >= 13 || m[1].length === 2 && m[1].startsWith("0") } };
  }, out);
  scan(lower, rx(String.raw`(?:at|@|around)\s*(\d{1,2})(?:\.(\d{2}))?(?:\s*o['’]?clock)?(?![:.,]\d|\s*%)`), (m) => {
    const h = Number(m[1]), mi = m[2] ? Number(m[2]) : 0;
    if (h > 23 || mi > 59) return null;
    return { part: "time", time: { h, mi, sure: h === 0 || h >= 13 } };
  }, out);
  scan(lower, rx(String.raw`(\d{1,2})\s*o['’]?clock`), (m) => {
    const h = Number(m[1]);
    return h >= 1 && h <= 12 ? { part: "time", time: { h, mi: 0, sure: false } } : null;
  }, out);
  scan(lower, rx(String.raw`(?:(?:at|by|around)\s+)?(?:12\s*)?(noon|midday|midnight)`), (m) => ({ part: "time", time: m[1] === "midnight" ? { h: 23, mi: 59, sure: true } : { h: 12, mi: 0, sure: true } }), out);
  scan(lower, rx(String.raw`in\s+the\s+(morning|afternoon|evening)`), (m) => {
    const [h, mi] = PART_TIMES[m[1]];
    return { part: "time", time: { h, mi, sure: true }, bias: m[1] === "morning" ? "am" : "pm" };
  }, out);
  scan(lower, rx(String.raw`(morning|afternoon|evening|night)`), (m) => {
    const [h, mi] = PART_TIMES[m[1]];
    return { part: "time", time: { h, mi, sure: true }, bias: m[1] === "morning" ? "am" : "pm", afterDate: true };
  }, out);

  // ----- repeats -----
  const START = String.raw`(?:every|each)\s+`;
  scan(lower, rx(String.raw`${START}(?:${EVERY_N_RE}\s+)?(days?|weeks?|wks?|months?|years?|fortnights?|quarters?)(?:\s+on\s+(?:a\s+)?(${WD_RE})s?)?`), (m) => {
    const n = everyN(m[1]);
    if (!Number.isFinite(n) || n < 1 || n > 365) return null;
    const u = m[2];
    if (/^day/.test(u)) return { part: "repeat", rep: n === 1 ? { every: 1, unit: "day", daily: true } : { every: n, unit: "day" } };
    if (/^(week|wk)/.test(u)) { const w = m[3] ? WD.get(m[3]) : undefined; return { part: "repeat", rep: { every: n, unit: "week", wd: w?.d } }; }
    if (/^fortnight/.test(u)) return { part: "repeat", rep: { every: 2 * n, unit: "week" } };
    if (/^month/.test(u)) return { part: "repeat", rep: { every: n, unit: "month" } };
    if (/^quarter/.test(u)) return { part: "repeat", rep: { every: 3 * n, unit: "month" } };
    return { part: "repeat", rep: { every: n, unit: "year" } };
  }, out);
  const DAYLIST = String.raw`(?:${WD_RE})s?(?:\s*(?:,|and|&|\+)\s*(?:and\s+)?(?:${WD_RE})s?)*`;
  scan(lower, rx(String.raw`${START}(?:(other|second|2nd|third|3rd|\d{1,2})\s+)?(${DAYLIST})`), (m) => {
    const n = everyN(m[1]);
    const days = [...new Set([...m[2].matchAll(new RegExp(`${WD_RE}`, "gu"))].map((x) => WD.get(x[0])?.d).filter((d): d is number => d != null))].sort();
    if (!days.length || !Number.isFinite(n)) return null;
    return { part: "repeat", rep: days.length === 1 ? { every: n, unit: "week", wd: days[0] } : { every: n, unit: "week", days } };
  }, out);
  scan(lower, rx(String.raw`(?:on\s+)?(?:${WD_PLURAL_RE})(?:\s*(?:,|and|&|\+)\s*(?:and\s+)?(?:${WD_PLURAL_RE}))*`), (m) => {
    const days = [...new Set([...m[0].matchAll(new RegExp(`${WD_RE}`, "gu"))].map((x) => WD.get(x[0])?.d).filter((d): d is number => d != null))].sort();
    if (!days.length) return null;
    return { part: "repeat", rep: days.length === 1 ? { every: 1, unit: "week", wd: days[0] } : { every: 1, unit: "week", days } };
  }, out);
  scan(lower, rx(String.raw`(?:(?:every|each|on)\s+)?(?:week\s*days?|work\s*days?|business\s+days?)|${START}(?:day\s+)?(?:from\s+)?(?:${WD_RE})\s*(?:-|to|through|thru|until|\u2013)\s*(?:${WD_RE})`), (m) => {
    const w = m[0];
    // Without every: only "weekdays" and "workdays" ("weekday" alone is an ordinary word, "3 business days" a length of time).
    if (!/^(every|each)/.test(w) && !/^(?:on\s+)?(?:week\s*days|work\s*days)$/.test(w)) return null;
    const range = [...w.matchAll(new RegExp(`${WD_RE}`, "gu"))].map((x) => WD.get(x[0])!.d);
    if (range.length === 2) {
      const days: number[] = [];
      for (let d = range[0], i = 0; i < 7; i++, d = (d + 1) % 7) { days.push(d); if (d === range[1]) break; }
      return { part: "repeat", rep: days.length === 1 ? { every: 1, unit: "week", wd: days[0] } : { every: 1, unit: "week", days: days.sort() } };
    }
    return { part: "repeat", rep: { every: 1, unit: "week", days: [1, 2, 3, 4, 5] } };
  }, out);
  scan(lower, rx(String.raw`(?:(?:every|each|on)\s+)?(?:the\s+)?weekends?`), (m) => {
    if (!/^(every|each)/.test(m[0]) && !/weekends$/.test(m[0])) return null;
    return { part: "repeat", rep: { every: 1, unit: "week", days: [0, 6] } };
  }, out);
  scan(lower, rx(String.raw`daily|every\s+(?:single\s+)?day|each\s+day|everyday(?=\s*(?:$|[,.;!?)]|at\b|@|\d))|nightly|weekly|biweekly|bi-weekly|fortnightly|monthly|quarterly|yearly|annually|every\s+year`), (m) => {
    const w = m[0].replace(/\s+/g, "");
    if (w === "daily" || w === "everyday" || w === "eachday" || w === "everysingleday") return { part: "repeat", rep: { every: 1, unit: "day", daily: true } };
    if (w === "nightly") return { part: "repeat", rep: { every: 1, unit: "day", daily: true }, time: { h: 21, mi: 0, sure: true }, bias: "pm" };
    if (w === "weekly") return { part: "repeat", rep: { every: 1, unit: "week" } };
    if (w === "biweekly" || w === "bi-weekly" || w === "fortnightly") return { part: "repeat", rep: { every: 2, unit: "week" } };
    if (w === "monthly") return { part: "repeat", rep: { every: 1, unit: "month" } };
    if (w === "quarterly") return { part: "repeat", rep: { every: 3, unit: "month" } };
    return { part: "repeat", rep: { every: 1, unit: "year" } };
  }, out);
  scan(lower, rx(String.raw`${START}(morning|afternoon|evening|night)`), (m) => {
    const [h, mi] = PART_TIMES[m[1]];
    return { part: "repeat", rep: { every: 1, unit: "day", daily: true }, time: { h, mi, sure: true }, bias: m[1] === "morning" ? "am" : "pm" };
  }, out);
  scan(lower, rx(String.raw`${START}(?:month\s+on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)(?:\s+of\s+(?:the|every|each)\s+month)?|${START}month\s+on\s+the\s+(?:${ORD_RE})|(?:on\s+)?(?:the\s+)?(?:${ORD_RE})\s+of\s+(?:every|each)\s+month`), (m) => {
    const dom = ordOf(m[1] ?? m[2] ?? m[4], m[3] ?? m[5]);
    return Number.isFinite(dom) && dom >= 1 && dom <= 31 ? { part: "repeat", rep: { every: 1, unit: "month", dom } } : null;
  }, out);
  scan(lower, rx(String.raw`${START}(?:year\s+on\s+)?(?:(${MO_RE})\.?\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?|(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${MO_RE}))`), (m) => {
    const mo = MO.get(m[1] ?? m[4])!, d = Number(m[2] ?? m[3]);
    return d >= 1 && d <= daysIn(2028, mo) ? { part: "repeat", rep: { every: 1, unit: "year", md: [mo, d] } } : null;
  }, out);
  return out;
}

function addUnit(base: string, n: number, unit: string): string {
  if (/^d/.test(unit)) return plusDays(base, n);
  if (/^w/.test(unit)) return plusDays(base, 7 * n);
  if (/^mo/.test(unit)) return plusMonths(base, n);
  return plusMonths(base, 12 * n);
}
function amount(c: Ctx, n: number, unit: string, work: boolean): Omit<Cand, "start" | "end"> | null {
  if (/^(h|min)/.test(unit)) {
    const ms = n * (/^h/.test(unit) ? 3600_000 : 60_000);
    if (ms > 30 * 86400_000) return null;
    const w = wall(c.nowMs + ms, c.tz);
    return { part: "date", dt: true, date: iso(w.y, w.mo, w.d), time: { h: w.h, mi: w.mi, sure: true }, ms };
  }
  if (work) return /^d/.test(unit) ? { part: "date", date: plusWorkDays(c.today, n) } : null;
  return { part: "date", date: addUnit(c.today, n, unit) };
}

// ---------- picking ----------
const gapOnly = (lower: string, a: number, b: number) => a <= b && /^\s*$/.test(lower.slice(a, b));

function pick(lower: string, all: Cand[], keep: readonly string[]): { date?: Cand; time?: Cand; rep?: Cand; extra: Cand[] } {
  const blocks = all.filter((x) => x.part === "block");
  const keepSet = new Set(keep.map((k) => k.trim().toLowerCase()));
  // PS 1.75: words said no to stay text whole: nothing inside them is taken either (refusing "every Friday" never leaves "Friday").
  const kept: { start: number; end: number }[] = [];
  for (const k of keepSet) { if (!k) continue; for (let i = lower.indexOf(k); i >= 0; i = lower.indexOf(k, i + 1)) kept.push({ start: i, end: i + k.length }); }
  const live = all.filter((x) => x.part !== "block" && !blocks.some((b) => x.start < b.end && b.start < x.end) && !keepSet.has(lower.slice(x.start, x.end).trim())
    && !kept.some((b) => b.start <= x.start && x.end <= b.end));
  // Longest first, then earliest: one phrase per stretch of text.
  live.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const chosen: Cand[] = [];
  for (const x of live) if (!chosen.some((y) => x.start < y.end && y.start < x.end)) chosen.push(x);
  chosen.sort((a, b) => a.start - b.start);
  const last = (f: (x: Cand) => boolean) => [...chosen].reverse().find(f);
  const rep = last((x) => x.part === "repeat");
  const date = last((x) => x.part === "date");
  // "morning" on its own counts only right after the date ("tomorrow morning").
  const times = chosen.filter((x) => x.part === "time" && (!x.afterDate || [date, rep].some((d) => !!d && gapOnly(lower, d.end, x.start))));
  let time = times[times.length - 1];
  const extra: Cand[] = [];
  // "at 9 in the morning": the number with the morning's am or pm, both taken.
  if (time?.bias && times.length > 1) {
    const prev = times[times.length - 2];
    if (gapOnly(lower, prev.end, time.start) && !prev.bias) { extra.push(time); time = { ...prev, bias: time.bias }; }
  }
  // "morning at 9" the other way round.
  const nextT = time && times.find((x) => x !== time && x.bias && gapOnly(lower, time!.end, x.start));
  if (nextT && !time!.bias) { extra.push(nextT); time = { ...time!, bias: nextT.bias }; }
  // "tomorrow evening at 8": the part of the day right before the number says am or pm (20:00, not 08:00), and both words go.
  if (time && !time.bias) {
    const prev = times[times.indexOf(time) - 1];
    if (prev?.bias && gapOnly(lower, prev.end, time.start)) { extra.push(prev); time = { ...time, bias: prev.bias }; }
  }
  return { date, time: date?.dt ? undefined : time, rep, extra };
}

function readTime(tm: Time, bias: "am" | "pm" | undefined): { h: number; mi: number; guessed: boolean } {
  if (tm.sure || tm.h === 0 || tm.h >= 12) return { h: tm.h === 24 ? 0 : tm.h, mi: tm.mi, guessed: false };
  if (bias === "pm") return { h: tm.h + 12, mi: tm.mi, guessed: false };
  if (bias === "am") return { h: tm.h, mi: tm.mi, guessed: false };
  return { h: tm.h <= 6 ? tm.h + 12 : tm.h, mi: tm.mi, guessed: true };
}

// ---------- the labels ----------
const WD3 = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;
/** "Today", "Tomorrow", "Fri 21 Nov", "Fri 1 Jan 2027". */
export function dayLabel(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === plusDays(today, 1)) return "Tomorrow";
  const [y, m, d] = ymd(day);
  return `${WD3[weekdayOf(day)]} ${d} ${MO3[m - 1]}${y !== ymd(today)[0] ? ` ${y}` : ""}`;
}
/** "09:00", or "9am" and "9:30pm" with hour12. */
export function timeLabel(hm: string, hour12 = false): string {
  if (!hour12) return hm;
  const [h, mi] = hm.split(":").map(Number);
  const h12 = h % 12 || 12;
  return `${h12}${mi ? `:${pad(mi)}` : ""}${h < 12 ? "am" : "pm"}`;
}
/** "Every other Fri", "Every Mon and Thu", "Every month on the 15th", "Every year on 3 Mar". */
export function repeatWords(r: Repeat | null, kind: NlKind): string {
  if (kind === "daily" || !r) return "Every day";
  if (r.unit === "day") return r.every === 2 ? "Every other day" : `Every ${r.every} days`;
  if (r.unit === "week") {
    if (r.days?.length) return daysLabel(r.days, r.every);
    const wd = WD3[weekdayOf(r.from)];
    return r.every === 1 ? `Every ${wd}` : r.every === 2 ? `Every other ${wd}` : `Every ${r.every} weeks on ${wd}`;
  }
  const [, m, d] = ymd(r.from);
  if (r.unit === "month") return `${r.every === 1 ? "Every month" : r.every === 2 ? "Every other month" : `Every ${r.every} months`} on the ${ordinal(d)}`;
  return `${r.every === 1 ? "Every year" : `Every ${r.every} years`} on ${d} ${MO3[m - 1]}`;
}

// ---------- the parser ----------
/** Lower case, one UTF-16 unit for one, so every place in it is the same place in the text. */
function lowerSame(s: string): string {
  let o = "";
  for (const ch of s) { const l = ch.toLowerCase(); o += l.length === ch.length ? l : ch; }
  return o;
}

/** The text with these stretches taken out and the spacing tidied (the same tidying as core/typedprio.ts). */
export function stripHits(s: string, hits: { start: number; end: number }[]): string {
  let t = s;
  for (const k of [...hits].sort((a, b) => b.start - a.start)) t = t.slice(0, k.start) + " " + t.slice(k.end);
  return t
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:])(?=[,;:.!?])/g, "")
    .replace(/^[\s,.;:|/-]+/, "")
    .replace(/[\s,;:|/-]+$/, "")
    .trim();
}

export function parseTaskText(text: string, now: number | Date = Date.now(), tz = "UTC", opts: NlOpts = {}): ParsedTask | null {
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return null;
  const src = text.slice(0, 500);
  const lower = lowerSame(src);
  const nowMs = typeof now === "number" ? now : now.getTime();
  const w = wall(nowMs, tz);
  const wallToday = iso(w.y, w.mo, w.d);
  // PS 1.75: `today` is the person's own day when the caller knows it (core/clientwork.ts landDayAt, their Day ends), so
  // "today" and "tomorrow" typed after midnight by a night owl mean the day they are in and the next. A time with no day
  // still counts from the clock (below).
  const own = typeof opts.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(opts.today) ? opts.today : null;
  const today = own ?? wallToday;
  const cut = Math.min(Math.max(0, Math.floor(opts.dayEndsHour ?? 0)), NIGHT_MAX);
  const c: Ctx = { today, tomorrow: own ? plusDays(own, 1) : w.h < cut ? today : plusDays(today, 1), nowH: w.h, nowMi: w.mi, nowMs, tz, opts };
  const p = pick(lower, gather(lower, c), opts.keep ?? []);
  let { date, time, rep } = p;
  // An every day task has no start day in PS: a date beside it stays in the title.
  if (rep?.rep?.daily && date && !date.dt) date = undefined;
  if (!date && !time && !rep) return null;

  const bias = time?.bias ?? date?.bias ?? rep?.bias;
  let due: string | null = null;
  let hm: string | null = null;
  let kind: NlKind = "once";
  let repeat: Repeat | null = null;

  const tm = (date?.dt ? date.time : undefined) ?? time?.time ?? date?.time ?? rep?.time;
  let t: { h: number; mi: number; guessed: boolean } | null = tm ? readTime(tm, bias) : null;

  if (rep?.rep) {
    const s = rep.rep;
    const floor = date?.date && date.date > today ? date.date : today;
    if (s.daily || (s.unit === "day" && s.every === 1)) { kind = "daily"; }
    else {
      kind = "repeat";
      let from = floor;
      if (s.unit === "week" && s.days?.length) from = s.days.map((d) => onOrAfter(floor, d)).sort()[0];
      else if (s.unit === "week" && s.wd != null) from = onOrAfter(floor, s.wd);
      else if (s.unit === "month" && s.dom) from = nextDom(floor, s.dom) ?? floor;
      else if (s.unit === "year" && s.md) from = nextMonthDay(floor, s.md[0], s.md[1]) ?? floor;
      else if (date?.date) from = date.date;
      repeat = { every: s.every, unit: s.unit, from, ...(s.unit === "week" && s.days && s.days.length > 1 ? { days: s.days } : {}) };
      due = from >= today ? from : nextAfter(repeat, plusDays(today, -1));
    }
  } else if (date?.date) {
    due = date.date;
  }
  if (t) {
    if (kind === "once" && !date) {
      // A time with no day: today, or tomorrow once it has passed (a guessed morning time may be this evening instead).
      const nowMin = c.nowH * 60 + c.nowMi;
      if (t.h * 60 + t.mi <= nowMin) {
        if (t.guessed && t.h < 12 && (t.h + 12) * 60 + t.mi > nowMin) t = { ...t, h: t.h + 12 };
        else due = plusDays(wallToday, 1);
      }
      due ??= wallToday;
    }
    hm = `${pad(t.h)}:${pad(t.mi)}`;
  }

  const hits: NlHit[] = [date, time, rep, ...p.extra]
    .filter((x): x is Cand => !!x)
    .map((x) => ({ start: x.start, end: x.end, raw: src.slice(x.start, x.end), part: x.part === "repeat" ? "repeat" as const : x.part === "time" ? "time" as const : "date" as const }))
    .sort((a, b) => a.start - b.start);
  const when = kind === "once" ? (due ? dayLabel(due, today) : "") : repeatWords(repeat, kind);
  const label = [when, hm ? timeLabel(hm, opts.hour12) : ""].filter(Boolean).join(", ");
  return {
    title: stripHits(src, hits),
    hits, kind, due, time: hm, repeat, label,
    key: hits.map((h) => lowerSame(h.raw).trim()).join("|"),
  };
}

/** When a typed time pops up as a reminder on the task (core/remind.ts reminders on tasks): once on its day, or on the days of
 *  the week the task repeats on. Rules a reminder cannot follow (every other week, every month) get it once, on the first
 *  round. Null when no time was given. */
export function reminderOf(p: Pick<ParsedTask, "kind" | "time" | "due" | "repeat">): { at: string; date?: string; days?: number[] } | null {
  if (!p.time) return null;
  if (p.kind === "daily") return { at: p.time, days: [0, 1, 2, 3, 4, 5, 6] };
  const r = p.repeat;
  if (p.kind === "repeat" && r && r.unit === "week" && r.every === 1) return { at: p.time, days: r.days?.length ? [...r.days] : [weekdayOf(r.from)] };
  if (p.kind === "repeat" && r && r.unit === "day" && r.every === 1) return { at: p.time, days: [0, 1, 2, 3, 4, 5, 6] };
  return p.due ? { at: p.time, date: p.due } : null;
}

// ---------- a typed time as a reminder on the task (core/nlremind.ts adds it) ----------
/** When it pops up: once on `date`, or on these days of the week (0 Sunday), at `at` ("HH:MM") in `tz` ("" = this device's). */
export type TimeRemind = { at: string; date?: string; days?: number[]; tz?: string };
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Clean one from a message. Null when it is not a usable time. */
export function cleanTimeRemind(v: unknown): TimeRemind | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.at !== "string" || !HM_RE.test(o.at)) return null;
  const tz = typeof o.tz === "string" && o.tz && validTz(o.tz) ? o.tz : "";
  if (typeof o.date === "string" && DAY_RE.test(o.date)) return { at: o.at, date: o.date, tz };
  const days = Array.isArray(o.days) ? [...new Set(o.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) as number[])].sort() : [];
  return days.length ? { at: o.at, days, tz } : null;
}

/** How many minutes before the typed time its one reminder pops up (the owner, 17 Nov 2026: "call Alex at 3pm" reminds once at
 *  2:45 pm, not the 15 minute nag). */
export const NL_REMIND_LEAD = 15;
const hmOf = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
/** The reminder to add: ONE pop up on the task (Done in one click) NL_REMIND_LEAD minutes before the typed time. Its window runs
 *  from then to the typed time and its "Remind me in" is that long too, so it rings once and never nags (core/remind.ts
 *  remNextRing: the next ring would land on the window's end). A time just after midnight starts the day before. */
export function timeReminder(id: string, taskId: string, w: TimeRemind, now: number, deviceTz = DEVICE_TZ): Reminder {
  const [h, m] = w.at.split(":").map(Number);
  const startMin = h * 60 + m - NL_REMIND_LEAD;
  const back = startMin < 0;   // 00:10 reminds at 23:55 the evening before
  const at = hmOf((startMin + 1440) % 1440);
  const base = newTaskReminder(id, taskId, now, deviceTz);
  const one = { ...base, at, until: w.at, snooze: NL_REMIND_LEAD, tz: w.tz ?? "" };
  if (w.date) return { ...one, date: back ? plusDays(w.date, -1) : w.date };
  const days = w.days ?? base.days;
  return { ...one, date: undefined, days: back ? [...new Set(days.map((d) => (d + 6) % 7))].sort() : days };
}

// ---------- the Add task window (core/quickadd.ts) ----------
/** The window's options with the typed words filled in: How often, When and the date, for its Advanced part to show. */
export function nlAddOpts(o: AddOpts, p: Pick<ParsedTask, "kind" | "due">): AddOpts {
  if (p.kind !== "once") return { ...o, kind: p.kind };
  return p.due ? { ...o, kind: "once", when: "date", date: p.due } : { ...o, kind: "once" };
}
/** The Repeats picker's rule for a typed repeat, or null for anything else. (A rule on several days shows as every week.) */
export function nlRule(p: Pick<ParsedTask, "kind" | "repeat">): RepeatDraft | null {
  return p.kind === "repeat" && p.repeat ? { kind: "repeat", every: p.repeat.every, unit: p.repeat.unit, from: p.repeat.from } : null;
}

// ---------- the chip's state (kept outside React so it can be tested) ----------
/**
 * One add box's suggestion. `kept`: phrases the person said no to (the chip clicked, or Backspace right after the words):
 * they stay text until they are no longer in the box. `typedAt` and `pickedAt` count changes, so whichever came last, the
 * typed words or a date or repeat picked by clicking in Advanced, is the one that is used.
 */
export type NlState = { key: string; kept: string[]; typedAt: number; pickedAt: number; tick: number };
export const nlStart = (): NlState => ({ key: "", kept: [], typedAt: 0, pickedAt: 0, tick: 0 });

/** Editing a task (PS 1.75): the date words already in its name were written before, not typed now, so they start as said no
 *  to ("Friday deck" stays a title); a date typed while editing is offered as in an add box. `p` is the old name's parse. */
export function nlStartFor(p: ParsedTask | null): NlState {
  return p ? { ...nlStart(), kept: [...new Set(p.hits.map((h) => lowerSame(h.raw).trim()))] } : nlStart();
}
/** The text changed: a new or different phrase counts as typed now. A phrase said no to is forgotten once it is gone. */
export function nlTyped(st: NlState, text: string, p: ParsedTask | null): NlState {
  const lower = lowerSame(text);
  const kept = st.kept.filter((k) => lower.includes(k));
  const key = p?.key ?? "";
  if (key === st.key && kept.length === st.kept.length) return st;
  const tick = st.tick + 1;
  return { ...st, key, kept, tick, typedAt: key && key !== st.key ? tick : st.typedAt };
}
/** A date or repeat was picked by clicking (Advanced, How often, When, Repeats): it wins over words typed before it. */
export const nlPicked = (st: NlState): NlState => ({ ...st, tick: st.tick + 1, pickedAt: st.tick + 1 });
/** No thanks: the chip clicked. Every phrase it showed stays as text. */
export function nlDismiss(st: NlState, p: ParsedTask | null): NlState {
  if (!p) return st;
  return { ...st, kept: [...new Set([...st.kept, ...p.hits.map((h) => lowerSame(h.raw).trim())])] };
}
/** What Add should use: the parse when it is on offer and came after any clicked pick, else null (the title as written and
 *  the date from the controls). `p` must be parsed with `keep: st.kept`. */
export function nlOnAdd(st: NlState, p: ParsedTask | null): ParsedTask | null {
  if (!p || st.pickedAt > st.typedAt) return null;
  return p;
}
/** Backspace with the caret right after the last phrase (nothing selected) means no thanks rather than deleting. */
export function nlBackspace(p: ParsedTask | null, caret: number | null, selEnd: number | null): boolean {
  if (!p || caret == null || caret !== selEnd) return false;
  return p.hits.some((h) => h.end === caret);
}
/** Calm while typing: a phrase that ends where the typing is (it may still grow: "Fri" into "Friend") waits this long
 *  before it lights up. Add still uses it straight away. */
export const SETTLE_MS = 350;
export function settled(p: ParsedTask | null, text: string, idleMs: number): boolean {
  if (!p) return false;
  const endAt = text.replace(/\s+$/, "").length;
  return idleMs >= SETTLE_MS || text.length > endAt || !p.hits.some((h) => h.end >= endAt);
}

/** A name edited in place (a Dimension X card, PS 1.75): the one-off date that is new in it, or null when there is none, the
 *  name had those words before ("Friday deck" stays as it is) or nothing would be left to call the task. */
export function renamedDate(before: string, after: string, now: number, tz: string, opts: NlOpts = {}): ParsedTask | null {
  const old = parseTaskText(before, now, tz, opts);
  const keep = [...(opts.keep ?? []), ...(old ? old.hits.map((h) => lowerSame(h.raw).trim()) : [])];
  const p = parseTaskText(after, now, tz, { ...opts, keep });
  return p && p.kind === "once" && p.due && p.title && !p.time ? p : null;   // a time stays text: a rename puts no reminder on it
}
