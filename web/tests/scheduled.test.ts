// Run: node --experimental-strip-types tests/scheduled.test.ts
// Scheduled tasks (PS 1.75, core/scheduled.ts): a one-off with a later day waits out of the list, Priority 1, the island, the
// P1 clock and the nags until its day, and shows in the Scheduled row; typed dates in numbers; editing schedules like adding;
// refuse and retype for every chip; the switch off is 1.74; the Time zones box reads 22.15 and 22,15. FICTIONAL data only.
import assert from "node:assert/strict";
import { SCHED_TITLE, doTodayPatch, schedCut, schedDay, schedLabel, scheduledList, setSchedWall, setScheduledGate, waitsForDay, withoutWaiting } from "../src/core/scheduled.ts";
import { landDayAt, dayStartAt, landsOn, waitsToLand, type DayRule } from "../src/core/clientwork.ts";
import { tabLists } from "../src/core/groups.ts";
import { islandState } from "../src/core/island.ts";
import { p1OwnStamps } from "../src/core/duealerts.ts";
import { nlDismiss, nlOnAdd, nlStart, nlStartFor, nlTyped, parseTaskText, type NlState } from "../src/core/nldates.ts";
import { parsePrio, prioDismiss, prioOffer, prioStart, prioTyped } from "../src/core/typedprio.ts";
import { parseTyped, stepTyped, timeSpans } from "../src/core/tzconvert.ts";
import { mergeStale } from "../src/core/keepedits.ts";
import type { Doc, Todo } from "../src/core/model.ts";
import { readFileSync } from "node:fs";
import { INTROS } from "../src/core/featureintro.ts";
import { insideLit } from "../src/core/typedprio.ts";
import { renamedDate } from "../src/core/nldates.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const doc = (id: string, data: Partial<Todo>): Doc<Todo> => ({ id, ws: null, kind: "todo", author: null, updatedAt: null,
  data: { title: id, type: "once", done: false, order: 0, createdAt: "2026-11-20T08:00:00.000Z", ...data } as Todo });
const DAY = "2026-11-22";
const on = (fn: () => void) => { setScheduledGate(() => true); try { fn(); } finally { setScheduledGate(null); } };

// ---------- the rule ----------
ok("Only an open one-off with a later due day waits; repeats, done, cleared, client do dates and today do not", () => {
  assert.equal(schedDay({ type: "once", done: false, due: "2026-11-23" }), "2026-11-23");
  assert.equal(schedDay({ type: "daily", done: false, due: "2026-11-23" }), null, "a repeat keeps landing as before");
  assert.equal(schedDay({ type: "once", done: true, due: "2026-11-23" }), null);
  assert.equal(schedDay({ type: "once", done: false, due: "2026-11-23", clearedAt: "x" }), null);
  assert.equal(schedDay({ type: "once", done: false, due: "2026-11-23", doOn: "2026-11-24" }), null, "Clients do dates land by their own rule");
  assert.equal(schedDay({ type: "once", done: false, due: "soon" }), null);
  assert.equal(waitsForDay({ type: "once", done: false, due: "2026-11-23" }, DAY, true), true);
  assert.equal(waitsForDay({ type: "once", done: false, due: DAY }, DAY, true), false, "on its day it is in the list");
  assert.equal(waitsForDay({ type: "once", done: false, due: "2026-11-01" }, DAY, true), false, "a past day is overdue as before, not hidden");
  assert.equal(waitsForDay({ type: "once", done: false, due: "2026-11-23" }, DAY, false), false, "switch off: 1.74");
});

ok("The switch decides waitsToLand: on, a scheduled task waits; off, only client do dates wait (1.74)", () => {
  const t = { type: "once" as const, done: false, due: "2026-11-25" };
  assert.equal(waitsToLand(t, DAY), false, "no registry in a test: off");
  on(() => { assert.equal(waitsToLand(t, DAY), true); assert.equal(landsOn(t, DAY), "2026-11-25"); });
  assert.equal(landsOn({ type: "once", done: false, doOn: "2026-11-24" }, DAY), "2026-11-24");
});

