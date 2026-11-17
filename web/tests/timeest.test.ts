// Time estimates, real time spent and the overload warning (core/timeest.ts, PS 1.65): the setting, the estimate words, time spent
// with AFK breaks and Pomodoro, two devices merging, similar names, free time with overlapping meetings and working hours past
// midnight, and the warning once per day.
import assert from "node:assert/strict";
import { tickedElsewhere,
  TE_DEFAULT, TE_WORDS, addDone, addPomo, allDone, carryBack, cleanEst, cleanLive, cleanTe, cleanTMonth, emptyLive, estLabel, estShort,
  finishClock, foldTime, freeMin, hoursWords, isRunning, lastDoneOf, likeness, mergeLive, mergeTMonth, monthOf, nameKey, overlapMs,
  overloadLine, parseEst, pastTimes, pastWords, plannedMin, pomoPiece, pruneLive, runningIds, similar, spanTotal, spentMin, startClock,
  stopClock, teRecId, dropGone, todayTasks, undoDone, unionSpans, usualMin, workWindow, type Span, type TLive,
} from "../src/core/timeest.ts";
import type { Doc, Todo } from "../src/core/model.ts";
import * as R from "../src/core/rewind.ts";
import { settingById, visibleTo } from "../src/core/settingsindex.ts";
import { TOUR_STEPS } from "../src/core/tour.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const MIN = 60_000;
const T0 = Date.parse("2026-11-17T09:00:00Z");
const at = (m: number) => T0 + m * MIN;
const NY = "America/New_York", DXB = "Asia/Dubai";

ok("the setting: all three on by default, 09:00 to 17:00, odd values fall back", () => {
  assert.deepEqual(cleanTe(undefined), TE_DEFAULT);
  assert.deepEqual(cleanTe({ est: false, track: false, warn: false, from: "22:00", to: "06:00" }), { est: false, track: false, warn: false, from: "22:00", to: "06:00" });
  assert.deepEqual(cleanTe({ est: "no", from: "25:00", to: 9 }), TE_DEFAULT);
});

ok("estimates: choices, typed words, labels", () => {
  assert.equal(parseEst("45"), 45);
  assert.equal(parseEst("45m"), 45);
  assert.equal(parseEst(" 45 min "), 45);
  assert.equal(parseEst("90 minutes"), 90);
  assert.equal(parseEst("1h"), 60);
  assert.equal(parseEst("1.5h"), 90);
  assert.equal(parseEst("1,5 h"), 90);
  assert.equal(parseEst("1h 30"), 90);
  assert.equal(parseEst("1h30m"), 90);
  assert.equal(parseEst("2 hours"), 120);
  assert.equal(parseEst("1:30"), 90);
  for (const bad of ["", "abc", "0", "-5", "25h", "1:75", "h", null, 12]) assert.equal(parseEst(bad as never), null, String(bad));
  assert.equal(cleanEst(0), null);
  assert.equal(cleanEst(9999), 1440);
  assert.equal(cleanEst(29.6), 30);
  assert.equal(estLabel(15), "15 min");
  assert.equal(estLabel(60), "1 h");
  assert.equal(estLabel(90), "1 h 30 min");
  assert.equal(estShort(90), "1h30");
  assert.equal(estShort(30), "30m");
  assert.equal(hoursWords(540), "9 h");
  assert.equal(hoursWords(275), "4.5 h");
  assert.equal(hoursWords(42), "40 min");
  assert.equal(TE_WORDS.overload(540, 300), "You've planned 9 h with 5 h free");
  assert.equal(TE_WORDS.usually(40), "Usually takes about 40 min");
});

ok("spans: union, total and overlap", () => {
  assert.deepEqual(unionSpans([[10, 20], [15, 30], [40, 50], [30, 35]]), [[10, 35], [40, 50]]);
  assert.equal(spanTotal([[0, 10], [5, 15]]), 15);
  assert.equal(overlapMs([[0, 100]], [[10, 20], [15, 30], [90, 120]]), 30);
  assert.deepEqual(unionSpans([[10, 0]], 25), [[10, 25]]);
});

