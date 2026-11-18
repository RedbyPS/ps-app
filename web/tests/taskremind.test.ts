// Run: node --experimental-strip-types tests/taskremind.test.ts
// Reminders ON tasks (V1.55, src/core/remind.ts): repeat choices, the task's name on the pop-up, Done and a tick in the
// list, snooze, a finished or deleted task taking its reminder away, the counts, and the words on the bell. The quiet
// rules (meetings, Do Not Disturb, AFK, Sleep mode, Sentry mode) live in the shells: ps-mac RemMath and Reminders.swift
// (tests/reminders-test.sh) and ps-gos RemClock (RemClockTest). FICTIONAL tasks and days only.
import assert from "node:assert/strict";
const R = await import("../src/core/remind.ts");
type Rem = import("../src/core/remind.ts").Reminder;

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const TB = "Asia/Dubai";
const tb = (day: string, hm: string) => Date.parse(`${day}T${hm}:00+04:00`);
const TASK = "0b7e6c1a-1111-4c2d-9e3f-aaaaaaaaaaaa";
const tr = (p: Partial<Rem> = {}): Rem => ({ ...R.newTaskReminder("t1", TASK, tb("2026-11-12", "10:20"), TB), tz: TB, ...p });
const recOf = (...list: Rem[]) => ({ v: 1 as const, list, state: {}, gone: {}, at: 1 });
const tasks = (m: Record<string, Partial<import("../src/core/remind.ts").TaskInfo>>) =>
  new Map(Object.entries(m).map(([k, v]) => [k, { title: "Water the plants", done: false, daily: false, ...v }]));

// ---------- a new one ----------
ok("a new reminder on a task: once today from the next whole hour for 3 hours, Done in one click, no words of its own", () => {
  const r = tr();
  assert.equal(r.task, TASK);
  assert.equal(r.date, "2026-11-12");
  assert.equal(r.at, "11:00");
  assert.equal(r.until, "14:00");
  assert.equal(r.yes, "Done");
  assert.equal(r.click, true);
  assert.equal(r.text, "");
  assert.equal(R.pillOf(r), "Task reminder");
});
ok("late in the evening it starts tomorrow at 09:00", () => {
  const r = R.newTaskReminder("t2", TASK, tb("2026-11-12", "21:30"), TB);
  assert.equal(r.date, "2026-11-13");
  assert.equal(r.at, "09:00");
});
ok("the task and its day survive cleaning; a day without a task does not; a broken task id is dropped", () => {
  assert.deepEqual([R.cleanReminder(tr())?.task, R.cleanReminder(tr())?.date], [TASK, "2026-11-12"]);
  assert.equal(R.cleanReminder({ ...R.newReminder("p1", 1), date: "2026-11-12" })?.date, undefined);
  assert.equal(R.cleanReminder({ ...tr(), task: "<script>" })?.task, undefined);
});

// ---------- repeat ----------
ok("once: only on its day, never the week after", () => {
  const r = tr({ at: "09:00", until: "12:00" });   // Thursday 12 Nov
  assert.equal(R.remStatus(r, undefined, tb("2026-11-12", "10:00"), TB), "show");
  assert.equal(R.remStatus(r, undefined, tb("2026-11-19", "10:00"), TB), "closed");
  assert.equal(R.nextStart(r, tb("2026-11-12", "08:00"), TB), tb("2026-11-12", "09:00"));
  assert.equal(R.nextStart(r, tb("2026-11-12", "10:00"), TB), 0);
  assert.equal(R.repeatOf(r), "once");
});
ok("once past midnight: still that day's window after midnight", () => {
  const r = tr({ at: "23:00", until: "01:00" });
  assert.equal(R.remStatus(r, undefined, tb("2026-11-13", "00:30"), TB), "show");
  assert.equal(R.remStatus(r, undefined, tb("2026-11-13", "23:30"), TB), "closed");
});
ok("every day, weekdays and chosen days", () => {
  const today = "2026-11-12";
  const daily = { ...tr({ at: "09:00", until: "12:00" }), ...R.repeatPatch(tr(), "daily", today) };
  assert.equal(daily.date, undefined);
  assert.equal(R.repeatOf(daily), "daily");
  assert.equal(R.remStatus(R.cleanReminder(daily)!, undefined, tb("2026-11-14", "10:00"), TB), "show");   // Saturday
  const wk = R.cleanReminder({ ...daily, ...R.repeatPatch(daily, "weekdays", today) })!;
  assert.equal(R.repeatOf(wk), "weekdays");
  assert.equal(R.remStatus(wk, undefined, tb("2026-11-14", "10:00"), TB), "closed");
  assert.equal(R.remStatus(wk, undefined, tb("2026-11-16", "10:00"), TB), "show");    // Monday
  const chosen = R.cleanReminder({ ...tr(), ...R.repeatPatch(tr(), "days", today) })!;
  assert.equal(R.repeatOf(chosen), "days");
  assert.deepEqual(chosen.days, [4]);   // the day it was on: Thursday
  const back = R.repeatPatch(chosen, "once", today);
  assert.equal(back.date, today);
});
ok("the words for the list: once on a day, or the days", () => {
  assert.equal(R.windowWords(tr({ at: "09:00", until: "12:00" })), "09:00 to 12:00, once on Thu 12 Nov");
  assert.equal(R.windowWords({ ...tr({ at: "09:00", until: "12:00" }), date: undefined, days: [1, 2, 3, 4, 5] }), "09:00 to 12:00, weekdays");
});