ok("Old data: a one-off saved with a later day before 1.75 counts as scheduled; a repeat with a start day does not", () => on(() => {
  const all = [doc("old", { due: "2026-12-01" }), doc("rep", { type: "daily", repeat: { every: 1, unit: "week", from: "2026-12-01" }, due: "2026-12-01" })];
  assert.deepEqual(scheduledList(all, DAY).map((d) => d.id), ["old"]);
}));

// ---------- the list, Priority 1 and the island ----------
const todos = [
  doc("p1-tomorrow", { p1: true, due: "2026-11-23", order: 0 }),
  doc("p1-now", { p1: true, order: 1 }),
  doc("later", { due: "2026-11-27", order: 2 }),
  doc("soon", { due: "2026-11-23", order: 3 }),
  doc("plain", { order: 4 }),
  doc("ticked", { due: "2026-11-24", done: true, order: 5 }),
];
ok("Before its day a scheduled P1 is in no list and no priority group; on its day it is back in P1", () => on(() => {
  const l = tabLists(todos, [], DAY, undefined, DAY);
  assert.deepEqual(l.p1.map((d) => d.id), ["p1-now"]);
  assert.deepEqual(l.prio.map((d) => d.id), ["plain"]);
  const next = tabLists(todos, [], "2026-11-23", undefined, "2026-11-23");
  assert.deepEqual(next.p1.map((d) => d.id), ["p1-tomorrow", "p1-now"]);
  assert.deepEqual(next.prio.map((d) => d.id), ["soon", "plain"]);
}));
ok("Switch off equals 1.74: every open one-off shows where it did", () => {
  const l = tabLists(todos, [], DAY, undefined, DAY);
  assert.deepEqual(l.p1.map((d) => d.id), ["p1-tomorrow", "p1-now"]);
  assert.deepEqual(scheduledList(todos, DAY, false), []);
});
ok("The Scheduled row: soonest first, then list order; ticked ones leave it; labels Tomorrow and Fri 27 Nov", () => on(() => {
  const l = scheduledList(todos, DAY);
  assert.deepEqual(l.map((d) => d.id), ["p1-tomorrow", "soon", "later"]);
  assert.deepEqual(l.map((d) => schedLabel(d.data.due!, DAY)), ["Tomorrow", "Tomorrow", "Fri 27 Nov"]);
  assert.equal(schedLabel("2027-01-04", DAY), "Mon 4 Jan 2027", "another year says the year");
  assert.equal(SCHED_TITLE, "Scheduled");
  assert.deepEqual(doTodayPatch(DAY), { due: DAY });
  const ai = [doc("inbox", { due: "2026-11-25", aiInbox: true })];
  assert.deepEqual(scheduledList(ai, DAY), [], "the AI Inbox keeps its own tasks");
}));
ok("The island: a scheduled task is never next up nor the working task, even if it was working before", () => on(() => {
  const s = islandState({ todos, today: DAY, land: DAY, mail: 0, leads: 0, event: null, settings: { workingIds: ["p1-tomorrow"] } as never });
  assert.equal(s.task?.id, "p1-now");
  const t = islandState({ todos, today: "2026-11-23", land: "2026-11-23", mail: 0, leads: 0, event: null, settings: { workingIds: ["p1-tomorrow"] } as never });
  assert.equal(t.task?.id, "p1-tomorrow");
}));

