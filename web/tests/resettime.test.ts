// Run: node --experimental-strip-types tests/resettime.test.ts
// The automatic Reset's time (core/resetday.ts, core/resetplan.ts, the developer 8 Nov 2026: "if you want to change it to 4am you
// can"): midnight by default exactly as before, 4am when chosen, a sleeping device catches up once, a time zone change
// or a new time never resets twice for one day, and the day a tick belongs to follows the time (Completed, history,
// G Squad counts).
import assert from "node:assert/strict";
import { autoResetDue, dayStartAt, lastResetDayOf, nextResetAt, okResetAt, resetAtOf, resetAtWords, resetDayOf, resetMinOf } from "../src/core/resetday.ts";
import { planReset } from "../src/core/resetplan.ts";
import { keepSince, completedList, nextRollAt } from "../src/core/completed.ts";
import { tasksCard } from "../src/core/squadboard.ts";
import type { Doc, Todo } from "../src/core/model.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const TB = "Asia/Dubai", LON = "Europe/London";
const at = (iso: string) => Date.parse(iso);
const task = (id: string, data: Partial<Todo>): Doc<Todo> =>
  ({ id, ws: null, kind: "todo", author: null, updatedAt: null, data: { title: id, type: "once", done: false, order: 0, ...data } }) as Doc<Todo>;
const ON = { autoReset: "midnight" } as const;
/** Run the automatic Reset like maybeAutoReset does every minute between from and to; returns the times it ran. */
function simulate(s: { autoReset: string; autoResetAt?: string; lastResetAt?: string | null; lastResetDay?: string }, from: number, to: number, tz: string, step = 60_000) {
  const ran: string[] = [];
  for (let t = from; t <= to; t += step) {
    if (!autoResetDue(s, t, tz)) continue;
    const iso = new Date(t).toISOString();
    s.lastResetAt = iso; s.lastResetDay = resetDayOf(t, tz, resetMinOf(s));
    ran.push(iso);
  }
  return ran;
}

ok("the setting: HH:MM only, missing or odd is midnight", () => {
  assert.equal(resetAtOf(undefined), "00:00");
  assert.equal(resetAtOf({ autoResetAt: "4:00" }), "00:00");
  assert.equal(resetAtOf({ autoResetAt: "24:00" }), "00:00");
  assert.equal(resetAtOf({ autoResetAt: "04:00" }), "04:00");
  assert.equal(resetMinOf({ autoResetAt: "04:30" }), 270);
  assert.equal(okResetAt("23:59"), true);
  assert.equal(okResetAt(400), false);
  assert.deepEqual(["00:00", "04:00", "04:30", "12:00", "16:00"].map(resetAtWords), ["midnight", "4am", "4:30am", "noon", "4pm"]);
});

ok("midnight default: the day is the calendar date in your zone, as before", () => {
  assert.equal(resetDayOf(at("2026-11-07T20:00:00Z"), TB), "2026-11-08");   // 00:00 Dubai
  assert.equal(resetDayOf(at("2026-11-07T19:59:00Z"), TB), "2026-11-07");
  assert.equal(dayStartAt("2026-11-08", TB), at("2026-11-07T20:00:00Z"));
  assert.equal(nextResetAt(at("2026-11-08T10:00:00Z"), TB), at("2026-11-08T20:00:00Z"));
});

ok("midnight default: runs once at midnight, never again that day", () => {
  const s = { ...ON, lastResetAt: "2026-11-07T08:00:00Z" };   // reset on the 7th at noon Dubai
  const ran = simulate(s, at("2026-11-07T09:00:00Z"), at("2026-11-08T19:00:00Z"), TB);
  assert.deepEqual(ran, ["2026-11-07T20:00:00.000Z"]);
});

ok("midnight default: same result as the old rule (date of the last reset is not today)", () => {
  // The old rule ran whenever the last reset's local date was not today's. For every hour across two days, with a
  // reset on the 7th at 15:00 Dubai, both say the same thing.
  const last = "2026-11-07T11:00:00Z";
  for (let t = at("2026-11-07T12:00:00Z"); t < at("2026-11-09T12:00:00Z"); t += 3600_000) {
    const old = resetDayOf(at(last), TB) !== resetDayOf(t, TB);
    assert.equal(autoResetDue({ ...ON, lastResetAt: last }, t, TB), old, new Date(t).toISOString());
  }
});

ok("off: never runs", () => {
  assert.equal(autoResetDue({ autoReset: "off", autoResetAt: "04:00" }, at("2026-11-08T10:00:00Z"), TB), false);
  assert.equal(autoResetDue(null, at("2026-11-08T10:00:00Z"), TB), false);
});

ok("never reset before: runs at once when switched on", () => {
  assert.equal(autoResetDue({ ...ON, autoResetAt: "04:00" }, at("2026-11-08T10:00:00Z"), TB), true);
});

