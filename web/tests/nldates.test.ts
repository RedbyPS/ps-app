// Run: node --experimental-strip-types tests/nldates.test.ts
// Dates in plain words (core/nldates.ts, PS 1.65): one offline parser for every add box and for voice capture.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cleanTimeRemind, nlAddOpts, nlBackspace, nlDismiss, nlOnAdd, nlPicked, nlRule, nlStart, nlTyped, parseTaskText, reminderOf, settled, SETTLE_MS, stripHits, timeReminder, NL_REMIND_LEAD, type NlOpts,
} from "../src/core/nldates.ts";
import { quickDefaults } from "../src/core/quickadd.ts";
import { cleanReminder, remNextRing } from "../src/core/remind.ts";
import { cleanRepeat, daysLabel, nextAfter, repeatLabel, resetPatch, isDueNow, type Repeat } from "../src/core/repeat.ts";

let n = 0;
const fails: string[] = [];
const ok = (name: string, fn: () => void) => { try { fn(); n++; } catch (e) { fails.push(`${name}: ${(e as Error).message.split("\n")[0]}`); } };

// The reference moment: Tuesday 17 November 2026, 10:00 in Dubai (06:00 UTC).
const NOW = Date.UTC(2026, 10, 17, 6, 0);
const TZ = "Asia/Dubai";
const OPTS: NlOpts = { dayEndsHour: 15 };

type Exp = { title?: string; kind?: "once" | "daily" | "repeat"; due?: string | null; time?: string | null; repeat?: Partial<Repeat> | null; label?: string };
function check(text: string, exp: Exp | null, now = NOW, tz = TZ, opts: NlOpts = OPTS) {
  ok(`${JSON.stringify(text)} (${tz} ${new Date(now).toISOString()})`, () => {
    const p = parseTaskText(text, now, tz, opts);
    if (exp === null) { assert.equal(p, null, `${text}: expected nothing, got ${p && JSON.stringify({ due: p.due, time: p.time, kind: p.kind, hits: p.hits.map((h) => h.raw) })}`); return; }
    assert.ok(p, `${text}: expected a parse`);
    if (exp.title !== undefined) assert.equal(p.title, exp.title, `${text}: title`);
    assert.equal(p.kind, exp.kind ?? "once", `${text}: kind`);
    if (exp.due !== undefined) assert.equal(p.due, exp.due, `${text}: due`);
    assert.equal(p.time, exp.time ?? null, `${text}: time`);
    if (exp.repeat === null) assert.equal(p.repeat, null, `${text}: repeat`);
    else if (exp.repeat) for (const [k, v] of Object.entries(exp.repeat)) assert.deepEqual((p.repeat as unknown as Record<string, unknown>)?.[k], v, `${text}: repeat.${k}`);
    if (exp.label !== undefined) assert.equal(p.label, exp.label, `${text}: label`);
  });
}