// ---------- the day boundary ----------
const noon: DayRule = { on: true, prefs: { mode: "daily", at: "12:00", days: [] }, tz: "Asia/Dubai", dayEndsHour: 0 };
const prague: DayRule = { on: true, prefs: { mode: "daily", at: "00:00", days: [] }, tz: "Europe/Prague", dayEndsHour: 0 };
ok("It lands at the person's own day start in their zone: 12:00 Dubai, midnight Prague, also on the clock change night", () => on(() => {
  const t = { type: "once" as const, done: false, due: "2026-11-25" };
  assert.equal(waitsForDay(t, landDayAt(Date.parse("2026-11-25T11:59:00+04:00"), noon)), true, "before noon it is still the 24th for a noon day end");
  assert.equal(waitsForDay(t, landDayAt(Date.parse("2026-11-25T12:00:00+04:00"), noon)), false);
  const dst = { type: "once" as const, done: false, due: "2026-10-25" };   // Europe's clocks go back on 25 Oct 2026
  assert.equal(waitsForDay(dst, landDayAt(Date.parse("2026-10-24T23:59:00+02:00"), prague)), true);
  assert.equal(waitsForDay(dst, landDayAt(Date.parse("2026-10-25T00:00:00+02:00"), prague)), false);
  const spring = { type: "once" as const, done: false, due: "2026-03-29" };
  assert.equal(waitsForDay(spring, landDayAt(Date.parse("2026-03-28T23:30:00+01:00"), prague)), true);
  assert.equal(waitsForDay(spring, landDayAt(Date.parse("2026-03-29T03:30:00+02:00"), prague)), false);
}));

// ---------- the P1 clock and the nags ----------
ok("P1 clock: none before its day (an old one is taken off), and on its day it starts when the day started", () => on(() => {
  const day = "2026-11-25", now = Date.parse("2026-11-25T15:00:00+04:00");
  const start = dayStartAt(now, noon);
  assert.equal(new Date(start).toISOString(), "2026-11-25T08:00:00.000Z");
  const waits = (d: string) => (t: unknown) => waitsForDay(t as never, d, true);
  const t = [{ id: "a", data: { ...doc("a", { p1: true, due: day, p1Since: "2026-11-20T09:00:00.000Z" }).data } }];
  // Break-it 1.75: an old stamp is left alone while it waits (taking it off would fight a 1.74 device that stamps it back) ...
  assert.deepEqual(p1OwnStamps(t, Date.parse("2026-11-24T15:00:00+04:00"), { waits: waits("2026-11-24") }), []);
  // ... and starts again at the landing, once; the new stamp then stays.
  assert.deepEqual(p1OwnStamps(t, now, { waits: waits(day), landStart: start, landDay: day }), [{ id: "a", p1Since: "2026-11-25T08:00:00.000Z" }]);
  const restamped = [{ id: "a", data: { ...t[0].data, p1Since: "2026-11-25T08:00:00.000Z" } }];
  assert.deepEqual(p1OwnStamps(restamped, now, { waits: waits(day), landStart: start, landDay: day }), [], "stable: nothing to write again");
  // A 1.74 device stamping the waiting task and this one answering: nothing is written back, so they never loop.
  const by174 = [{ id: "a", data: { ...t[0].data, p1Since: "2026-11-24T11:00:00.000Z" } }];
  assert.deepEqual(p1OwnStamps(by174, Date.parse("2026-11-24T15:00:00+04:00"), { waits: waits("2026-11-24") }), []);
  const fresh = [{ id: "a", data: { ...doc("a", { p1: true, due: day }).data } }];
  assert.deepEqual(p1OwnStamps(fresh, Date.parse("2026-11-24T15:00:00+04:00"), { waits: waits("2026-11-24") }), [], "nothing stamped while it waits");
  const untouched = [{ ...fresh[0], updatedAt: "2026-11-24T09:00:00.000Z" }];
  assert.deepEqual(p1OwnStamps(untouched, now, { waits: waits(day), landStart: start, landDay: day }), [{ id: "a", p1Since: "2026-11-25T08:00:00.000Z" }],
    "PS closed over the day end: the 24 hours still start at the landing");
  // Break-it 1.75: made P1 later on its day (the doc changed after the landing) starts then, not at the start of the day.
  const madeLater = [{ ...fresh[0], updatedAt: "2026-11-25T11:00:00.000Z" }];
  assert.deepEqual(p1OwnStamps(madeLater, now, { waits: waits(day), landStart: start, landDay: day }), [{ id: "a", p1Since: new Date(now).toISOString() }]);
  const notSynced = [{ ...untouched[0], pending: true }];
  assert.deepEqual(p1OwnStamps(notSynced, now, { waits: waits(day), landStart: start, landDay: day }), [{ id: "a", p1Since: new Date(now).toISOString() }], "an edit not synced yet: from now");
  assert.deepEqual(p1OwnStamps(fresh, now, { waits: waits(day), landStart: start, landDay: day }), [{ id: "a", p1Since: new Date(now).toISOString() }], "no change time known: from now, never earlier");
  const today = [{ id: "b", data: { ...doc("b", { p1: true, due: day, createdAt: "2026-11-25T10:00:00.000Z" }).data } }];
  assert.deepEqual(p1OwnStamps(today, now, { waits: waits(day), landStart: start, landDay: day }), [{ id: "b", p1Since: new Date(now).toISOString() }], "added today: from now");
  assert.deepEqual(p1OwnStamps(fresh, now), [{ id: "a", p1Since: new Date(now).toISOString() }], "switch off: as in 1.74");
}));
ok("Nags and alarms leave out the waiting tasks", () => on(() => {
  assert.deepEqual(withoutWaiting(todos, DAY).map((d) => d.id), ["p1-now", "plain", "ticked"]);
  assert.equal(withoutWaiting(todos, DAY, false).length, todos.length);
}));
ok("A scheduled task ticked is done: it leaves the Scheduled row and nothing waits", () => on(() => {
  const t = doc("x", { due: "2026-11-30", done: true });
  assert.equal(waitsForDay(t.data, DAY), false);
}));