ok("time spent: start to tick, minus an AFK break inside it", () => {
  let l = startClock(emptyLive(), "a", "Write report", at(0))!;
  assert.ok(isRunning(l, "a"));
  assert.equal(startClock(l, "a", "Write report", at(1)), null, "a second start changes nothing");
  const away: Span[] = [[at(20), at(30)]];
  assert.equal(spentMin(l, "a", at(60), away), 50);
  const f = finishClock(l, "a", at(60), away);
  assert.equal(f.minutes, 50);
  assert.ok(!f.live.run.a && f.live.end.a === at(60));
  l = f.live;
  // An AFK break that started before the clock only takes off its own overlap.
  l = startClock(l, "b", "Email", at(100))!;
  assert.equal(spentMin(l, "b", at(130), [[at(90), at(110)]]), 20);
});

ok("time spent: stop and start again adds the pieces, a task never started records nothing", () => {
  let l = startClock(emptyLive(), "a", "Deck", at(0))!;
  l = stopClock(l, "a", at(25))!;
  assert.equal(stopClock(l, "a", at(26)), null);
  l = startClock(l, "a", "Deck", at(60))!;
  assert.equal(finishClock(l, "a", at(75), []).minutes, 40);
  assert.equal(finishClock(emptyLive(), "zz", at(10), []).minutes, null);
});

ok("time spent: Pomodoro work on the task adds, Pomodoro breaks come off, other tasks' Pomodoros do not count", () => {
  const run = (phase: string, startM: number, lenM: number) => ({ id: `${phase[0]}${Math.round(at(startM)).toString(36)}`, phase, endsAt: at(startM + lenM), left: null, wait: false });
  // A 25 minute work phase while "a" was being worked on, but the clock was never started (an older device set Working on).
  const w = pomoPiece(run("work", 0, 25), null, at(25), ["a"])!;
  assert.deepEqual(w[1], [at(0), at(25), 0, ["a"]]);
  let l = addPomo(emptyLive(), w, at(25));
  assert.equal(finishClock(l, "a", at(30), []).minutes, 25);
  assert.equal(finishClock(l, "b", at(30), []).minutes, null);
  // A clock running through work, a 5 minute break and more work: the break comes off, work inside the clock is not counted twice.
  l = startClock(emptyLive(), "a", "Code", at(0))!;
  l = addPomo(l, pomoPiece(run("work", 0, 25), { id: "s1", left: null }, at(25), ["a"])!, at(25));
  l = addPomo(l, pomoPiece(run("short", 25, 5), { id: "w2", left: null }, at(30), [])!, at(30));
  assert.equal(finishClock(l, "a", at(45), []).minutes, 40);
  // Still the same phase and running: no piece. A paused phase: no piece. Stopped early: ends at the stop.
  assert.equal(pomoPiece(run("work", 0, 25), { id: run("work", 0, 25).id, left: null }, at(10), ["a"]), null);
  assert.equal(pomoPiece({ ...run("work", 0, 25), left: 5 * MIN }, null, at(10), ["a"]), null);
  assert.equal(pomoPiece(run("work", 0, 25), null, at(10), ["a"])![1][1], at(10));
});

ok("time spent: an untick carries the minutes to the next tick; an undone finish is not learned from", () => {
  let l = startClock(emptyLive(), "a", "Gym", at(0))!;
  const f = finishClock(l, "a", at(40), []);
  l = carryBack(f.live, "a", f.minutes!, at(41));
  assert.equal(finishClock(l, "a", at(42), []).minutes, 40);
  let m = addDone(null, "2026-11", "a", { n: "Gym", m: 40, e: 0, at: at(40) });
  const last = lastDoneOf([m], "a", at(41))!;
  assert.equal(last.d.m, 40);
  m = undoDone(m, last.key, at(41));
  assert.deepEqual(pastTimes(allDone([m]), "Gym"), []);
  assert.equal(lastDoneOf([m], "a", at(41)), null);
  assert.equal(lastDoneOf([addDone(null, "2026-11", "a", { n: "Gym", m: 40, e: 0, at: at(40) })], "a", at(40 + 13 * 60)), null, "older than 12 hours");
});