// ---------- one-off days ----------
check("call bank tomorrow at 10", { title: "call bank", due: "2026-11-18", time: "10:00", label: "Tomorrow, 10:00" });
check("Friday deck", { title: "deck", due: "2026-11-20", label: "Fri 20 Nov" });
check("next Monday standup", { title: "standup", due: "2026-11-23" });
check("this Friday review", { title: "review", due: "2026-11-20" });
check("next Tuesday call", { title: "call", due: "2026-11-24" });          // today is a Tuesday: next is a week on
check("Tuesday call", { title: "call", due: "2026-11-17", label: "Today" }); // a bare day name counts today
check("this Tuesday call", { title: "call", due: "2026-11-17" });
check("Friday after next ship it", { title: "ship it", due: "2026-11-27" });
check("demo Friday next week", { title: "demo", due: "2026-11-27" });
check("on Wednesday dentist", { title: "dentist", due: "2026-11-18" });
check("by Thursday report", { title: "report", due: "2026-11-19" });
check("due Thurs report", { title: "report", due: "2026-11-19" });
check("Sunday plan week", { title: "plan week", due: "2026-11-22" });
check("coming Saturday party", { title: "party", due: "2026-11-21" });
check("send it today", { title: "send it", due: "2026-11-17", label: "Today" });
check("tmrw email Sam", { title: "email Sam", due: "2026-11-18" });
check("tomorow email Sam", { title: "email Sam", due: "2026-11-18" });
check("tommorow email Sam", { title: "email Sam", due: "2026-11-18" });
check("TOMORROW AT 9AM call", { title: "call", due: "2026-11-18", time: "09:00" });
check("the day after tomorrow dentist", { title: "dentist", due: "2026-11-19" });
check("wensday gym", { title: "gym", due: "2026-11-18" });                  // a common typo
check("thrusday gym", { title: "gym", due: "2026-11-19" });
check("next week plan", { title: "plan", due: "2026-11-23" });
check("next month taxes", { title: "taxes", due: "2026-12-01" });
check("next year passport", { title: "passport", due: "2027-01-01" });
check("this weekend hike", { title: "hike", due: "2026-11-21" });
check("next weekend hike", { title: "hike", due: "2026-11-28" });
check("clean on the weekend", { title: "clean", due: "2026-11-21" });
// ---------- in, from now ----------
check("in 3 days", { title: "", due: "2026-11-20" });
check("send invoice in two weeks", { title: "send invoice", due: "2026-12-01" });
check("renew in a month", { title: "renew", due: "2026-12-17" });
check("in a year check the boiler", { title: "check the boiler", due: "2027-11-17" });
check("in a couple of days ping Lee", { title: "ping Lee", due: "2026-11-19" });
check("in a few days follow up", { title: "follow up", due: "2026-11-20" });
check("in 2 hours call back", { title: "call back", due: "2026-11-17", time: "12:00" });
check("stretch in 30 min", { title: "stretch", due: "2026-11-17", time: "10:30" });
check("tea in half an hour", { title: "tea", due: "2026-11-17", time: "10:30" });
check("in 15 hours", { due: "2026-11-18", time: "01:00" });                // past midnight
check("reply in 3 working days", { title: "reply", due: "2026-11-20" });
check("reply in 4 business days", { title: "reply", due: "2026-11-23" });   // skips the weekend
check("3 days from now", { title: "", due: "2026-11-20" });
check("a week from today", { title: "", due: "2026-11-24" });
check("two weeks from tomorrow", { title: "", due: "2026-12-02" });
// ---------- ends and starts ----------
check("report end of the month", { title: "report", due: "2026-11-30" });
check("report by the end of next month", { title: "report", due: "2026-12-31" });
check("summary by end of week", { title: "summary", due: "2026-11-20" });
check("close books eom", { title: "close books", due: "2026-11-30" });
check("end of the year review", { title: "review", due: "2026-12-31" });
check("rent start of next month", { title: "rent", due: "2026-12-01" });
check("send eod", { title: "send", due: "2026-11-17" });
check("plan end of quarter", { title: "plan", due: "2026-12-31" });
// ---------- days of the month ----------
check("pay rent on the 15th", { title: "pay rent", due: "2026-12-15", label: "Tue 15 Dec" });
check("renew on the 17th", { title: "renew", due: "2026-11-17" });          // today counts
check("file on the 31st", { title: "file", due: "2026-12-31" });           // November has no 31st
check("invoice by the 3rd", { title: "invoice", due: "2026-12-03" });
check("the 15th of next month taxes", { title: "taxes", due: "2026-12-15" });
check("on the first pay", { title: "pay", due: "2026-12-01" });
// ---------- months without a year ----------
check("March 3 dentist", { title: "dentist", due: "2027-03-03", label: "Wed 3 Mar 2027" });
check("dentist 3 March", { title: "dentist", due: "2027-03-03" });
check("dentist on the 3rd of March", { title: "dentist", due: "2027-03-03" });
check("Dec 25 gifts", { title: "gifts", due: "2026-12-25" });
check("Nov 17 file", { title: "file", due: "2026-11-17" });               // today counts
check("Nov 10 file", { title: "file", due: "2027-11-10" });               // passed: next year
check("Jan 5 dentist", { title: "dentist", due: "2027-01-05" });
check("dentist Mar 3, 2028", { title: "dentist", due: "2028-03-03" });
check("Feb 29 leap", { title: "leap", due: "2028-02-29" });               // waits for a leap year
check("Feb 30 nope", null);
check("launch 2026-12-01", { title: "launch", due: "2026-12-01" });
check("due 12/25 cards", { title: "cards", due: "2026-12-25" });
check("on 4/12", { due: "2027-04-12" });
check("on 4/12", { due: "2026-12-04" }, NOW, TZ, { dayFirst: true });
check("on 25/12", { due: "2026-12-25" });                                  // only one way it can be read
check("1/2 cup flour", null);
// ---------- times ----------
check("9am standup", { title: "standup", due: "2026-11-18", time: "09:00" });  // passed today: tomorrow
check("standup 11am", { title: "standup", due: "2026-11-17", time: "11:00" });
check("call at 5", { title: "call", due: "2026-11-17", time: "17:00" });       // 1 to 6 with no am or pm: afternoon
check("call at 9", { title: "call", due: "2026-11-17", time: "21:00" });       // 9 has passed this morning: tonight
check("call at 8am", { title: "call", due: "2026-11-18", time: "08:00" });
check("call at 17:00", { title: "call", due: "2026-11-17", time: "17:00" });
check("call 2:30", { title: "call", due: "2026-11-17", time: "14:30" });
check("lunch at noon", { title: "lunch", due: "2026-11-17", time: "12:00" });
check("submit by midnight", { title: "submit", due: "2026-11-17", time: "23:59" });
check("5 o'clock tea", { title: "tea", due: "2026-11-17", time: "17:00" });
check("call 5p", { title: "call", due: "2026-11-17", time: "17:00" });
check("call @5pm", { title: "call", due: "2026-11-17", time: "17:00" });
check("call at 10:30pm", { title: "call", due: "2026-11-17", time: "22:30" });
check("call at 7.30pm", { title: "call", due: "2026-11-17", time: "19:30" });
check("12am backup", { title: "backup", due: "2026-11-18", time: "00:00" });
check("12pm lunch", { title: "lunch", due: "2026-11-17", time: "12:00" });
check("dinner tonight", { title: "dinner", due: "2026-11-17", time: null });
check("tonight at 9 movie", { title: "movie", due: "2026-11-17", time: "21:00" });
check("tomorrow morning run", { title: "run", due: "2026-11-18", time: "09:00" });
check("tomorrow evening call", { title: "call", due: "2026-11-18", time: "18:00" });
check("tomorrow night pack", { title: "pack", due: "2026-11-18", time: "21:00" });
check("this afternoon review", { title: "review", due: "2026-11-17", time: "14:00" });
check("this evening at 7 call", { title: "call", due: "2026-11-17", time: "19:00" });
check("tomorrow at 9 in the morning", { title: "", due: "2026-11-18", time: "09:00" });
// The owner, 17 Nov 2026: "next Friday" is the coming Friday (on a Tuesday, this week's), as built. On a Friday it is a week on.
check("deck next Friday", { title: "deck", due: "2026-11-20" });
check("deck next Friday", { title: "deck", due: "2026-11-27" }, Date.UTC(2026, 10, 20, 6, 0));
// Quality pass 1.65: the part of the day BEFORE the number gives its am or pm, and its word leaves the title.
check("call mum tomorrow evening at 8", { title: "call mum", due: "2026-11-18", time: "20:00", label: "Tomorrow, 20:00" });
check("demo Friday afternoon at 3", { title: "demo", due: "2026-11-20", time: "15:00" });
check("tomorrow morning at 9 gym", { title: "gym", due: "2026-11-18", time: "09:00" });
check("every Friday evening at 7 drinks", { title: "drinks", kind: "repeat", due: "2026-11-20", time: "19:00", repeat: { every: 1, unit: "week" } });
check("tomorrow night at 11 backup", { title: "backup", due: "2026-11-18", time: "23:00" });
check("Morning pages tomorrow at 7", { title: "Morning pages", due: "2026-11-18", time: "07:00" });
check("tomorrow at 7 in the evening", { title: "", due: "2026-11-18", time: "19:00" });
check("Friday at 3pm deck", { title: "deck", due: "2026-11-20", time: "15:00" });
check("Friday at 9 deck", { title: "deck", due: "2026-11-20", time: "09:00" }); // a day given: no rollover
check("3-4pm call", { title: "call", due: "2026-11-17", time: "15:00" });       // a range: its start
check("10am-11am meeting", { title: "meeting", due: "2026-11-18", time: "10:00" });
check("11-1pm lunch", { title: "lunch", due: "2026-11-17", time: "11:00" });
check("work from 9 to 5", { title: "work", due: "2026-11-18", time: "09:00" });
check("wed 5pm", { title: "", due: "2026-11-18", time: "17:00" });             // a short day name with a time after it
check("Fri. review", { title: "review", due: "2026-11-20" });
check("every single day", { kind: "daily" });
check("pages 1-2", null);
check("Monday.com setup", null);
check("send friday.pdf", null);
check("every weekday except friday", { title: "except friday", kind: "repeat", repeat: { days: [1, 2, 3, 4, 5] } });   // the exception stays as text
check("13pm", null);
check("at 25", null);
check("room 1a", null);
check("version 2.30", null);
check("buy 5,000 at 5,000", null);
// ---------- repeats ----------
check("gym every day", { title: "gym", kind: "daily", due: null, repeat: null, label: "Every day" });
check("water plants daily", { title: "water plants", kind: "daily" });
check("stretch every other day", { title: "stretch", kind: "repeat", due: "2026-11-17", repeat: { every: 2, unit: "day", from: "2026-11-17" }, label: "Every other day" });
check("every 3 days", { kind: "repeat", repeat: { every: 3, unit: "day" }, label: "Every 3 days" });
check("every week review", { title: "review", kind: "repeat", repeat: { every: 1, unit: "week", from: "2026-11-17" }, label: "Every Tue" });
check("weekly review", { title: "review", kind: "repeat", repeat: { every: 1, unit: "week" } });
check("every Monday standup", { title: "standup", kind: "repeat", due: "2026-11-23", repeat: { every: 1, unit: "week", from: "2026-11-23" }, label: "Every Mon" });
check("gym every other Friday 3pm", { title: "gym", kind: "repeat", due: "2026-11-20", time: "15:00", repeat: { every: 2, unit: "week", from: "2026-11-20" }, label: "Every other Fri, 15:00" });
check("every second Friday", { kind: "repeat", repeat: { every: 2, unit: "week", from: "2026-11-20" } });
check("biweekly sync", { title: "sync", kind: "repeat", repeat: { every: 2, unit: "week" } });
check("fortnightly sync", { title: "sync", kind: "repeat", repeat: { every: 2, unit: "week" } });
check("every Mon and Thu", { kind: "repeat", due: "2026-11-19", repeat: { every: 1, unit: "week", from: "2026-11-19", days: [1, 4] }, label: "Every Mon and Thu" });
check("gym every mon, wed and fri", { title: "gym", kind: "repeat", due: "2026-11-18", repeat: { days: [1, 3, 5] }, label: "Every Mon, Wed and Fri" });
check("run every weekday 7am", { title: "run", kind: "repeat", due: "2026-11-17", time: "07:00", repeat: { every: 1, unit: "week", from: "2026-11-17", days: [1, 2, 3, 4, 5] }, label: "Every weekday, 07:00" });
check("weekdays standup", { title: "standup", kind: "repeat", repeat: { days: [1, 2, 3, 4, 5] } });
check("standup every workday", { title: "standup", kind: "repeat", repeat: { days: [1, 2, 3, 4, 5] } });
check("every mon-fri", { kind: "repeat", repeat: { days: [1, 2, 3, 4, 5] } });
check("hike every weekend", { title: "hike", kind: "repeat", due: "2026-11-21", repeat: { days: [0, 6] }, label: "Every weekend" });
check("mondays gym", { title: "gym", kind: "repeat", due: "2026-11-23", repeat: { every: 1, unit: "week" } });
check("gym on tuesdays and thursdays", { title: "gym", kind: "repeat", due: "2026-11-17", repeat: { days: [2, 4] } });
check("every month rent", { title: "rent", kind: "repeat", repeat: { every: 1, unit: "month", from: "2026-11-17" } });
check("monthly report", { title: "report", kind: "repeat", repeat: { every: 1, unit: "month" } });
check("every month on the 15th", { kind: "repeat", due: "2026-12-15", repeat: { every: 1, unit: "month", from: "2026-12-15" }, label: "Every month on the 15th" });
check("invoices every 15th", { title: "invoices", kind: "repeat", due: "2026-12-15", repeat: { unit: "month" } });
check("rent the 1st of every month", { title: "rent", kind: "repeat", due: "2026-12-01", repeat: { every: 1, unit: "month", from: "2026-12-01" } });
check("every 3 months on the 1st", { kind: "repeat", due: "2026-12-01", repeat: { every: 3, unit: "month" }, label: "Every 3 months on the 1st" });
check("taxes every quarter", { title: "taxes", kind: "repeat", repeat: { every: 3, unit: "month" } });
check("quarterly taxes", { title: "taxes", kind: "repeat", repeat: { every: 3, unit: "month" } });
check("yearly checkup", { title: "checkup", kind: "repeat", repeat: { every: 1, unit: "year", from: "2026-11-17" } });
check("birthday every March 3", { title: "birthday", kind: "repeat", due: "2027-03-03", repeat: { every: 1, unit: "year", from: "2027-03-03" }, label: "Every year on 3 Mar" });
check("every year on 3 Mar birthday", { title: "birthday", kind: "repeat", due: "2027-03-03", repeat: { unit: "year" } });
check("meditate every morning", { title: "meditate", kind: "daily", time: "09:00" });
check("journal every evening", { title: "journal", kind: "daily", time: "18:00" });
check("gym every day at 8", { title: "gym", kind: "daily", time: "08:00", label: "Every day, 08:00" });
check("every morning at 7 gym", { title: "gym", kind: "daily", time: "07:00" });
check("every weekday at 7:30", { kind: "repeat", time: "07:30", repeat: { days: [1, 2, 3, 4, 5] } });
check("every Monday starting Dec 7", { kind: "repeat", due: "2026-12-07", repeat: { from: "2026-12-07" } });
check("every Friday from next week", { kind: "repeat", due: "2026-11-27", repeat: { from: "2026-11-27" } });
check("every month starting Dec 15", { kind: "repeat", due: "2026-12-15", repeat: { unit: "month", from: "2026-12-15" } });
check("every 2 weeks on Friday", { kind: "repeat", due: "2026-11-20", repeat: { every: 2, unit: "week", from: "2026-11-20" } });
check("every Friday evening", { kind: "repeat", due: "2026-11-20", time: "18:00", repeat: { every: 1, unit: "week" } });
check("gym every day starting tomorrow", { title: "gym starting tomorrow", kind: "daily" });  // an Every day task has no start day in PS
// ---------- left as text ----------
check("every first Monday of the month review", null);
check("every last Friday", null);
check("the second Tuesday", null);
check("drink every hour", null);
check("last Friday notes", null);
check("call me yesterday", null);
check("every now and then", null);
check("may the force", null);
check("march on", null);
check("sat exam", null);
check("sun cream", null);
check("wed plans", null);
check("Tuesday's notes", null);
check("lights on the 3rd floor", null);
check("everyday carry list", null);
check("tomato soup", null);
check("call friend", null);
check("Mondayitis", null);
check("see example.com/today", null);
check("weekday plans", null);
check("takes 3 business days", null);
check("5", null);
check("", null);
check("!!!", null);
// ---------- the night: times past midnight and the work day cut off ----------
const NIGHT = Date.UTC(2026, 10, 16, 21, 30);   // 01:30 on Tuesday 17 November, Dubai
check("tomorrow 9am", { due: "2026-11-17", time: "09:00" }, NIGHT);           // still Monday's work day: tomorrow is the day starting
check("tomorrow 9am", { due: "2026-11-18", time: "09:00" }, NIGHT, TZ, { dayEndsHour: 0 });   // midnight: no night shifts
check("tomorrow 9am", { due: "2026-11-18", time: "09:00" }, NIGHT, TZ, { dayEndsHour: 1 });   // the work day ended at 1am
check("today", { due: "2026-11-17" }, NIGHT);
check("at 9", { due: "2026-11-17", time: "09:00" }, NIGHT);
const LATE = Date.UTC(2026, 10, 17, 19, 30);    // 23:30 Tuesday, Dubai
check("at 1am", { due: "2026-11-18", time: "01:00" }, LATE);
check("tomorrow 1am", { due: "2026-11-18", time: "01:00" }, LATE);
check("at 11", { due: "2026-11-18", time: "11:00" }, LATE);
check("in 2 hours", { due: "2026-11-18", time: "01:30" }, LATE);
check("tomorrow", { due: "2026-11-18" }, Date.UTC(2026, 10, 17, 0, 0), TZ, { dayEndsHour: 3 });   // 04:00: past the cut off
// ---------- time zones and clock changes ----------
const SAME = Date.UTC(2026, 10, 17, 22, 0);
check("today", { due: "2026-11-18" }, SAME, "Asia/Dubai");                    // 02:00 on the 18th there
check("today", { due: "2026-11-17" }, SAME, "America/New_York");              // 17:00 on the 17th there
check("in 1 hour", { due: "2026-03-08", time: "03:30" }, Date.UTC(2026, 2, 8, 6, 30), "America/New_York");   // spring forward: 01:30 EST + 1h
check("in 1 hour", { due: "2026-11-01", time: "01:30" }, Date.UTC(2026, 10, 1, 5, 30), "America/New_York");  // fall back: 01:30 EDT + 1h
check("tomorrow 9am", { due: "2026-03-08", time: "09:00" }, Date.UTC(2026, 2, 7, 15, 0), "America/New_York"); // wall time across the change
check("tomorrow 2:30am", { due: "2026-03-29", time: "02:30" }, Date.UTC(2026, 2, 28, 12, 0), "Europe/London");
check("in 3 days", { due: "2026-10-28" }, Date.UTC(2026, 9, 25, 0, 30), "Europe/London");   // across the October change
check("next Monday", { due: "2026-11-23" }, Date.UTC(2026, 10, 17, 6, 0), "Pacific/Kiritimati");