// ---------- sync ----------
ok("The day merges like any task field: the other device's new day is kept beside this device's title edit", () => {
  const base = { title: "deck", type: "once", done: false, order: 0, due: null } as unknown as Record<string, unknown>;
  const mine = { ...base, title: "deck v2" }, theirs = { ...base, due: "2026-11-25" };
  const m = mergeStale(base, mine, theirs) as Record<string, unknown>;
  assert.equal(m.title, "deck v2"); assert.equal(m.due, "2026-11-25");
});

// ---------- typed dates ----------
const NOW = Date.UTC(2026, 10, 22, 10, 0);
// Dates in numbers are read only while "scheduled-tasks" is on (views/NlDates.tsx passes numDates); these tests read them.
const p = (s: string, o = {}) => parseTaskText(s, NOW, "Europe/Bratislava", { numDates: true, ...o });
const due = (s: string, o = {}) => p(s, o)?.due ?? null;
ok("Dates in numbers: 25.11, 25.11., 25/11, 25 11, 25.11.2026, 2026-11-25, Nov 25, 25 Nov, the 25th", () => {
  for (const s of ["pay 25.11", "pay 25.11.", "pay 25/11", "pay 25 11", "pay 25.11.2026", "pay 2026-11-25", "pay Nov 25", "pay 25 Nov", "pay the 25th", "pay on 25.11"]) {
    assert.equal(due(s), "2026-11-25", s); assert.equal(p(s)!.title, "pay", s);
  }
  assert.equal(due("pay 25/11", { dayFirst: true }), "2026-11-25");
  assert.equal(due("pay on 4/12", { dayFirst: true }), "2026-12-04", "dayFirst still decides an ambiguous slash");
  assert.equal(due("pay on 4/12"), "2027-04-12");
  assert.equal(due("pay 5.12."), "2026-12-05", "a closing dot says date");
  assert.equal(due("the 3rd at 10"), "2026-12-03");
});
ok("Protections stay: fractions, 24/7, prices, amounts, decimals, versions, times like 22.15, a bare number", () => {
  for (const s of ["1/2 cup", "3/4 inch", "24/7 support", "call 22.15", "call 10.30", "call 9.30", "price $25.11", "25.11 kg", "12.10 EUR", "2.5 hours",
    "version 1.2.3", "buy 3 4", "room 25", "the 3rd floor", "page 12 of 30", "0.0", "31.02.", "32.13.", "25,11"]) assert.equal(p(s), null, s);
  assert.equal(p("call at 22.15")?.time, "22:15", "with at it is still a time");
});
ok("Break it: wrong days, a past date, year ends, two dates, a title that is only a date", () => {
  assert.equal(due("bills 31.12."), "2026-12-31");
  assert.equal(due("bills 1.1."), "2027-01-01", "a day already past this year is next year");
  assert.equal(due("call 10.11."), "2027-11-10");
  assert.equal(due("leap 29.02.2028"), "2028-02-29"); assert.equal(p("leap 29.02.2027"), null);
  const two = p("deck 25.11 and 28.11")!;
  assert.equal(two.due, "2026-11-28"); assert.equal(two.title, "deck 25.11 and", "the last date wins, the other stays text");
  assert.equal(p("25.11")!.title, "", "nothing left to call it: the add box keeps it as typed (views/NlDates.tsx)");
  assert.equal(due("tmrw P1 deck"), "2026-11-23");
});