ok("4am: not at midnight, at 4am in your zone", () => {
  const s = { ...ON, autoResetAt: "04:00", lastResetAt: "2026-11-07T08:00:00Z" };
  assert.equal(autoResetDue(s, at("2026-11-07T20:30:00Z"), TB), false, "00:30 Dubai: still the 7th");
  assert.equal(autoResetDue(s, at("2026-11-07T23:59:00Z"), TB), false, "03:59 Dubai");
  assert.equal(autoResetDue(s, at("2026-11-08T00:00:00Z"), TB), true, "04:00 Dubai");
  const ran = simulate({ ...s }, at("2026-11-07T09:00:00Z"), at("2026-11-08T23:30:00Z"), TB);
  assert.deepEqual(ran, ["2026-11-08T00:00:00.000Z"], "once, at 4am on the 8th");
});

ok("4am: two days in a row, one reset each, both at 4am", () => {
  const s = { ...ON, autoResetAt: "04:00", lastResetAt: "2026-11-07T08:00:00Z" };
  const ran = simulate(s, at("2026-11-07T09:00:00Z"), at("2026-11-09T12:00:00Z"), TB);
  assert.deepEqual(ran, ["2026-11-08T00:00:00.000Z", "2026-11-09T00:00:00.000Z"]);
  assert.equal(s.lastResetDay, "2026-11-09");
});

ok("4am: a 2am tick belongs to the day before", () => {
  assert.equal(resetDayOf(at("2026-11-07T22:00:00Z"), TB, 240), "2026-11-07");   // 02:00 on the 8th, Dubai
  assert.equal(resetDayOf(at("2026-11-08T00:00:00Z"), TB, 240), "2026-11-08");   // 04:00
  assert.equal(dayStartAt("2026-11-08", TB, 240), at("2026-11-08T00:00:00Z"));
  assert.equal(nextResetAt(at("2026-11-07T22:00:00Z"), TB, 240), at("2026-11-08T00:00:00Z"));
});

ok("catching up: asleep at 4am, resets once on waking, not again until the next 4am", () => {
  const s = { ...ON, autoResetAt: "04:00", lastResetAt: "2026-11-07T00:00:00Z", lastResetDay: "2026-11-07" };
  // The Mac sleeps from 01:00 to 09:30 Dubai on the 8th: no checks in between.
  assert.deepEqual(simulate(s, at("2026-11-07T21:00:00Z"), at("2026-11-07T21:00:00Z"), TB), [], "01:00: not yet");
  assert.deepEqual(simulate(s, at("2026-11-08T05:30:00Z"), at("2026-11-08T23:59:00Z"), TB), ["2026-11-08T05:30:00.000Z"]);
  assert.equal(s.lastResetDay, "2026-11-08");
});

ok("catching up: off for three days, one reset, not three", () => {
  const s = { ...ON, autoResetAt: "04:00", lastResetAt: "2026-11-04T00:00:00Z", lastResetDay: "2026-11-04" };
  assert.deepEqual(simulate(s, at("2026-11-08T06:00:00Z"), at("2026-11-08T12:00:00Z"), TB), ["2026-11-08T06:00:00.000Z"]);
});

ok("catching up keeps today's ticks and files the older ones into their own days", () => {
  // 4am reset, the Mac woke at 09:00 Dubai on the 8th after two days off. Ticks: one at 02:00 on the 7th (the 6th's
  // day), one at 15:00 on the 7th, one at 06:00 on the 8th (today's day, done on the phone after 4am).
  const list = [
    task("a", { done: true, doneAt: "2026-11-06T22:00:00Z" }),
    task("b", { done: true, doneAt: "2026-11-07T11:00:00Z" }),
    task("c", { done: true, doneAt: "2026-11-08T02:00:00Z" }),
    task("d", { type: "daily", done: true, doneAt: "2026-11-08T03:00:00Z", streak: 4, streakTicked: true }),
    task("e", { type: "daily", done: true, doneAt: "2026-11-07T12:00:00Z", streak: 3, streakTicked: true }),
    task("f", {}),
  ];
  const p = planReset(list, { at: "2026-11-08T05:00:00.000Z", tz: TB, atMin: 240, auto: true });
  assert.equal(p.today, "2026-11-08");
  assert.deepEqual([...p.logs.keys()].sort(), ["2026-11-06", "2026-11-07"]);
  assert.deepEqual(p.logs.get("2026-11-06")!.map((i) => i.todoId), ["a"]);
  assert.deepEqual(p.logs.get("2026-11-07")!.map((i) => i.todoId).sort(), ["b", "e"]);
  const put = new Map(p.puts.map((x) => [x.id, x.data]));
  assert.ok(put.get("a")!.clearedAt && put.get("b")!.clearedAt, "older one-offs cleared");
  assert.equal(put.has("c"), false, "ticked today: stays in Completed");
  assert.equal(put.has("d"), false, "every day task ticked today: stays ticked, streak kept");
  assert.equal(put.get("e")!.done, false, "yesterday's every day tick is unticked");
  assert.equal(put.get("e")!.streak, 3, "and keeps its streak");
  assert.equal(put.has("f"), false);
});