// ---------- labels ----------
ok("hour12 labels", () => {
  assert.equal(parseTaskText("call tomorrow 9am", NOW, TZ, { hour12: true })!.label, "Tomorrow, 9am");
  assert.equal(parseTaskText("call tomorrow 9:30pm", NOW, TZ, { hour12: true })!.label, "Tomorrow, 9:30pm");
});
ok("hits: where the words sit, painted in order", () => {
  const p = parseTaskText("call bank tomorrow at 10", NOW, TZ)!;
  assert.deepEqual(p.hits.map((h) => [h.raw, h.part]), [["tomorrow", "date"], ["at 10", "time"]]);
  assert.equal(p.hits[0].start, 10);
  assert.equal(p.key, "tomorrow|at 10");
});
ok("only the last date is taken, the other stays in the title", () => {
  const p = parseTaskText("move Friday deck to Monday", NOW, TZ)!;
  assert.equal(p.due, "2026-11-23");
  assert.equal(p.title, "move Friday deck to");
});
ok("tidying: brackets, commas, full stops", () => {
  assert.equal(parseTaskText("Call mom (tomorrow)", NOW, TZ)!.title, "Call mom");
  assert.equal(parseTaskText("Email QLA, tomorrow.", NOW, TZ)!.title, "Email QLA.");
  assert.equal(stripHits("a  b", []), "a b");
});
ok("P1 survives the date words (typed priority reads the title after)", () => {
  assert.equal(parseTaskText("Email QLA P1 tomorrow", NOW, TZ)!.title, "Email QLA P1");
});
ok("keep: a phrase said no to stays text, the rest is still read", () => {
  assert.equal(parseTaskText("Friday deck", NOW, TZ, { keep: ["friday"] }), null);
  const p = parseTaskText("Friday deck at 3pm", NOW, TZ, { keep: ["friday"] })!;
  assert.equal(p.title, "Friday deck");
  assert.equal(p.due, "2026-11-17");
  assert.equal(p.time, "15:00");
});
ok("accepts a Date for now", () => { assert.equal(parseTaskText("tomorrow", new Date(NOW), TZ)!.due, "2026-11-18"); });
ok("very long text: only the first 500 characters are read", () => {
  assert.equal(parseTaskText(`${"x ".repeat(300)}tomorrow`, NOW, TZ), null);
});
ok("fast enough to run on every key press", () => {
  const s = "call the bank about the mortgage every other Friday at 3pm starting next week, P1, bring the papers";
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) parseTaskText(s, NOW, TZ);
  assert.ok((performance.now() - t0) / 200 < 5, "under 5 ms a parse");
});