// ---------- the pop-up ----------
ok("the pop-up says the task's name (cut at 80), its own words when set, and has Open task", () => {
  const long = "x".repeat(120);
  const ctx = { tasks: tasks({ [TASK]: { title: long } }), now: tb("2026-11-12", "11:30"), deviceTz: TB };
  const p = R.remPlan(recOf(tr()), true, ctx).items[0];
  assert.equal(p.text.length, 80);
  assert.ok(p.text.endsWith("..."));
  assert.equal(p.task, TASK);
  assert.equal(p.date, "2026-11-12");
  assert.equal(p.open, "Open task");
  assert.equal(p.pill, "Task reminder");
  assert.equal(R.remPlan(recOf(tr({ text: "CALL MUM" })), true, ctx).items[0].text, "CALL MUM");
  const plain = R.remPlan(recOf(R.newReminder("p1", 1)), true, ctx).items[0];
  assert.deepEqual([plain.task, plain.date, plain.open], ["", "", ""]);
});
ok("a task ticked in the list: done for the window it is in now, a repeating one comes back next time", () => {
  const r = R.cleanReminder({ ...tr({ at: "09:00", until: "12:00" }), ...R.repeatPatch(tr(), "daily", "2026-11-12") })!;
  const now = tb("2026-11-12", "10:00");
  const ctx = { tasks: tasks({ [TASK]: { done: true, daily: true, doneAt: new Date(now - 60_000).toISOString() } }), now, deviceTz: TB };
  const p = R.remPlan(recOf(r), true, ctx).items[0];
  assert.equal(p.done, "2026-11-12");
  assert.ok(p.stateAt >= now - 60_000);
  assert.equal(R.remStatus(r, { done: p.done, at: p.stateAt }, now, TB), "done");
  assert.equal(R.remStatus(r, { done: p.done, at: p.stateAt }, tb("2026-11-13", "10:00"), TB), "show");
});
ok("a task that is gone: its reminder stays quiet", () => {
  const p = R.remPlan(recOf(tr()), true, { tasks: tasks({}), now: tb("2026-11-12", "11:30"), deviceTz: TB }).items[0];
  assert.equal(p.on, false);
});

// ---------- answers ----------
ok("Done: today's window is done (the shell's answer), and snooze puts it away for its length", () => {
  const r = tr({ at: "09:00", until: "12:00" });
  const now = tb("2026-11-12", "10:00");
  const rec = recOf(r);
  const d = R.applyAct(rec, R.doneAct(r, now, TB, "mac"))!;
  assert.equal(R.remStatus(r, d.state.t1, now + 1000, TB), "done");
  const s = R.applyAct(rec, R.snoozeAct(r, now, "phone"))!;
  assert.equal(R.remStatus(r, s.state.t1, now + 14 * 60_000, TB), "snoozed");
  assert.equal(R.remStatus(r, s.state.t1, now + 15 * 60_000, TB), "show");
  assert.equal(R.applyAct(d, R.doneAct(r, now - 5, TB)), null);   // an older answer changes nothing (no second tick)
});