ok("a Reset you press still saves every tick to one work day (Your work day ends at)", () => {
  const list = [task("a", { done: true, doneAt: "2026-11-06T22:00:00Z" }), task("c", { done: true, doneAt: "2026-11-08T02:00:00Z" })];
  const p = planReset(list, { at: "2026-11-08T06:00:00.000Z", tz: TB, atMin: 240, dayEndsHour: 15 });   // 10:00 Dubai
  assert.deepEqual([...p.logs.keys()], ["2026-11-07"]);
  assert.equal(p.logs.get("2026-11-07")!.length, 2);
  assert.equal(p.puts.length, 2, "both cleared, the tick after 4am too");
});

ok("mini tasks ticked today stay ticked on an automatic catch up", () => {
  const list = [task("r", { type: "daily", done: false, subtasks: [
    { id: "s1", title: "old", done: true, doneAt: "2026-11-07T12:00:00Z" },
    { id: "s2", title: "new", done: true, doneAt: "2026-11-08T02:00:00Z" },
  ] } as Partial<Todo>)];
  const p = planReset(list, { at: "2026-11-08T05:00:00.000Z", tz: TB, atMin: 240, auto: true });
  const subs = p.puts.find((x) => x.id === "r")!.data.subtasks!;
  assert.deepEqual(subs.map((x) => [x.id, x.done]), [["s1", false], ["s2", true]]);
  assert.deepEqual(p.logs.get("2026-11-07")!.map((i) => i.todoId), ["r/s1"]);
});

ok("repeating tasks: a weekly task due today is not missed before the reset time", () => {
  // Due the 8th, catch up at 01:00 on the 9th with a 4am reset: today is still the 8th, so it has until 4am.
  const list = [task("w", { type: "daily", repeat: { every: 1, unit: "week", from: "2026-11-01" }, due: "2026-11-08", streak: 2 })];
  const p = planReset(list, { at: "2026-11-08T21:00:00.000Z", tz: TB, atMin: 240, auto: true });
  assert.equal(p.today, "2026-11-08");
  assert.equal(p.puts.length, 0, "streak kept");
  const q = planReset(list, { at: "2026-11-09T00:00:00.000Z", tz: TB, atMin: 240, auto: true });
  assert.equal(q.puts[0].data.streak, 0, "after 4am on the 9th it was missed");
});

ok("time zone change west: never resets twice for one day", () => {
  // Reset at 04:00 Dubai on the 8th, then the person sets Your time zone to London (4 hours behind).
  const s = { ...ON, autoResetAt: "04:00", lastResetAt: "2026-11-08T00:00:00Z", lastResetDay: "2026-11-08" };
  // 04:00 London on the 8th is 04:00Z: the 8th was already reset in the developer's city.
  assert.equal(autoResetDue(s, at("2026-11-08T04:00:00Z"), LON), false);
  const ran = simulate(s, at("2026-11-08T01:00:00Z"), at("2026-11-09T12:00:00Z"), LON);
  assert.deepEqual(ran, ["2026-11-09T04:00:00.000Z"], "next at 4am London on the 9th");
});

ok("time zone change east: the next 4am in the new zone, once", () => {
  const s = { ...ON, autoResetAt: "04:00", lastResetAt: "2026-11-08T04:00:00Z", lastResetDay: "2026-11-08" };   // 4am London
  const ran = simulate(s, at("2026-11-08T10:00:00Z"), at("2026-11-09T12:00:00Z"), TB);
  assert.deepEqual(ran, ["2026-11-09T00:00:00.000Z"], "4am Dubai on the 9th");
});

ok("a build from before (lastResetAt only) still counts: no extra reset", () => {
  const s = { ...ON, autoResetAt: "04:00", lastResetAt: "2026-11-08T01:00:00Z" };   // 05:00 Dubai on the 8th
  assert.equal(lastResetDayOf(s, TB), "2026-11-08");
  assert.equal(autoResetDue(s, at("2026-11-08T12:00:00Z"), TB), false);
  // An older build reset later than the day this build wrote: the later one wins.
  assert.equal(lastResetDayOf({ ...s, lastResetDay: "2026-11-06" }, TB), "2026-11-08");
});