ok("two devices: live records merge the same either way, a stop seen anywhere wins, a finish drops stale spans", () => {
  const base = startClock(emptyLive(), "a", "Plan", at(0))!;
  const macStopped = stopClock(base, "a", at(30))!;              // the Mac stopped it
  const phoneOld = startClock(base, "b", "Call", at(5))!;        // the phone still had it running and started another
  const ab = mergeLive(macStopped, phoneOld), ba = mergeLive(phoneOld, macStopped);
  assert.deepEqual(ab, ba);
  assert.ok(!isRunning(ab, "a") && isRunning(ab, "b"));
  assert.deepEqual(mergeLive(ab, ab), ab, "merging with itself changes nothing");
  // The Mac ticks "b"; the phone's older copy still has its running span: the finish wins, the span does not come back.
  const macDone = finishClock(ab, "b", at(50), []).live;
  const back = mergeLive(phoneOld, macDone);
  assert.ok(!back.run.b);
  assert.deepEqual(runningIds(back), []);
  // A new round started after the finish is kept.
  const again = startClock(macDone, "b", "Call", at(60))!;
  assert.ok(isRunning(mergeLive(phoneOld, again), "b"));
  // Pomodoro pieces noted by both devices are one.
  const p: [string, [number, number, 0 | 1, string[]]] = ["wabc", [at(0), at(25), 0, ["a"]]];
  assert.deepEqual(Object.keys(mergeLive(addPomo(emptyLive(), p, at(25)), addPomo(emptyLive(), p, at(26))).pomo), ["wabc"]);
});