// ---------- reminders for a typed time ----------
ok("reminderOf: once on its day, repeats on their days", () => {
  assert.equal(reminderOf(parseTaskText("Friday deck", NOW, TZ)!), null);
  assert.deepEqual(reminderOf(parseTaskText("call bank tomorrow at 10", NOW, TZ)!), { at: "10:00", date: "2026-11-18" });
  assert.deepEqual(reminderOf(parseTaskText("gym every day at 8", NOW, TZ)!), { at: "08:00", days: [0, 1, 2, 3, 4, 5, 6] });
  assert.deepEqual(reminderOf(parseTaskText("run every weekday 7am", NOW, TZ)!), { at: "07:00", days: [1, 2, 3, 4, 5] });
  assert.deepEqual(reminderOf(parseTaskText("every Monday 9am standup", NOW, TZ)!), { at: "09:00", days: [1] });
  // Every other week: a reminder cannot skip weeks, so it is once, on the first round.
  assert.deepEqual(reminderOf(parseTaskText("gym every other Friday 3pm", NOW, TZ)!), { at: "15:00", date: "2026-11-20" });
});

ok("cleanTimeRemind: only a real time and a day or days get through (it comes in a message from the floating list)", () => {
  assert.deepEqual(cleanTimeRemind({ at: "10:00", date: "2026-11-18" }), { at: "10:00", date: "2026-11-18", tz: "" });
  assert.deepEqual(cleanTimeRemind({ at: "07:00", days: [5, 1, 1, 9, "x"], tz: "Asia/Dubai" }), { at: "07:00", days: [1, 5], tz: "Asia/Dubai" });
  assert.deepEqual(cleanTimeRemind({ at: "07:00", days: [1], tz: "Not/AZone" }), { at: "07:00", days: [1], tz: "" });
  for (const bad of [null, "10:00", { at: "25:00", date: "2026-11-18" }, { at: "9:00", date: "2026-11-18" }, { at: "10:00" }, { at: "10:00", days: [] }, { at: "10:00", date: "18/11" }]) assert.equal(cleanTimeRemind(bad), null);
});
ok("timeReminder: ONE reminder 15 minutes before the typed time, never the 15 minute nag (owner, 17 Nov)", () => {
  // "call Alex at 3pm": pops up once at 14:45, its window ends at 15:00, so it rings once.
  const r = timeReminder("r1", "task1", { at: "15:00", date: "2026-11-18", tz: "" }, NOW, TZ);
  assert.equal(r.task, "task1"); assert.equal(r.at, "14:45"); assert.equal(r.until, "15:00"); assert.equal(r.date, "2026-11-18");
  const c = cleanReminder(r, NOW)!;
  assert.ok(c, "the reminder rules accept it");
  assert.equal(c.at, "14:45"); assert.equal(c.until, "15:00");
  // It rings at 14:45 and never again: the next ring would be at 15:00, the end of its window. A snooze ends there too.
  const at1445 = Date.UTC(2026, 10, 18, 10, 45);   // 14:45 in Dubai
  assert.equal(remNextRing(c, undefined, Date.UTC(2026, 10, 18, 9, 0), TZ, 0), at1445, "first ring at 14:45");
  assert.equal(remNextRing(c, undefined, at1445, TZ, 0), at1445, "it rings at 14:45");
  assert.equal(remNextRing(c, undefined, at1445 + 60_000, TZ, at1445), 0, "no second ring");
  assert.equal(remNextRing(c, { snoozeUntil: at1445 + 15 * 60_000, at: at1445 }, at1445 + 60_000, TZ, at1445), 0, "a snooze does not bring it back");
  // Just after midnight: the evening before.
  const late = timeReminder("r3", "task3", { at: "00:10", date: "2026-11-19", tz: "" }, NOW, TZ);
  assert.equal(late.at, "23:55"); assert.equal(late.until, "00:10"); assert.equal(late.date, "2026-11-18");
  assert.ok(cleanReminder(late, NOW));
  // A weekly repeat keeps its days, 15 minutes earlier; one just after midnight moves to the day before.
  const w = timeReminder("r2", "task2", { at: "07:00", days: [1, 2, 3, 4, 5], tz: "Asia/Dubai" }, NOW, TZ);
  assert.equal(w.date, undefined); assert.deepEqual(w.days, [1, 2, 3, 4, 5]); assert.equal(w.tz, "Asia/Dubai"); assert.equal(w.at, "06:45");
  assert.deepEqual(cleanReminder(w, NOW)?.days, [1, 2, 3, 4, 5]);
  const wl = timeReminder("r4", "task4", { at: "00:05", days: [0, 1], tz: "" }, NOW, TZ);
  assert.equal(wl.at, "23:50"); assert.deepEqual(wl.days, [0, 6]);
  assert.equal(NL_REMIND_LEAD, 15);
});
ok("the Add task window: the typed words fill in How often, When and Repeats", () => {
  const o = quickDefaults("2026-11-17");
  assert.deepEqual(nlAddOpts(o, parseTaskText("Friday deck", NOW, TZ)!), { ...o, when: "date", date: "2026-11-20" });
  assert.equal(nlAddOpts(o, parseTaskText("gym every day", NOW, TZ)!).kind, "daily");
  const g = parseTaskText("gym every other Friday", NOW, TZ)!;
  assert.equal(nlAddOpts(o, g).kind, "repeat");
  assert.deepEqual(nlRule(g), { kind: "repeat", every: 2, unit: "week", from: "2026-11-20" });
  assert.equal(nlRule(parseTaskText("Friday deck", NOW, TZ)!), null);
});