// ---------- refuse and retype, every chip ----------
function follow(st: NlState, text: string) { const q = p(text, { keep: st.kept }); return { st: nlTyped(st, text, q), q }; }
ok("Dates, times and repeats: one click refuses and it stays text while typing on; delete and retype offers it again", () => {
  for (const [typed, more] of [["call tomorrow", " Alex"], ["gym at 9pm", " now"], ["report every Friday", " please"], ["pay 25.11", " fast"]]) {
    let { st, q } = follow(nlStart(), typed);
    assert.ok(nlOnAdd(st, q), typed);
    st = nlDismiss(st, q);
    ({ st, q } = follow(st, typed + more));
    assert.equal(nlOnAdd(st, q), null, `${typed}: refused stays refused`);
    ({ st, q } = follow(st, "call "));
    ({ st, q } = follow(st, typed));
    assert.ok(nlOnAdd(st, q), `${typed}: retyped is recognised again`);
  }
});
ok("Priority words: refused stays refused while typing on; delete and retype offers it again", () => {
  let st = prioTyped(prioStart(), "deck P1");
  assert.equal(prioOffer(st, "deck P1")?.prio, 1);
  st = prioDismiss(st);
  st = prioTyped(st, "deck P1 now");
  assert.equal(prioOffer(st, "deck P1 now"), null);
  st = prioTyped(st, "deck ");
  st = prioTyped(st, "deck P1");
  assert.equal(prioOffer(st, "deck P1")?.prio, 1);
  assert.equal(parsePrio("mp3 p10")?.prio, undefined);
});
ok("Editing schedules like adding: a date typed into the name is offered, words already there before are not", () => {
  const old = "Friday deck";
  let st = nlStartFor(p(old));
  let r = follow(st, old); st = r.st;
  assert.equal(nlOnAdd(st, r.q), null, "Friday was there before: it stays text");
  r = follow(st, "Friday deck tomorrow"); st = r.st;
  assert.equal(nlOnAdd(st, r.q)?.due, "2026-11-23");
  assert.equal(nlOnAdd(st, r.q)?.title, "Friday deck");
  st = nlStartFor(p("call the bank"));
  r = follow(st, "call the bank tmr");
  assert.equal(nlOnAdd(r.st, r.q)?.due, "2026-11-23", "the bug the owner hit: an edited name with tmr is scheduled");
});

// ---------- the Time zones box ----------
ok("Time zones: 22.15, 22,15, 9.30pm, 9,30 pm and 22.15. are times; stepping keeps the comma", () => {
  for (const [s, h, mi] of [["22.15", 22, 15], ["22,15", 22, 15], ["9.30pm", 21, 30], ["9,30 pm", 21, 30], ["22.15.", 22, 15], ["14:00", 14, 0], ["1430", 14, 30]] as const)
    assert.deepEqual(parseTyped(s), { h, mi, zone: undefined }, s);
  for (const s of ["22,1", "25,75", "1/2"]) assert.equal(parseTyped(s), null, s);
  assert.deepEqual(timeSpans("22,15")?.min, [3, 5]);
  assert.equal(stepTyped("22,15", "min", 1)?.text, "22,30");
});