// ---------- finished and deleted tasks ----------
ok("a deleted task takes its reminder away after the wait (Undo inside the wait keeps it)", () => {
  const rec = recOf(tr());
  const t0 = tb("2026-11-12", "11:30");
  let x = R.staleTaskReminders(rec, tasks({}), {}, t0, TB);
  assert.deepEqual(x.remove, []);
  x = R.staleTaskReminders(rec, tasks({}), x.since, t0 + R.TASK_GRACE_MS - 1, TB);
  assert.deepEqual(x.remove, []);
  const undo = R.staleTaskReminders(rec, tasks({ [TASK]: {} }), x.since, t0 + 60_000, TB);
  assert.deepEqual([undo.remove, undo.since], [[], {}]);
  x = R.staleTaskReminders(rec, tasks({}), x.since, t0 + R.TASK_GRACE_MS, TB);
  assert.deepEqual(x.remove, ["t1"]);
  const gone = R.removeReminders(rec, x.remove, t0 + R.TASK_GRACE_MS);
  assert.equal(gone.list.length, 0);
  assert.ok(gone.gone.t1);
});
ok("a finished one-off task takes its reminder away; a ticked Every day task keeps it", () => {
  const rec = recOf(tr());
  const t0 = tb("2026-11-12", "11:30");
  const a = R.staleTaskReminders(rec, tasks({ [TASK]: { done: true } }), {}, t0, TB);
  assert.deepEqual(R.staleTaskReminders(rec, tasks({ [TASK]: { done: true } }), a.since, t0 + R.TASK_GRACE_MS, TB).remove, ["t1"]);
  const daily = R.staleTaskReminders(rec, tasks({ [TASK]: { done: true, daily: true } }), {}, t0 + R.TASK_GRACE_MS * 3, TB);
  assert.deepEqual(daily.remove, []);
});
ok("a once reminder goes a day after its window; a repeating one never does on its own", () => {
  const r = tr({ at: "09:00", until: "12:00" });
  const t = tasks({ [TASK]: {} });
  assert.deepEqual(R.staleTaskReminders(recOf(r), t, {}, tb("2026-11-13", "11:59"), TB).remove, []);
  assert.deepEqual(R.staleTaskReminders(recOf(r), t, {}, tb("2026-11-13", "12:00"), TB).remove, ["t1"]);
  const rep = R.cleanReminder({ ...r, ...R.repeatPatch(r, "daily", "2026-11-12") })!;
  assert.deepEqual(R.staleTaskReminders(recOf(rep), t, {}, tb("2026-12-30", "12:00"), TB).remove, []);
});
ok("a task cleared by a reset counts as finished", () => {
  const m = R.taskInfos([{ id: TASK, data: { title: "A", done: false, type: "once", clearedAt: "2026-11-12T00:00:00Z" } }]);
  assert.equal(m.get(TASK)?.done, true);
});

// ---------- the record ----------
ok("one reminder per task; at most 60 on tasks, and they never take the list's 20", () => {
  let rec = R.emptyRemind();
  rec = R.addTaskReminder(rec, tr(), 2);
  assert.equal(R.addTaskReminder(rec, { ...tr(), id: "t9" }, 3).list.length, 1);   // that task has one already
  for (let i = 0; i < 70; i++) rec = R.addTaskReminder(rec, { ...tr(), id: `x${i}`, task: `task-${i}` }, 4 + i);
  assert.equal(R.onTasksOf(rec).length, R.REM_TASK_MAX);
  for (let i = 0; i < 25; i++) rec = R.addReminder(rec, `p${i}`, 100 + i);
  assert.equal(R.plainOf(rec).length, R.REM_MAX);
  const clean = R.cleanRemind(rec);
  assert.equal(clean.list.length, R.REM_ALL_MAX);
  assert.ok(!clean.list[0].task, "the list's own come first");
});
ok("moving a reminder in Settings only passes its own kind", () => {
  let rec = R.addTaskReminder(R.addReminder(R.emptyRemind(), "p1", 1), tr(), 2);
  rec = R.addReminder(rec, "p2", 3);
  assert.deepEqual(rec.list.map((r) => r.id), ["p1", "p2", "t1"]);
  assert.deepEqual(R.moveReminder(rec, "p2", 1, 4).list.map((r) => r.id), ["p1", "p2", "t1"]);
  assert.deepEqual(R.moveReminder(rec, "p2", -1, 4).list.map((r) => r.id), ["p2", "p1", "t1"]);
});
ok("two devices: a reminder on a task added on each is kept, and the counts hold", () => {
  const a = R.addTaskReminder(R.emptyRemind(), tr(), 5);
  const b = R.addTaskReminder(R.emptyRemind(), { ...tr(), id: "t2", task: "other-task" }, 6);
  const m = R.mergeRemind(a, b);
  assert.deepEqual(m.list.map((r) => r.id).sort(), ["t1", "t2"]);
  assert.equal(m.list.find((r) => r.id === "t1")?.task, TASK);
});
ok("editing the repeat keeps the task, and a new start time forgets today's answer", () => {
  let rec = R.applyAct(recOf(tr({ at: "09:00", until: "12:00" })), R.doneAct(tr(), tb("2026-11-12", "10:00"), TB))!;
  rec = R.patchReminder(rec, "t1", R.repeatPatch(rec.list[0], "weekdays", "2026-11-12"), 10);
  assert.equal(rec.list[0].task, TASK);
  assert.equal(rec.list[0].date, undefined);
  assert.ok(rec.state.t1);
  rec = R.patchReminder(rec, "t1", { at: "13:00" }, 11);
  assert.equal(rec.state.t1, undefined);
});