// ---------- the chip's state ----------
const at = (s: string, st = nlStart()) => { const p = parseTaskText(s, NOW, TZ, { keep: st.kept }); return { p, st: nlTyped(st, s, p) }; };
ok("typed, then Add takes it", () => {
  const { p, st } = at("call bank tomorrow");
  assert.ok(nlOnAdd(st, p));
});
ok("the chip clicked: the words stay text until they are gone", () => {
  let { p, st } = at("Friday deck");
  st = nlDismiss(st, p);
  ({ p, st } = at("Friday deck review", st));
  assert.equal(p, null);
  assert.equal(nlOnAdd(st, p), null);
  ({ p, st } = at("deck review", st));         // Friday deleted: forgotten
  assert.deepEqual(st.kept, []);
  ({ p, st } = at("deck review Friday", st));  // typed again: offered again
  assert.ok(nlOnAdd(st, p));
});
ok("a date picked in Advanced after typing wins; typing a new phrase wins again", () => {
  let { p, st } = at("call tomorrow");
  st = nlPicked(st);
  assert.equal(nlOnAdd(st, p), null);
  ({ p, st } = at("call tomorrow at 5", st));
  assert.ok(nlOnAdd(st, p));
});
ok("the same text twice changes nothing", () => {
  const a = at("call tomorrow");
  assert.equal(nlTyped(a.st, "call tomorrow", a.p), a.st);
});
ok("Backspace right after the words says no", () => {
  const p = parseTaskText("call tomorrow", NOW, TZ)!;
  assert.equal(nlBackspace(p, 13, 13), true);
  assert.equal(nlBackspace(p, 4, 4), false);
  assert.equal(nlBackspace(p, 5, 13), false);
  assert.equal(nlBackspace(null, 13, 13), false);
});
ok("calm while typing: words at the end wait a moment, words before the caret show at once", () => {
  const p = parseTaskText("call Fri", NOW, TZ);
  assert.equal(settled(p, "call Fri", 0), false);
  assert.equal(settled(p, "call Fri", SETTLE_MS), true);
  assert.equal(settled(p, "call Fri ", 0), true);
  const q = parseTaskText("Fri call", NOW, TZ);
  assert.equal(settled(q, "Fri call", 0), true);
  assert.equal(settled(null, "x", 9999), false);
});