// ---------- the switch and the registry ----------
ok("features.json, FEATURES.md, Settings and the literal id at every ask", () => {
  const reg = JSON.parse(readFileSync(new URL("../../features.json", import.meta.url), "utf8")).features.find((f: { id: string }) => f.id === "scheduled-tasks");
  assert.deepEqual([reg.owner, reg.scope, reg.since, reg.default, reg.parts], ["jan", "shared", "1.75", "off", ["web"]], "off by default (break-it 1.75)");
  assert.match(readFileSync(new URL("../../FEATURES.md", import.meta.url), "utf8"), /\| Hide tasks until their day \|.*Settings, Your list, "Hide tasks until their day"/);
  const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  for (const f of ["core/scheduled.ts", "views/SettingsGroups.tsx", "views/FeatureIntro.tsx"]) assert.ok(src(f).includes('feature("scheduled-tasks")'), f);
  assert.ok(src("core/settingsindex.ts").includes('id: "scheduled-tasks"'));
  // Break-it 1.75: off by default, so the intro is an offer with Turn on, and it never says a task is already hidden.
  const intro = INTROS.find((d) => d.id === "scheduled-tasks-175")!;
  assert.deepEqual([intro.show, intro.later, intro.choice], ["Turn on", "Not now", true]);
  assert.ok(!/now wait|are hidden|stays in/i.test(`${intro.headline} ${intro.ask}`), "never claims tasks already wait");
  assert.ok(!/[\u2013\u2014]/.test(`${intro.headline} ${intro.ask}`));
  const fi = src("views/FeatureIntro.tsx");
  assert.match(fi, /"scheduled-tasks-175": \(yes, s\) => \{ if \(yes\) void saveSettings\(\{ squadFeatures: \{[^}]*"scheduled-tasks": true/, "Turn on saves the Settings switch");
  assert.match(fi, /"scheduled-tasks-175": async[^\n]*feature\("scheduled-tasks"\) \? "done" : "open"/, "shown only while it is off");
  for (const f of ["core/scheduled.ts", "views/Scheduled.tsx"]) assert.ok(!/[\u2013\u2014]/.test(src(f)), `no en or em dashes in ${f}`);
});
ok("A click inside lit words refuses them; at their edges it does not (typing on after them still works)", () => {
  const spans = [{ start: 5, end: 13 }];
  assert.equal(insideLit(8, 8, spans), true);
  assert.equal(insideLit(5, 5, spans), false); assert.equal(insideLit(13, 13, spans), false);
  assert.equal(insideLit(6, 9, spans), false, "a selection is not a refusal");
  assert.equal(insideLit(null, null, spans), false);
});
ok("A renamed card: a newly typed date schedules it, words that were there before do not", () => {
  assert.equal(renamedDate("call the bank", "call the bank tmr", NOW, "Europe/Bratislava")?.due, "2026-11-23");
  assert.equal(renamedDate("Friday deck", "Friday deck v2", NOW, "Europe/Bratislava"), null);
  assert.equal(renamedDate("deck", "tomorrow", NOW, "Europe/Bratislava"), null, "nothing left to call it");
  assert.equal(renamedDate("gym", "gym every Monday", NOW, "Europe/Bratislava"), null, "a repeat is not a schedule");
});
ok("The person's own day: typed today and tomorrow follow their Day ends when it is given", () => {
  const late = Date.parse("2026-11-25T02:10:00+04:00");   // still Tuesday the 24th for a 12:00 day end
  assert.equal(parseTaskText("deck today", late, "Asia/Dubai", { today: "2026-11-24" })?.due, "2026-11-24");
  assert.equal(parseTaskText("deck tomorrow", late, "Asia/Dubai", { today: "2026-11-24" })?.due, "2026-11-25");
  assert.equal(parseTaskText("deck at 9", late, "Asia/Dubai", { today: "2026-11-24" })?.due, "2026-11-25", "a time with no day still follows the clock");
});

// ---------- break-it 1.75 ----------
ok("Off is 1.74: list, Priority 1, the P1 clock, nags, the island, the Scheduled row", () => {
  setScheduledGate(() => false);
  try {
    const client = doc("client-later", { clientId: "c1", doOn: "2026-11-25", order: 7 });
    const all = [...todos, client];
    const l = tabLists(all, [], DAY, undefined, DAY);
    // 1.74: every open one-off is in the list (a client task before its do date waits, as in 1.73).
    assert.deepEqual(l.ranked.map((d) => d.id).sort(), all.filter((d) => !d.data.done && d.id !== "client-later").map((d) => d.id).sort());
    assert.ok(l.p1.some((d) => d.id === "p1-tomorrow"), "a P1 for tomorrow is in Priority 1 today, as in 1.74");
    assert.deepEqual(scheduledList(all, DAY), [], "no Scheduled row");
    assert.deepEqual(withoutWaiting(all, DAY), all, "nags and alarms see every task");
    const fresh = [{ id: "a", data: { ...doc("a", { p1: true, due: "2026-11-23" }).data }, updatedAt: "2026-11-20T08:00:00.000Z" }];
    const now = Date.parse("2026-11-22T15:00:00Z");
    assert.deepEqual(p1OwnStamps(fresh, now, {}), [{ id: "a", p1Since: new Date(now).toISOString() }], "its P1 clock starts at once, as in 1.74");
    const isl = islandState({ todos: all, today: DAY, land: DAY, mail: 0, leads: 0, event: null, settings: { workingIds: ["client-later"] } as never });
    assert.equal(isl.task?.id, "client-later", "the working task shows whatever it is, as in 1.74");
    const isl2 = islandState({ todos: all, today: DAY, land: DAY, mail: 0, leads: 0, event: null, settings: { workingIds: ["p1-tomorrow"] } as never });
    assert.equal(isl2.task?.id, "p1-tomorrow");
  } finally { setScheduledGate(null); }
});
ok("Off is 1.74: the parser reads exactly what the 1.74 parser read (recorded from v1.74, dayFirst on and off, at 00:30)", () => {
  const want = JSON.parse(readFileSync(new URL("./scheduled-174-parser.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const NOW2 = Date.UTC(2026, 10, 22, 23, 30);
  for (const [k, v] of Object.entries(want)) {
    const [df, text] = [k.startsWith("D|"), k.slice(2)];
    const q = parseTaskText(text, NOW2, "Europe/Bratislava", { dayFirst: df, dayEndsHour: 4 });
    assert.deepEqual(q ? [q.kind, q.due ?? null, q.time ?? null, q.title] : null, v, k);
  }
  assert.ok(Object.keys(want).length >= 70);
});
ok("A task is never kept out on its own calendar date (a noon day end: 'call at 9' typed at 02:10 is in the list)", () => on(() => {
  const t = { type: "once" as const, done: false, due: "2026-11-25" };
  const land = landDayAt(Date.parse("2026-11-25T02:10:00+04:00"), noon);
  assert.equal(land, "2026-11-24", "the land day is still yesterday before noon");
  assert.equal(waitsForDay(t, land, true, null), true, "the land day alone would hide it until noon");
  assert.equal(waitsForDay(t, land, true, "2026-11-25"), false, "its calendar date has come: it is in the list");
  assert.equal(waitsForDay({ ...t, due: "2026-11-26" }, land, true, "2026-11-25"), true, "tomorrow still waits");
  assert.equal(schedCut(land, "2026-11-25"), "2026-11-25");
  assert.equal(schedCut("2026-11-25", "2026-11-24"), "2026-11-25", "a late day end (23:00) names the day ahead: its tasks land with it");
  setSchedWall(() => "2026-11-25");
  try {
    assert.deepEqual(scheduledList([doc("x", { due: "2026-11-25" }), doc("y", { due: "2026-11-26" })], land).map((d) => d.id), ["y"]);
    assert.deepEqual(withoutWaiting([doc("x", { due: "2026-11-25" })], land).map((d) => d.id), ["x"]);
    assert.equal(tabLists([doc("x", { due: "2026-11-25", p1: true })], [], land, undefined, land).p1.length, 1, "in Priority 1 on its date");
  } finally { setSchedWall(null); }
  // The old "today" from the land day saved yesterday's date for a noon day end; the add boxes no longer pass it.
  const nl = readFileSync(new URL("../src/views/NlDates.tsx", import.meta.url), "utf8");
  assert.ok(!/today: scheduledOn\(\)/.test(nl), "typed today and tomorrow are the calendar's, as in 1.74");
}));
ok("Number dates: no false hits after counting words, in ranges or with units; 24 7 stays text", () => {
  for (const s of ["score 26.10", "page 25.10", "team of 25 12", "line 29 11", "chapter 25 11", "age 28 12", "set 1 to 25 12", "vote 24 7",
    "grade 28.12 percent", "sprint 25.11-28.11", "sprint 25.11 - 28.11", "score 21/12", "buy 25 12 packs", "pay 25.11 EUR", "temp 36.12"]) assert.equal(p(s), null, s);
  assert.equal(due("gym 30.11"), "2026-11-30"); assert.equal(due("send 30 11"), "2026-11-30"); assert.equal(due("from 25 11 x"), null);
  assert.equal(p("from 25 11")?.title, "", "from is taken with the date, nothing left: the box keeps it as typed");
  assert.equal(due("pay 25.11", {}), "2026-11-25", "the test helper reads number dates");
  assert.equal(parseTaskText("pay 25.11", NOW, "Europe/Bratislava"), null, "without numDates (the switch off) it is text, as in 1.74");
});
ok("Editing: a typed time stays text (the Editor and a rename put no reminder on it), a date alone schedules", () => {
  assert.equal(renamedDate("call Alex", "call Alex at 9", NOW, "Europe/Bratislava", { numDates: true }), null);
  assert.equal(renamedDate("call Alex", "call Alex tomorrow 9am", NOW, "Europe/Bratislava", { numDates: true }), null);
  assert.equal(renamedDate("call Alex", "call Alex tomorrow", NOW, "Europe/Bratislava", { numDates: true })?.due, "2026-11-23");
  const tm = readFileSync(new URL("../src/views/TaskMap.tsx", import.meta.url), "utf8");
  assert.match(tm, /useNlDates\(title, \{ once: true, existing: t\.title, off: type !== "once" \|\| !schedOn, dateOnly: true \}\)/, "off: the Editor reads no dates (1.74)");
  const dx = readFileSync(new URL("../src/views/DimensionX.tsx", import.meta.url), "utf8");
  assert.match(dx, /if \(!nlDatesOn\(\) \|\| !scheduledOn\(\)\) return null;/, "off: a renamed card reads no dates (1.74)");
});
ok("Esc on the open Scheduled row uses the key, so the list under it stays", () => {
  const sc = readFileSync(new URL("../src/views/Scheduled.tsx", import.meta.url), "utf8");
  assert.match(sc, /e\.key === "Escape" && !editingHere\) \{ e\.preventDefault\(\); e\.stopImmediatePropagation\(\); setOpen\(false\);/);
});
ok("Off is 1.74 on the phone widget count: nothing is left out unless the switch is on", () => {
  const br = readFileSync(new URL("../src/gos/bridge.ts", import.meta.url), "utf8");
  assert.match(br, /const day = scheduledOn\(\) \? landDayNow\(s\) : null;/);
  assert.match(br, /!\(day && waitsToLand\(d\.data, day\)\)/);
});

console.log(`${n} passed`);