// ---------- the bell ----------
ok("the bell's words", () => {
  const r = tr({ at: "09:00", until: "12:00" });
  assert.equal(R.nextWords(r, undefined, tb("2026-11-12", "08:00"), TB), "Next: Today, 09:00");
  assert.equal(R.nextWords(r, undefined, tb("2026-11-12", "10:00"), TB), "Reminding you now");
  assert.equal(R.nextWords(r, { snoozeUntil: tb("2026-11-12", "10:15"), at: 1 }, tb("2026-11-12", "10:00"), TB), "Snoozed until 10:15");
  assert.equal(R.nextWords(r, undefined, tb("2026-11-12", "13:00"), TB), "No more times");
  const daily = R.cleanReminder({ ...r, ...R.repeatPatch(r, "daily", "2026-11-12") })!;
  assert.equal(R.nextWords(daily, { done: "2026-11-12", at: 1 }, tb("2026-11-12", "10:00"), TB), "Done for now. Next: Tomorrow, 09:00");
  assert.equal(R.nextWords({ ...daily, on: false }, undefined, 0, TB), "Reminder off");
  assert.equal(R.nextWords(daily, undefined, tb("2026-11-12", "13:00"), TB), "Next: Tomorrow, 09:00");
  assert.equal(R.nextWords({ ...daily, days: [1] }, undefined, tb("2026-11-12", "13:00"), TB), "Next: Mon 16 Nov, 09:00");
});

// ---------- PS 1.68: a reminder set up in the Add a task window, before the task had an id ----------
ok("the Add a task window's reminder joins the record with the new task's id and a fresh id of its own", () => {
  const draft = R.newTaskReminder("aaaa1111", "new-task", tb("2026-11-18", "10:20"), TB);
  let rec = R.emptyRemind();
  rec = R.addTaskReminder(rec, { ...tr(), id: "aaaa1111", task: "other-task" }, 1);   // that id is taken by now
  const next = R.addDraftTaskReminder(rec, { ...draft, text: "Call the bank", days: [1, 2, 3, 4, 5] }, "task-new-1", 2);
  assert.equal(next.list.length, 2);
  const got = next.list.find((x) => x.task === "task-new-1")!;
  assert.ok(got && got.id !== "aaaa1111", "a fresh id");
  assert.equal(got.text, "Call the bank");
  assert.deepEqual(got.days, [1, 2, 3, 4, 5]);
  assert.equal(R.reminderOfTask(next, "task-new-1")?.id, got.id);
});
ok("the Add window's reminder: junk, no task id, or a task that has one already change nothing", () => {
  const rec = R.addTaskReminder(R.emptyRemind(), tr(), 1);
  assert.equal(R.addDraftTaskReminder(rec, null, "task-new-1", 2), rec);
  assert.equal(R.addDraftTaskReminder(rec, { id: "bad id!" }, "task-new-1", 2), rec);
  assert.equal(R.addDraftTaskReminder(rec, R.newTaskReminder("bbbb2222", "new-task", 0, TB), "", 2), rec);
  assert.equal(R.addDraftTaskReminder(rec, R.newTaskReminder("bbbb2222", "new-task", 0, TB), TASK, 2).list.length, 1, "one per task");
});
console.log(`\n${n} passed`);