// ---------- the repeat model: weekly rules on several days (core/repeat.ts) ----------
const wk: Repeat = { every: 1, unit: "week", from: "2026-11-17", days: [1, 2, 3, 4, 5] };
ok("weekdays: Friday's next round is Monday", () => {
  assert.equal(nextAfter(wk, "2026-11-20"), "2026-11-23");
  assert.equal(nextAfter(wk, "2026-11-17"), "2026-11-18");
  assert.equal(nextAfter(wk, "2026-11-16"), "2026-11-17");   // never before from
});
ok("every other week on Mon and Thu", () => {
  const r: Repeat = { every: 2, unit: "week", from: "2026-11-19", days: [1, 4] };
  assert.equal(nextAfter(r, "2026-11-19"), "2026-11-30");   // the next counting week's Monday
  assert.equal(nextAfter(r, "2026-11-30"), "2026-12-03");
  assert.equal(nextAfter(r, "2026-12-03"), "2026-12-14");
});
ok("cleanRepeat keeps days, sorts them, moves from onto the first of them", () => {
  assert.deepEqual(cleanRepeat({ every: 1, unit: "week", from: "2026-11-21", days: [5, 1, 1, 9, "x"] }, "2026-11-17"), { every: 1, unit: "week", from: "2026-11-23", days: [1, 5] });
  assert.deepEqual(cleanRepeat({ every: 1, unit: "week", from: "2026-11-17", days: [5] }, "2026-11-17"), { every: 1, unit: "week", from: "2026-11-20" });
  assert.deepEqual(cleanRepeat({ every: 1, unit: "month", from: "2026-11-17", days: [1] }, "2026-11-17"), { every: 1, unit: "month", from: "2026-11-17" });
  assert.deepEqual(cleanRepeat({ every: 1, unit: "week", from: "2026-11-17" }, "2026-11-17"), { every: 1, unit: "week", from: "2026-11-17" });
});
ok("labels", () => {
  assert.equal(repeatLabel(wk), "Every weekday");
  assert.equal(daysLabel([0, 6]), "Every weekend");
  assert.equal(daysLabel([4, 1], 2), "Every other week: Mon and Thu");
  assert.equal(daysLabel([0, 3, 1]), "Every Mon, Wed and Sun");
  assert.equal(repeatLabel({ every: 1, unit: "week", from: "2026-11-17" }), "Every week");
});
ok("End of day moves a weekday task on to the next weekday, and it waits out of sight on Saturday", () => {
  const t = { type: "daily" as const, done: true, due: "2026-11-20", repeat: wk };
  assert.deepEqual(resetPatch(t, "2026-11-20")?.due, "2026-11-23");
  assert.equal(isDueNow({ type: "daily", done: false, due: "2026-11-23", repeat: wk }, "2026-11-21"), false);
});

