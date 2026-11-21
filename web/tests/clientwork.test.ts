// Run: node --experimental-strip-types tests/clientwork.test.ts
// The Clients workspace's scheduling rules (PS 1.73, core/clientwork.ts): which day it is by the day end (the developer's 12:00 GST, a
// midnight person, an evening day end, week mode, the countdown off), weekday repeats, one day tasks, do date against the
// deadline, P1 landing, no duplicates, templates and the stage line. FICTIONAL data only.
import assert from "node:assert/strict";
import {
  addStage, clampDoOn, clientDueToday, comesInWords, cleanTpl, colourOf, dayEndAt, dayStartAt, daysOf, daysWords, deadlinePill,
  deadlineWords, doOnFor, followCall, fromTemplate, gapOf, landDayAt, landWords, landed, layStages, moveDeadline, moveStage,
  percentDone, removeStage, reorder, repeatFor, repeatPatch, sectionOf, setDone, snapEdge, stageEdges, stageLine, stageWidths,
  templateOf, toggleDay, waitsToLand, type DayRule,
} from "../src/core/clientwork.ts";
import { tabLists } from "../src/core/groups.ts";
import { resetPatch } from "../src/core/repeat.ts";
import type { Doc, Todo } from "../src/core/model.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const GST = "Asia/Dubai";
const at = (iso: string) => Date.parse(iso);
const red: DayRule = { on: true, prefs: { mode: "daily", at: "12:00", days: [] }, tz: GST, dayEndsHour: 15 };
const midnight: DayRule = { on: true, prefs: { mode: "daily", at: "00:00", days: [] }, tz: GST, dayEndsHour: 15 };
const evening: DayRule = { on: true, prefs: { mode: "daily", at: "23:00", days: [] }, tz: GST, dayEndsHour: 15 };
let k = 0;
const key = () => `k${++k}`;
const doc = (id: string, data: Partial<Todo>): Doc<Todo> => ({ id, ws: null, kind: "todo", author: null, updatedAt: null,
  data: { title: id, type: "once", done: false, order: 0, ...data } as Todo });

// ---------- the day ----------
ok("The developer at 02:10 Wednesday GST is still in Tuesday; Wednesday starts at 12:00", () => {
  assert.equal(landDayAt(at("2026-11-25T02:10:00+04:00"), red), "2026-11-24");
  assert.equal(landDayAt(at("2026-11-25T11:59:00+04:00"), red), "2026-11-24");
  assert.equal(landDayAt(at("2026-11-25T12:00:00+04:00"), red), "2026-11-25");
  assert.equal(dayEndAt(at("2026-11-25T02:10:00+04:00"), red), at("2026-11-25T12:00:00+04:00"));
  assert.equal(dayStartAt(at("2026-11-25T02:10:00+04:00"), red), at("2026-11-24T12:00:00+04:00"));
});
ok("a midnight person: the day is the date, never the day before", () => {
  assert.equal(landDayAt(at("2026-11-25T00:00:00+04:00"), midnight), "2026-11-25");
  assert.equal(landDayAt(at("2026-11-25T23:59:00+04:00"), midnight), "2026-11-25");
  assert.equal(landDayAt(at("2026-11-24T23:59:00+04:00"), midnight), "2026-11-24");
});
ok("an evening day end (23:00): the day that starts Monday 23:00 is Tuesday", () => {
  assert.equal(landDayAt(at("2026-11-23T23:30:00+04:00"), evening), "2026-11-24");
  assert.equal(landDayAt(at("2026-11-24T10:00:00+04:00"), evening), "2026-11-24");
  assert.equal(landDayAt(at("2026-11-24T22:59:00+04:00"), evening), "2026-11-24");
});
ok("week mode: each weekday can end at its own time", () => {
  const wk: DayRule = { on: true, prefs: { mode: "week", at: "12:00", days: ["12:00", "12:00", "09:00", "12:00", "12:00", "12:00", "12:00"] }, tz: GST, dayEndsHour: 15 };
  // Wednesday's day end is 09:00: Wednesday starts at 09:00 Wednesday.
  assert.equal(landDayAt(at("2026-11-25T08:59:00+04:00"), wk), "2026-11-24");
  assert.equal(landDayAt(at("2026-11-25T09:00:00+04:00"), wk), "2026-11-25");
});
ok("the countdown off: Settings 'Your work day ends at' (local time), never midnight", () => {
  const off: DayRule = { ...red, on: false, dayEndsHour: 15 };
  const d = new Date(2026, 10, 25, 14, 0), e = new Date(2026, 10, 25, 15, 0);
  assert.equal(landDayAt(d.getTime(), off), "2026-11-24");
  assert.equal(landDayAt(e.getTime(), off), "2026-11-25");
  assert.equal(dayEndAt(d.getTime(), off), e.getTime());
});