ok("two devices: month records keep every finish, an untick on either wins, order does not matter", () => {
  const a = addDone(null, "2026-11", "t1", { n: "Report", m: 35, e: 30, at: at(0) });
  const b = addDone(null, "2026-11", "t2", { n: "Report", m: 50, e: 0, at: at(100) });
  const ab = mergeTMonth(a, b), ba = mergeTMonth(b, a);
  assert.deepEqual(ab.r, ba.r);
  assert.equal(Object.keys(ab.r).length, 2);
  const undone = undoDone(a, Object.keys(a.r)[0], at(5));
  assert.equal(mergeTMonth(b, mergeTMonth(undone, a)).r[Object.keys(a.r)[0]].x, 1);
  // foldTime: several copies of one month, plus the live record.
  const f = foldTime([{ id: "1", data: a }, { id: "2", data: b }, { id: "3", data: startClock(emptyLive(), "x", "X", at(0)) }, { id: "4", data: { junk: true } }]);
  assert.equal(f.months.get("2026-11")!.ids.length, 2);
  assert.ok(isRunning(f.live, "x") && f.liveIds[0] === "3");
  assert.equal(cleanTMonth({ t: "month", mo: "2026-13", r: {} }), null);
  assert.equal(teRecId("u1", "live"), teRecId("u1", "live"));
  assert.notEqual(teRecId("u1", "live"), teRecId("u2", "live"));
  assert.match(teRecId("u1", "2026-11"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(monthOf(Date.parse("2026-11-30T23:30:00Z"), DXB), "2026-12");
});

ok("cleaning: damaged records never throw, old things are pruned", () => {
  assert.deepEqual(cleanLive(null), emptyLive());
  const odd = cleanLive({ t: "live", run: { a: { n: 5, sp: [[0, 1], ["x", 2], [at(0), 0]] } }, end: { b: "x" }, pomo: { p: [1] } });
  assert.deepEqual(odd.run.a.sp, [[at(0), 0]]);
  assert.deepEqual(odd.end, {});
  let l: TLive = startClock(emptyLive(), "a", "A", at(0))!;
  l = stopClock(l, "a", at(10))!;
  l = addPomo(l, ["wq", [at(0), at(25), 0, []]], at(25));
  const later = pruneLive(l, at(20 * 24 * 60));
  assert.ok(!later.run.a && !later.pomo.wq);
});

ok("a deleted task's clock is let go after 6 hours, a task not synced yet keeps its clock", () => {
  const l = startClock(startClock(emptyLive(), "gone", "Old", at(0))!, "here", "Here", at(0))!;
  assert.deepEqual(Object.keys(dropGone(l, (id) => id === "here", at(60)).run).sort(), ["gone", "here"]);
  assert.deepEqual(Object.keys(dropGone(l, (id) => id === "here", at(7 * 60)).run), ["here"]);
});

ok("similar names: the same words match, a different task does not", () => {
  assert.equal(nameKey("Send the invoices to Client"), "send invoice client");
  assert.ok(similar("Send invoice to client", "send invoices to client"));
  assert.ok(similar("Write weekly report", "Write the weekly report"));
  assert.ok(similar("Weekly report write", "write weekly report"));
  assert.ok(similar("Prepare slides for Monday", "Prepare slide for monday!"));
  assert.ok(similar("Café meeting notes", "Cafe meeting notes"));
  assert.ok(similar("Review pull request", "Review pull requests"));
  assert.ok(!similar("Call mom", "Call Tom"));
  assert.ok(!similar("Gym", "Gyms day"));
  assert.ok(!similar("Write report", "Read report"));
  assert.ok(!similar("Buy milk", "Buy a car"));
  assert.ok(!similar("", "anything"));
  assert.ok(likeness("abc", "abc") === 1);
});

ok("a clock still running on a task ticked on another device is caught: finished at the tick, or just stopped", () => {
  const t0 = Date.parse("2026-11-17T09:00:00Z");
  let l = startClock(emptyLive(), "a", "Write the report", t0)!;
  l = startClock(l, "b", "Call back", t0 + 3_600_000)!;
  l = startClock(l, "c", "Plan the week", t0)!;
  const ticked: Record<string, number> = { a: t0 + 40 * 60_000, b: t0 + 30 * 60_000 };
  const got = tickedElsewhere(l, (id) => ticked[id] ?? null);
  assert.deepEqual(got, [{ id: "a", at: t0 + 40 * 60_000, how: "finish" }, { id: "b", at: t0 + 30 * 60_000, how: "stop" }]);
  const f = finishClock(l, "a", got[0].at, []);
  assert.equal(f.minutes, 40, "the round ends at the tick, not when this device noticed it days later");
  assert.deepEqual(tickedElsewhere(f.live, (id) => ticked[id] ?? null).map((x) => x.id), ["b"], "once finished it is not caught again");
  assert.deepEqual(tickedElsewhere(stopClock(l, "a", t0 + 5)!, (id) => ticked[id] ?? null).map((x) => x.id), ["b"], "a stopped clock is left alone");
  assert.deepEqual(tickedElsewhere(l, () => Number.NaN), [], "a bad tick time is ignored");
});
ok("two devices recording the same tick (same task, same tick time) keep one finish", () => {
  const at = Date.parse("2026-11-17T09:40:00Z");
  const a = addDone(null, "2026-11", "a", { n: "Write the report", m: 40, e: 0, at });
  const b = addDone(null, "2026-11", "a", { n: "Write the report", m: 40, e: 0, at });
  assert.equal(allDone([mergeTMonth(a, b)]).length, 1);
});
ok("learning stays quick on a full history (every new task asks, on the main thread)", () => {
  const done = Array.from({ length: 14_400 }, (_, i) => ({ id: `t${i}`, n: `Task number ${i % 300} for client`, m: 10 + (i % 50), e: 0, at: 1_700_000_000_000 + i * 60_000 }));
  const t0 = performance.now();
  for (let i = 0; i < 5; i++) pastTimes(done, `Task numbr ${i} for clint`);
  const ms = (performance.now() - t0) / 5;
  assert.ok(ms < 30, `pastTimes took ${ms.toFixed(0)} ms`);
  assert.equal(pastTimes(done, "Task number 5 for client").length, 6, "the same name still wins, newest six");
});
ok("learning: past times newest first, the usual time, words", () => {
  const months = [
    addDone(addDone(null, "2026-10", "t1", { n: "Weekly report", m: 35, e: 30, at: Date.parse("2026-10-01T10:00:00Z") }), "2026-10", "t2", { n: "Weekly reports", m: 50, e: 0, at: Date.parse("2026-10-08T10:00:00Z") }),
    addDone(null, "2026-11", "t3", { n: "weekly report", m: 40, e: 0, at: Date.parse("2026-11-01T10:00:00Z") }),
    addDone(null, "2026-11", "t4", { n: "Call the bank", m: 10, e: 0, at: Date.parse("2026-11-02T10:00:00Z") }),
  ];
  const done = allDone(months);
  assert.deepEqual(pastTimes(done, "Weekly report"), [40, 50, 35]);
  assert.equal(usualMin([40, 50, 35]), 40);
  assert.equal(pastWords([35, 50, 40]), "35, 50, 40 min");
  assert.equal(pastWords([70, 50]), "1 h 10 min, 50 min");
  assert.deepEqual(pastTimes(done, "Weekly reprt"), [40, 50, 35], "a typo still finds it");
  assert.deepEqual(pastTimes(done, "Call mom"), []);
  assert.equal(usualMin([]), null);
  assert.equal(usualMin([3]), 5);
  assert.equal(usualMin([80, 100]), 90);
  assert.equal(usualMin([62]), 60);
  assert.equal(usualMin([80]), 80, "one past time of 1 h 20 min says 1 h 20 min");
  assert.equal(usualMin([200]), 200);
  assert.equal(usualMin([303]), 300);
  assert.deepEqual(pastTimes(done, "Weekly report", { n: 2 }), [40, 50]);
});

ok("free time: working hours minus meetings, overlapping meetings once, all day events never", () => {
  const win = workWindow(Date.parse("2026-11-17T13:00:00Z"), { from: "09:00", to: "17:00" }, NY);   // 08:00 in New York
  assert.equal(win.day, "2026-11-17");
  assert.equal(win.s, Date.parse("2026-11-17T14:00:00Z"));
  assert.equal(win.e, Date.parse("2026-11-17T22:00:00Z"));
  const h = (hh: number, mm = 0) => Date.parse(`2026-11-17T${String(hh + 5).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);   // New York wall time
  const busy = [
    { start: h(10), end: h(11) }, { start: h(10, 30), end: h(11, 30) },   // overlap: 1 h 30 together
    { start: h(8), end: h(9, 30) },                                        // starts before the hours: 30 min counts
    { start: h(16, 30), end: h(18) },                                      // runs past the end: 30 min counts
    { start: h(0), end: h(23, 59), allDay: true },
  ];
  assert.equal(freeMin(win, h(8), busy), 8 * 60 - 90 - 30 - 30);
  assert.equal(freeMin(win, h(12), busy), 5 * 60 - 30);   // from noon: only what is left
  assert.equal(freeMin(win, h(17, 30), busy), 0);
});

ok("free time: working hours past midnight", () => {
  const p = { from: "22:00", to: "06:00" };
  const tbl = (iso: string) => Date.parse(iso + "+04:00");   // Dubai wall time
  const night = workWindow(tbl("2026-11-18T02:00:00"), p, DXB);
  assert.equal(night.day, "2026-11-17");
  assert.equal(night.s, tbl("2026-11-17T22:00:00"));
  assert.equal(night.e, tbl("2026-11-18T06:00:00"));
  assert.equal(freeMin(night, tbl("2026-11-18T02:00:00"), [{ start: tbl("2026-11-18T03:00:00"), end: tbl("2026-11-18T04:00:00") }]), 180);
  const evening = workWindow(tbl("2026-11-17T20:00:00"), p, DXB);
  assert.equal(evening.s, tbl("2026-11-17T22:00:00"));
  assert.equal(freeMin(evening, tbl("2026-11-17T20:00:00"), []), 480);
  const morning = workWindow(tbl("2026-11-18T07:00:00"), p, DXB);   // after last night's hours: tonight's
  assert.equal(morning.day, "2026-11-18");
  const all = workWindow(tbl("2026-11-17T12:00:00"), { from: "08:00", to: "08:00" }, DXB);
  assert.equal(all.e - all.s, 24 * 60 * MIN);
});

ok("the overload line: only with more planned than free, once per day, never after the hours", () => {
  const win = { s: at(0), e: at(480), day: "2026-11-17" };
  assert.equal(overloadLine({ on: true, planned: 540, free: 300, now: at(10), win })?.text, "You've planned 9 h with 5 h free");
  assert.equal(overloadLine({ on: true, planned: 310, free: 300, now: at(10), win }), null, "under 15 minutes over is fine");
  assert.equal(overloadLine({ on: false, planned: 540, free: 300, now: at(10), win }), null);
  assert.equal(overloadLine({ on: true, planned: 540, free: 300, now: at(10), win, seenDay: "2026-11-17" }), null, "never twice the same day");
  assert.ok(overloadLine({ on: true, planned: 540, free: 300, now: at(10), win, seenDay: "2026-11-16" }), "a new day can have it again");
  assert.equal(overloadLine({ on: true, planned: 540, free: 0, now: at(481), win }), null);
  const list = [
    { id: "a", est: 120 }, { id: "b", est: 60, done: true }, { id: "c", est: null }, { id: "d", est: 30 },
  ];
  assert.equal(plannedMin(list), 150);
  assert.equal(plannedMin(list, (id) => (id === "a" ? 50 : 0)), 100, "time already spent comes off");
  const docs = [
    { id: "1", kind: "todo", data: { title: "Now", due: "2026-11-17" } },
    { id: "2", kind: "todo", data: { title: "Later", due: "2026-11-20" } },
    { id: "3", kind: "todo", data: { title: "Any" } },
  ] as unknown as Doc<Todo>[];
  assert.deepEqual(todayTasks(docs, "2026-11-17").map((d) => d.id), ["1", "3"]);
});

ok("the recap: Rewind keeps each finished task's minutes under the tick's own key, two devices merge", () => {
  const now = Date.parse("2026-11-17T20:00:00Z");
  const base = { todos: [], daylogs: [], workouts: [], screentime: [], calendars: [], meetings: [], awayLog: [], gymAck: [], gym: null, money: {} };
  const t = Date.parse("2026-11-17T10:00:00Z");
  const { days } = R.derive({ ...base, timed: [{ id: "a", n: "Weekly report", m: 40, e: 30, at: t }, { id: "p", n: "Open 1Password vault", m: 5, e: 0, at: t }] }, { tz: DXB, now, since: 0 });
  const tm = days.get("2026-11-17")!.tm!;
  assert.deepEqual(Object.values(tm), [["Weekly report", 40, 30]], "never anything about 1Password");
  assert.equal(Object.keys(tm)[0], R.hkey(`a|${new Date(t).toISOString()}`));
  const d = days.get("2026-11-17")!;
  const other = { ...d, tm: { [Object.keys(tm)[0]]: ["Weekly report", 42, 30] as [string, number, number] } };
  assert.deepEqual(R.mergeDay(d, other).tm, R.mergeDay(other, d).tm);
  assert.equal(Object.values(R.mergeDay(d, other).tm!)[0][1], 42);
});

ok("Settings rows and the tour step show only where the feature is on", () => {
  for (const id of ["te-est", "te-track", "te-warn", "te-hours"]) {
    const e = settingById(id)!;
    assert.ok(e && e.group === "list", id);
    assert.ok(visibleTo(e, { red: false, where: "mac", te: true }) && visibleTo(e, { red: false, where: "phone", te: true }) && visibleTo(e, { red: false, where: "web", te: true }));
    assert.ok(!visibleTo(e, { red: false, where: "mac" }));
  }
  assert.ok(TOUR_STEPS.some((s) => s.ids.includes("time-estimates") && !s.on));
});

console.log(`${n} passed`);