ok("changing the time never resets twice for one day", () => {
  // Reset at 04:00 on the 8th; at 04:30 the time moves to 05:00: nothing more on the 8th.
  const s = { ...ON, autoResetAt: "05:00", lastResetAt: "2026-11-08T00:00:00Z", lastResetDay: "2026-11-08" };
  assert.deepEqual(simulate(s, at("2026-11-08T00:30:00Z"), at("2026-11-08T23:00:00Z"), TB), []);
  // Midnight to 4am at 01:00: the 8th was reset at midnight, so no 4am reset on the 8th either.
  const m = { ...ON, autoResetAt: "04:00", lastResetAt: "2026-11-07T20:00:00Z", lastResetDay: "2026-11-08" };
  assert.deepEqual(simulate(m, at("2026-11-07T21:00:00Z"), at("2026-11-08T19:00:00Z"), TB), []);
  // 4am to midnight at 02:00 on the 8th (last reset 4am on the 7th): midnight has passed, so it runs now, once.
  const e = { ...ON, autoResetAt: "00:00", lastResetAt: "2026-11-07T00:00:00Z", lastResetDay: "2026-11-07" };
  assert.deepEqual(simulate(e, at("2026-11-07T22:00:00Z"), at("2026-11-08T19:00:00Z"), TB), ["2026-11-07T22:00:00.000Z"]);
});

ok("Completed today starts at the reset time; midnight default unchanged", () => {
  const NOW = at("2026-11-07T22:00:00Z");   // 02:00 on the 8th, Dubai
  assert.equal(keepSince("today", NOW, TB), at("2026-11-07T20:00:00Z"), "midnight");
  assert.equal(keepSince("today", NOW, TB, 240), at("2026-11-07T00:00:00Z"), "4am: since 4am on the 7th");
  assert.equal(keepSince("7d", NOW, TB, 240), at("2026-11-01T00:00:00Z"));
  assert.equal(nextRollAt(NOW, TB, 240), at("2026-11-08T00:00:00Z"));
  const all = [task("late", { done: true, doneAt: "2026-11-07T21:00:00Z" }), task("eve", { done: true, doneAt: "2026-11-07T15:00:00Z" })];
  assert.deepEqual(completedList(all, "today", NOW, TB).map((d) => d.id), ["late"], "midnight: the 7th's evening is gone");
  assert.deepEqual(completedList(all, "today", NOW, TB, 240).map((d) => d.id), ["late", "eve"], "4am: still the same day");
});

ok("G Squad tasks per day and month follow the reset time", () => {
  const NOW = at("2026-11-08T10:00:00Z");
  const todos = [task("a", { done: true, doneAt: "2026-11-07T22:00:00Z", sqOn: true }), task("b", { done: true, doneAt: "2026-10-31T22:30:00Z", sqOn: true })];
  // 02:00 on the 8th and 02:30 on 1 Nov, Dubai.
  assert.deepEqual(tasksCard(todos, NOW, TB).d, { "2026-11-08": 1 }, "midnight: the 8th");
  assert.deepEqual(tasksCard(todos, NOW, TB, 240).d, { "2026-11-07": 1 }, "4am: the 7th");
  assert.deepEqual(tasksCard(todos, NOW, TB, 240).m, { "2026-10": 1, "2026-11": 1 });
  assert.deepEqual(tasksCard(todos, NOW, TB).m, { "2026-11": 2 });
});

// PS 1.68 streaks on mini tasks: the Reset ends each one's round with its parent's.
ok("a Reset keeps the streak of done mini tasks of a repeating task and ends the missed ones", () => {
  const subs = [{ id: "s1", title: "Water", done: true, doneAt: "2026-11-07T05:00:00Z", streak: 6, streakTicked: true, bestStreak: 6 },
    { id: "s2", title: "Stretch", done: false, streak: 3, bestStreak: 5 }];
  const morning = task("m", { type: "daily", done: false, streak: 2, subtasks: subs });
  const weekly = task("w", { type: "daily", done: false, repeat: { every: 1, unit: "week", from: "2026-11-02" }, due: "2026-11-09",
    subtasks: [{ id: "x", title: "Step", done: true, doneAt: "2026-11-07T05:00:00Z", streak: 1, streakTicked: true }] });
  const p = planReset([morning, weekly], { at: "2026-11-08T00:30:00.000Z", tz: TB, atMin: 240, auto: true });
  const put = new Map(p.puts.map((x) => [x.id, x.data]));
  const m = put.get("m")!;
  assert.equal(m.streak, 0, "the every day task itself was missed");
  assert.deepEqual(m.subtasks!.map((x) => [x.done, x.streak ?? 0, !!x.streakTicked]), [[false, 6, false], [false, 0, false]]);
  assert.equal(m.subtasks![1].bestStreak, 5);
  assert.equal(put.has("w"), false, "a weekly task not due yet keeps its mini tasks as they are");
});
console.log(`resettime: ${n} passed`);