// ---------- landing ----------
ok("a one day task waits out of sight until its do date, then stays until ticked", () => {
  const t = doc("lead", { doOn: "2026-11-25", clientId: "c1" }).data;
  assert.equal(waitsToLand(t, "2026-11-24"), true);
  assert.equal(landed(t, "2026-11-24"), false);
  assert.equal(landed(t, "2026-11-25"), true);
  assert.equal(landed(t, "2026-11-27"), true);   // not done: it stays (the normal Reset rules carry it)
  assert.equal(waitsToLand({ ...t, done: true }, "2026-11-24"), false);
});
ok("the list (tabLists with the person's day): lands at 12:00, once, in the right section", () => {
  const all = [
    doc("cro", { type: "daily", p1: true, clientId: "c2" }),
    doc("lead", { doOn: "2026-11-25", clientId: "c3", order: 1 }),
    doc("deck", { doOn: "2026-11-27", p1: true, deadline: { date: "2026-11-28", time: "15:00", eventId: "ev1" }, clientId: "c2" }),
    doc("gym", { ...repeatPatch([1, 2, 4, 6], "2026-11-25") }),   // done Tuesday and Reset: waiting on Thursday
    doc("plain", { order: 2 }),
  ];
  const day = (now: string) => landDayAt(at(now), red);
  const ids = (l: Doc<Todo>[]) => l.map((d) => d.id);
  // 02:10 Wed: the developer's Tuesday. The Wed lead is not in yet.
  let L = tabLists(all, [], "2026-11-25", undefined, day("2026-11-25T02:10:00+04:00"));
  assert.deepEqual(ids(L.prio), ["plain"]);
  assert.deepEqual(ids(L.p1), ["cro"]);   // the every day P1 client task sits in Priority 1, not Every day
  assert.ok(!ids(L.daily).includes("cro"));
  // 12:00 Wed: the lead lands in Priorities; Gym (Mon Tue Thu Sat) is not in on Wednesday.
  L = tabLists(all, [], "2026-11-25", undefined, day("2026-11-25T12:00:00+04:00"));
  assert.deepEqual(ids(L.prio).sort(), ["lead", "plain"]);
  assert.ok(!ids(L.daily).includes("gym"));
  // 02:10 Thu is still the developer's Wednesday (midnight never lands it); 12:00 Thu it lands.
  assert.ok(!ids(tabLists(all, [], "2026-11-26", undefined, day("2026-11-26T02:10:00+04:00")).daily).includes("gym"));
  assert.ok(ids(tabLists(all, [], "2026-11-26", undefined, day("2026-11-26T12:00:00+04:00")).daily).includes("gym"));
  // Fri 27 Nov 12:00: the deck lands in Priority 1.
  L = tabLists(all, [], "2026-11-27", undefined, day("2026-11-27T12:00:00+04:00"));
  assert.deepEqual(ids(L.p1).sort(), ["cro", "deck"]);
  // No duplicates anywhere, on any day of two weeks.
  for (let i = 0; i < 14 * 24; i++) {
    const now = at("2026-11-23T00:00:00+04:00") + i * 3_600_000;
    const l = tabLists(all, [], "x", undefined, landDayAt(now, red));
    const seen = [...l.ranked, ...l.daily].map((d) => d.id);
    assert.equal(new Set(seen).size, seen.length);
  }
  // Without `land` nothing changes for older callers.
  assert.ok(ids(tabLists(all, [], "2026-11-24").prio).includes("lead"));
});
ok("weekday repeats: the rule, the lit chips, every day as no rule, at least one day stays", () => {
  assert.equal(repeatFor([0, 1, 2, 3, 4, 5, 6], "2026-11-24"), null);
  const r = repeatFor([1, 2, 4, 6], "2026-11-25")!;
  assert.deepEqual(r.days, [1, 2, 4, 6]);
  assert.equal(r.from, "2026-11-26");   // the first lit day from Wed is Thu
  assert.deepEqual(daysOf({ type: "daily", repeat: r }), [1, 2, 4, 6]);
  assert.deepEqual(daysOf({ type: "daily", repeat: null }), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(toggleDay([3], 3), [3]);
  assert.deepEqual(toggleDay([1, 3], 3), [1]);
  assert.deepEqual(toggleDay([1], 5), [1, 5]);
  assert.equal(daysWords([1, 2, 3, 4, 5]), "Weekdays");
  assert.equal(daysWords([0, 6]), "Weekends");
  assert.equal(daysWords([1, 2, 4, 6]), "Mon Tue Thu Sat");
  assert.equal(daysWords([0, 1, 2, 3, 4, 5, 6]), "Every day");
});
ok("a repeating task unticks itself for its next lit day at the Reset (never added again)", () => {
  const p = repeatPatch([1, 4], "2026-11-24");   // Mon Thu, from Tue
  assert.equal(p.due, "2026-11-26");
  const t = { ...doc("check", { ...p, clientId: "c1" }).data };
  assert.equal(landed(t, "2026-11-25"), false);
  assert.equal(landed(t, "2026-11-26"), true);
  const after = { ...t, done: true, ...resetPatch({ ...t, done: true }, "2026-11-26") };
  assert.equal(after.done, false);
  assert.equal(after.due, "2026-11-30");   // the next Monday
  assert.equal(landed(after as Todo, "2026-11-27"), false);
});
ok("P1 landing: P1 lands in Priority 1, else repeating in Every day, dated in Priorities", () => {
  assert.equal(sectionOf({ p1: true, type: "once" }), "p1");
  assert.equal(sectionOf({ p1: true, type: "daily" }), "p1");
  assert.equal(sectionOf({ type: "daily" }), "daily");
  assert.equal(sectionOf({ type: "once" }), "prio");
});

// ---------- do date and deadline ----------
ok("do date defaults to the deadline day, keeps its gap when the deadline moves, never after it", () => {
  assert.equal(doOnFor("2026-11-28", 0), "2026-11-28");
  assert.equal(doOnFor("2026-11-28", 1), "2026-11-27");
  assert.equal(clampDoOn("2026-11-30", "2026-11-28"), "2026-11-28");
  const t = { doOn: "2026-11-27", deadline: { date: "2026-11-28" } };
  assert.equal(gapOf(t), 1);
  assert.deepEqual(moveDeadline(t, { date: "2026-12-02" }), { deadline: { date: "2026-12-02" }, doOn: "2026-12-01" });
});
ok("a call as the deadline follows the event, and says so when it is cancelled", () => {
  const t = { doOn: "2026-11-26", deadline: { date: "2026-11-28", time: "15:00", eventId: "ev1", title: "CRO deck review" } };
  assert.equal(followCall(t, { start: new Date(2026, 10, 28, 15, 0).toISOString() }, true), null);
  const moved = followCall(t, { start: new Date(2026, 10, 30, 10, 30).toISOString() }, true)!;
  assert.equal(moved.deadline.date, "2026-11-30");
  assert.equal(moved.deadline.time, "10:30");
  assert.equal(moved.doOn, "2026-11-28");
  assert.equal(followCall(t, null, true)!.deadline.gone, true);
  assert.equal(followCall(t, null, false), null);   // a calendar that does not reach that day never calls it cancelled
});
ok("words: pills, the grey line, the purple line", () => {
  assert.equal(deadlineWords({ date: "2026-11-28", time: "15:00", eventId: "e" }), "Deadline: call Sat 28 Nov 15:00");
  assert.equal(deadlinePill({ date: "2026-11-28", time: "15:00", eventId: "e" }, "2026-11-28"), "Call today 15:00");
  assert.equal(deadlinePill({ date: "2026-11-28" }, "2026-11-28"), "Deadline today");
  const deck = { type: "once" as const, p1: true, done: false, doOn: "2026-11-27", deadline: { date: "2026-11-28" } };
  assert.equal(landWords(deck), "In Priority 1 on Fri 27 Nov, the day before the deadline");
  assert.equal(landWords({ type: "daily", repeat: repeatFor([1, 2, 3, 4, 5], "2026-11-24"), done: false }), "Weekdays, in Every day");
  assert.equal(comesInWords(deck, "2026-11-24", "12:00"),
    "Comes into your list by itself at 12:00 on Fri 27 Nov, when your Thursday ends. In Priority 1. That is the day before the deadline.");
  assert.equal(comesInWords({ type: "once", done: false, doOn: "2026-11-24" }, "2026-11-24", "12:00"), "It is in your list today, Tue 24 Nov. In Priorities.");
});

// ---------- the due today hook (p1-alarms-173) ----------
ok("clientDueToday: open client tasks in the list today, with why; never one still waiting", () => {
  const all = [
    doc("lead", { doOn: "2026-11-25", clientId: "c3" }),
    doc("deck", { doOn: "2026-11-24", deadline: { date: "2026-11-25" }, clientId: "c2" }),
    doc("later", { doOn: "2026-11-27", clientId: "c2" }),
    doc("old", { doOn: "2026-11-20", clientId: "c2" }),
    doc("done", { doOn: "2026-11-25", clientId: "c2", done: true }),
    doc("weekday", { ...repeatPatch([1, 2, 3, 4, 5], "2026-11-23"), clientId: "c1" }),
    doc("mine", { doOn: "2026-11-25" }),
  ];
  const got = clientDueToday(all, "2026-11-25").map((x) => `${x.doc.id}:${x.why}`).sort();
  assert.deepEqual(got, ["deck:deadline", "lead:do", "old:late", "weekday:repeat"]);
});

// ---------- the stage line ----------
ok("stage line: widths, edges, snap, percent, handle, add, move, remove", () => {
  const st = layStages([{ name: "Kickoff", days: 2 }, { name: "Build", days: 12 }, { name: "Launch", days: 1 }], "2026-11-16", key);
  assert.equal(st[1].start, "2026-11-18");
  assert.equal(st[2].due, "2026-11-30");
  const w = stageWidths(st);
  assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.ok(w[2] >= 0.08 - 1e-9);
  const e = stageEdges(w);
  assert.equal(e.length, 4);
  assert.equal(snapEdge(e, 0.01), 0);
  assert.equal(snapEdge(e, e[1] + 0.02), 1);
  assert.equal(snapEdge(e, 0.99), 3);
  assert.equal(percentDone(st, 0), 0);
  assert.equal(percentDone(st, 1), 13);
  assert.equal(percentDone(st, 3), 100);
  const d = setDone(st, 2, "2026-11-24");
  assert.equal(d.current, 2);
  assert.equal(d.stages[0].doneAt, "2026-11-24");
  assert.equal(d.stages[2].doneAt, null);
  assert.equal(setDone(d.stages, 1, "2026-11-25").stages[0].doneAt, "2026-11-24");   // keeps when it was done
  const a = addStage(st, "New stage", "2026-11-24", key);
  assert.equal(a[3].start, "2026-12-01");
  assert.equal(a[3].due, "2026-12-03");
  const m = moveStage(st, 2, 0, 1);
  assert.deepEqual(m.stages.map((s) => s.name), ["Launch", "Kickoff", "Build"]);
  assert.equal(m.stages[0].start, "2026-11-16");
  assert.equal(m.stages[1].start, "2026-11-17");
  assert.equal(m.current, 1);
  assert.equal(removeStage(st, 0, 2).current, 1);
  assert.equal(stageLine(st, 1), "Stage 2 of 3: Build");
  assert.equal(stageLine(st, 3), "All stages done");
  assert.equal(stageLine([], 0), "No stages yet");
});

// ---------- templates ----------
ok("templates: save copies stages, checklist and tasks with {client}; a new project is a copy from today", () => {
  const st = layStages([{ name: "Build", days: 12 }, { name: "Launch", days: 2 }], "2026-11-16", key);
  const tpl = templateOf({ name: "Shopify redesign", client: "Halden & Rye", stages: st, checklist: [{ text: "Set up 301 redirects" }], at: "2026-11-24T10:00:00Z", today: "2026-11-24",
    tasks: [
      { title: "Check the Halden & Rye build preview", ...repeatPatch([1, 2, 3, 4, 5], "2026-11-16") },
      { title: "Send the preview link", type: "once", repeat: null, doOn: "2026-11-26", deadline: { date: "2026-11-27" }, p1: true },
    ] });
  assert.deepEqual(tpl.stages, [{ name: "Build", days: 12 }, { name: "Launch", days: 2 }]);
  assert.equal(tpl.tasks[0].title, "Check the {client} build preview");
  assert.deepEqual(tpl.tasks[0].days, [1, 2, 3, 4, 5]);
  assert.deepEqual([tpl.tasks[1].doDay, tpl.tasks[1].deadlineDay, tpl.tasks[1].p1], [10, 11, true]);
  assert.deepEqual(cleanTpl(JSON.parse(JSON.stringify(tpl))), tpl);
  const made = fromTemplate(tpl, "Kettle Moon Teas", "2026-12-01", key);
  assert.equal(made.stages[0].start, "2026-12-01");
  assert.equal(made.stages[1].due, "2026-12-14");
  assert.equal(made.checklist[0].text, "Set up 301 redirects");
  assert.equal(made.checklist[0].done, false);
  assert.equal(made.tasks[0].title, "Check the Kettle Moon Teas build preview");
  assert.equal(made.tasks[0].type, "daily");
  assert.equal(made.tasks[1].doOn, "2026-12-11");
  assert.equal(made.tasks[1].deadline!.date, "2026-12-12");
  // The template itself is never changed by making a project from it.
  assert.equal(tpl.tasks[0].title, "Check the {client} build preview");
  assert.equal(cleanTpl({ name: "" }), null);
});
ok("client colours and tab order", () => {
  assert.equal(colourOf({ colour: "#112233" }, 0), "#112233");
  assert.match(colourOf({}, 9), /^#[0-9A-F]{6}$/);
  assert.deepEqual(reorder(["a", "b", "c"], 0, 2), ["b", "c", "a"]);
});

console.log(`\n${n} passed`);