// ---------- wiring ----------
ok("the add window and Dimension X use the parser behind the nl-dates switch", () => {
  const map = readFileSync(new URL("../src/views/TaskMap.tsx", import.meta.url), "utf8");
  assert.ok(/useNlDates\(/.test(map) && /nl\.take\(/.test(map), "AddTaskWindow reads the typed date");
  const dx = readFileSync(new URL("../src/views/DimensionX.tsx", import.meta.url), "utf8");
  assert.ok(/useNlDates\(/.test(dx), "Dimension X's add box reads it too");
  const hook = readFileSync(new URL("../src/views/NlDates.tsx", import.meta.url), "utf8");
  assert.ok(hook.includes('feature("nl-dates")'), "gated by the feature switch");
  const reg = JSON.parse(readFileSync(new URL("../../features.json", import.meta.url), "utf8")) as { features: { id: string; since: string; owner: string; scope: string; default: string }[] };
  const f = reg.features.find((x) => x.id === "nl-dates");
  assert.ok(f && f.since === "1.65" && f.owner === "jan" && f.scope === "shared" && f.default === "on");
  const tour = readFileSync(new URL("../src/core/tour.ts", import.meta.url), "utf8");
  assert.ok(tour.includes('ids: ["nl-dates"]'), "a step in the 1.65 tour");
  const feats = readFileSync(new URL("../../FEATURES.md", import.meta.url), "utf8");
  assert.ok(feats.includes("Dates in plain words"), "FEATURES.md line");
});

if (fails.length) { console.error(fails.join("\n")); console.error(`${fails.length} failed, ${n} passed`); process.exit(1); }
console.log(`${n} passed`);
