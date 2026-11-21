// Run: node --experimental-strip-types tests/duealerts.test.ts
// PS 1.73 (src/core/duealerts.ts, src/core/remind.ts): the nag for tasks due today and the Priority 1 alarm. The trigger times,
// the day end boundary (the developer's 12:00 Dubai, never midnight), the 3 hour start with the 15 minute repeat, I acknowledge and Done
// syncing between devices, your own P1 clock, and the Clients hook. FICTIONAL tasks and days only.
import assert from "node:assert/strict";
const R = await import("../src/core/remind.ts");
const D = await import("../src/core/duealerts.ts");
const C = await import("../src/core/daycount.ts");

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const TB = "Asia/Dubai", NY = "America/New_York";
const tb = (day: string, hm: string) => Date.parse(`${day}T${hm}:00+04:00`);
const H = 3_600_000, M = 60_000;
// The developer's day: ends 12:00 Dubai every day.
const noon = C.cleanCd({ mode: "daily", at: "12:00" });
const ctxAt = (now: number, p = noon, tz = TB) => ({ now, tz, dayEndAfter: (t: number) => C.nextEnd(p, tz, t), dayEndAtOrBefore: (t: number) => C.prevEnd(p, tz, t) });
const todo = (id: string, d: Record<string, unknown>) => ({ id, data: { title: `Task ${id}`, type: "once", done: false, ...d } });
const rec0 = (): import("../src/core/remind.ts").RemindRec => R.emptyRemind();
const st = (i: { done: string; snoozeUntil: number; stateAt: number }) => (i.done || i.snoozeUntil ? { done: i.done || undefined, snoozeUntil: i.snoozeUntil || undefined, at: i.stateAt } : undefined);
const asRem = (i: import("../src/core/remind.ts").PlanItem) => i as unknown as import("../src/core/remind.ts").Reminder;

// ---------- which tasks are due, and when ----------
ok("a task dated 21 Nov is due at the developer's day end, 12:00 Dubai on 21 Nov (not midnight)", () => {
  const t = D.dueTasks([todo("a", { due: "2026-11-21" })], ctxAt(tb("2026-11-21", "07:00")));
  assert.equal(t.length, 1);
  assert.equal(t[0].kind, "dated");
  assert.equal(t[0].dueAt, tb("2026-11-21", "12:00"));
});
ok("the day end boundary: with a midnight day end the same date is due at the midnight after it", () => {
  const mid = C.cleanCd({ mode: "daily", at: "00:00" });
  const t = D.dueTasks([todo("a", { due: "2026-11-21" })], ctxAt(tb("2026-11-21", "07:00"), mid));
  assert.equal(t[0].dueAt, tb("2026-11-22", "00:00"));
});
ok("the day end follows a time for each day (Saturday ends at 18:00)", () => {
  const week = C.cleanCd({ mode: "week", days: ["12:00", "12:00", "12:00", "12:00", "12:00", "18:00", "12:00"] });   // Monday first
  const t = D.dueTasks([todo("a", { due: "2026-11-21" })], ctxAt(tb("2026-11-21", "07:00"), week));   // 21 Nov 2026 is a Saturday
  assert.equal(t[0].dueAt, tb("2026-11-21", "18:00"));
});
ok("done, cleared, example and AI Inbox tasks and tasks with no date are never due", () => {
  const t = D.dueTasks([
    todo("a", { due: "2026-11-21", done: true }), todo("b", { due: "2026-11-21", clearedAt: "2026-11-20T00:00:00Z" }),
    todo("c", { due: "2026-11-21", example: true }), todo("d", { due: "2026-11-21", aiInbox: true }), todo("e", {}),
  ], ctxAt(tb("2026-11-21", "07:00")));
  assert.deepEqual(t, []);
});
ok("a Priority 1 task is due when its 24 hours run out, from the squad clock or its own", () => {
  const now = tb("2026-11-21", "13:00");   // after the 12:00 day end, so the next one (22 Nov 12:00) is later than both clocks
  const t = D.dueTasks([
    todo("s", { p1: true, p1At: new Date(tb("2026-11-20", "15:00")).toISOString() }),
    todo("o", { p1: true, p1Since: new Date(tb("2026-11-20", "20:30")).toISOString() }),
    todo("x", { p1: true }),   // no clock yet (the stamp gives it one): the day end
    todo("r", { p1: true, type: "daily", p1Since: new Date(tb("2026-11-20", "20:30")).toISOString() }),   // repeating: no clock
  ], ctxAt(now));
  assert.deepEqual(t.map((x) => [x.id, x.kind, x.dueAt]), [["s", "p1", tb("2026-11-21", "15:00")], ["o", "p1", tb("2026-11-21", "20:30")], ["x", "p1", tb("2026-11-22", "12:00")]]);
});
ok("The developer's refinement: every P1 not done is due by the day end too, whatever its 24 hours say", () => {
  const now = tb("2026-11-21", "07:00");
  const t = D.dueTasks([
    todo("s", { p1: true, p1At: new Date(tb("2026-11-20", "15:00")).toISOString() }),   // clock 15:00, day end 12:00: 12:00
    todo("e", { p1: true, p1Since: new Date(tb("2026-11-21", "06:00")).toISOString() }),   // clock tomorrow 06:00: 12:00 today
    todo("m", { p1: true, p1Since: new Date(tb("2026-11-20", "05:00")).toISOString() }),   // its 24 hours ran out at 05:00 (Missed): 12:00
  ], ctxAt(now));
  assert.deepEqual(t.map((x) => [x.id, x.dueAt]), [["e", tb("2026-11-21", "12:00")], ["m", tb("2026-11-21", "12:00")], ["s", tb("2026-11-21", "12:00")]]);
});
ok("a P1 with a date today is due at the sooner of the two", () => {
  const t = D.dueTasks([todo("s", { p1: true, due: "2026-11-21", p1At: new Date(tb("2026-11-20", "15:00")).toISOString() })], ctxAt(tb("2026-11-21", "07:00")));
  assert.equal(t[0].dueAt, tb("2026-11-21", "12:00"));
});
ok("repeating tasks (client ones too) never come from the list itself: client tasks come only through the Clients hook", () => {
  const ctx = ctxAt(tb("2026-11-21", "07:00"));   // Saturday
  const t = D.dueTasks([
    todo("c1", { clientId: "cl1", due: "2026-11-21" }),   // a client task with an ordinary due date still counts as dated
    todo("c2", { clientId: "cl1", type: "daily", repeat: { every: 1, unit: "week", from: "2026-11-01", days: [6] } }),
    todo("g", { type: "daily" }),
  ], ctx, [{ id: "c2", title: "Lit by Clients", kind: "client", dueAt: tb("2026-11-22", "12:00") }]);
  // the hook's moment (the developer's day is named after the date it starts on) is the one kept, never an earlier calendar guess
  assert.deepEqual(t.map((x) => [x.id, x.kind, x.dueAt]), [["c1", "client", tb("2026-11-21", "12:00")], ["c2", "client", tb("2026-11-22", "12:00")]]);
});
ok("the Clients hook: tasks from another source join, a task already listed keeps the sooner moment", () => {
  const ctx = ctxAt(tb("2026-11-21", "07:00"));
  const t = D.dueTasks([todo("a", { due: "2026-11-21" })], ctx, [
    { id: "a", title: "dup", kind: "client", dueAt: tb("2026-11-21", "10:00") }, { id: "z", title: "From Clients", kind: "client", dueAt: tb("2026-11-21", "12:00") },
  ]);
  assert.deepEqual(t.map((x) => [x.id, x.dueAt]), [["a", tb("2026-11-21", "10:00")], ["z", tb("2026-11-21", "12:00")]]);
});

// ---------- the nag: 3 hours before, every 15 minutes ----------
const nagRec = () => D.patchDue(rec0(), false, { nag: { on: true, snooze: 15 } }, 1);
ok("the nag starts 3 hours before the day ends (09:00 for a 12:00 end) and stops at the end", () => {
  const now = tb("2026-11-21", "07:00");
  const tasks = D.dueTasks([todo("a", { due: "2026-11-21" })], ctxAt(now));
  const [i] = D.dueNagItems(tasks, nagRec(), false, ctxAt(now));
  assert.equal(i.at, "09:00"); assert.equal(i.until, "12:00"); assert.equal(i.date, "2026-11-21"); assert.equal(i.tz, TB);
  assert.equal(i.task, "a"); assert.equal(i.text, "Task a"); assert.equal(i.pill, "Due today"); assert.equal(i.open, "Open task");
  const r = asRem(i);
  assert.equal(R.remStatus(r, undefined, tb("2026-11-21", "08:59"), NY), "closed");
  assert.equal(R.remStatus(r, undefined, tb("2026-11-21", "09:00"), NY), "show");
  assert.equal(R.remStatus(r, undefined, tb("2026-11-21", "11:59"), NY), "show");
  assert.equal(R.remStatus(r, undefined, tb("2026-11-21", "12:00"), NY), "closed");
  assert.equal(R.remStatus(r, undefined, tb("2026-11-22", "10:00"), NY), "closed");   // the next day: a once window, not daily
});
ok("the 15 minute repeat: rings at 09:00, 09:15 ... 11:45 (the phone and iPhone push times)", () => {
  const now = tb("2026-11-21", "08:00");
  const [i] = D.dueNagItems(D.dueTasks([todo("a", { due: "2026-11-21" })], ctxAt(now)), nagRec(), false, ctxAt(now));
  const times = R.remRingTimes({ ...asRem(i), date: i.date }, undefined, now, 36 * H, NY, 20);
  assert.equal(times.length, 12);
  assert.equal(times[0], tb("2026-11-21", "09:00"));
  assert.equal(times[1], tb("2026-11-21", "09:15"));
  assert.equal(times[11], tb("2026-11-21", "11:45"));
  // ignored at 09:00: rings again 15 minutes later (the phone's next ring)
  assert.equal(R.remNextRing(asRem(i), undefined, tb("2026-11-21", "09:05"), NY, tb("2026-11-21", "09:00")), tb("2026-11-21", "09:15"));
});
ok("the start is changeable (2 hours), and so is the repeat (its snooze)", () => {
  const now = tb("2026-11-21", "07:00");
  const rec = D.patchDue(D.patchDue(rec0(), false, { nag: { on: true, snooze: 10 } }, 1), false, { hours: 2 }, 2);
  const [i] = D.dueNagItems(D.dueTasks([todo("a", { due: "2026-11-21" })], ctxAt(now)), rec, false, ctxAt(now));
  assert.equal(i.at, "10:00"); assert.equal(i.snooze, 10); assert.equal(i.later, "Remind me in 10 mins");
});
ok("a P1 is nagged in the 3 hours before its own 24 hours run out", () => {
  const now = tb("2026-11-21", "13:00");
  const tasks = D.dueTasks([todo("p", { p1: true, p1Since: new Date(tb("2026-11-20", "20:30")).toISOString() })], ctxAt(now));
  const [i] = D.dueNagItems(tasks, nagRec(), false, ctxAt(now));
  assert.equal(i.at, "17:30"); assert.equal(i.until, "20:30");
});
ok("a window across midnight (a midnight day end) belongs to its start day", () => {
  const mid = C.cleanCd({ mode: "daily", at: "00:00" });
  const now = tb("2026-11-21", "20:00");
  const [i] = D.dueNagItems(D.dueTasks([todo("a", { due: "2026-11-21" })], ctxAt(now, mid)), nagRec(), false, ctxAt(now, mid));
  assert.equal(i.at, "21:00"); assert.equal(i.until, "00:00"); assert.equal(i.date, "2026-11-21");
  assert.equal(R.remStatus(asRem(i), undefined, tb("2026-11-21", "23:59"), NY), "show");
  assert.equal(R.remStatus(asRem(i), undefined, tb("2026-11-22", "00:00"), NY), "closed");
});
ok("off: no nags; a task with a reminder of its own gets no second one; a ticked task drops out", () => {
  const now = tb("2026-11-21", "09:30");
  const ctx = ctxAt(now);
  const tasks = D.dueTasks([todo("a", { due: "2026-11-21" }), todo("b", { due: "2026-11-21" })], ctx);
  assert.deepEqual(D.dueNagItems(tasks, D.patchDue(rec0(), false, { nag: { on: false } }, 1), false, ctx), []);
  assert.deepEqual(D.dueNagItems(tasks, nagRec(), false, ctx, { ownTaskReminders: new Set(["a"]) }).map((i) => i.task), ["b"]);
  const ticked = D.dueTasks([todo("a", { due: "2026-11-21", done: true })], ctx);
  assert.deepEqual(D.dueNagItems(ticked, nagRec(), false, ctx), []);
});
ok("defaults: on for the developer, off for everyone else; the nag copies the first reminder's typed word and colours", () => {
  assert.equal(D.dueCfgOf(null, true).nag.on, true);
  assert.equal(D.dueCfgOf(null, false).nag.on, false);
  assert.equal(D.dueCfgOf(null, false).p1.on, false);
  let rec = R.addReminder(rec0(), "abcdefgh", 1);
  rec = R.patchReminder(rec, "abcdefgh", { click: false, word: "DONE IT", bg: "#0f1b2d", accent: "#3b82f6", snooze: 15, sound: "own" }, 2);
  const nag = D.dueCfgOf(rec, true).nag;
  assert.equal(nag.click, false); assert.equal(nag.word, "DONE IT"); assert.equal(nag.bg, "#0f1b2d"); assert.equal(nag.sound, "soft");
  assert.equal(nag.yes, "Done");
  const p1 = D.dueCfgOf(null, true);
  assert.equal(p1.p1.yes, "I acknowledge"); assert.equal(p1.lead, 60); assert.equal(p1.hours, 3);
});
ok("overdue (the developer's answer): nagged straight away, every 15 minutes, all day, labelled Overdue", () => {
  const now = tb("2026-11-21", "13:10");   // a task dated 20 Nov was due at 12:00 on 20 Nov
  const ctx = ctxAt(now);
  const tasks = D.dueTasks([todo("old", { due: "2026-11-20", title: "Send the deck" })], ctx);
  const [i] = D.dueNagItems(tasks, nagRec(), false, ctx);
  assert.equal(i.pill, "Overdue"); assert.equal(i.text, "Send the deck"); assert.equal(i.task, "old");
  assert.equal(i.at, "12:00"); assert.equal(i.until, "11:59"); assert.equal(i.date, "2026-11-21");   // today's day: 12:00 to 11:59 tomorrow
  assert.equal(R.remStatus(asRem(i), undefined, now, NY), "show");                                   // at once, no 3 hour wait
  const times = R.remRingTimes({ ...asRem(i), date: i.date }, undefined, now, 2 * H, NY, 20);
  assert.equal(times[1] - times[0], 15 * M); assert.equal(times[2] - times[1], 15 * M);   // every 15 minutes (the engine's own steps)
  assert.equal(R.remNextRing(asRem(i), undefined, now + 5 * M, NY, now), now + 15 * M);    // ignored: back 15 minutes later
  // snoozed: away for 15 minutes, the usual rule
  const sn = R.applyAct(nagRec(), R.snoozeAct(asRem(i), now, "mac"))!;
  const [j] = D.dueNagItems(tasks, sn, false, ctx);
  assert.equal(R.remStatus(asRem(j), { snoozeUntil: j.snoozeUntil, at: j.stateAt }, now + 5 * M, NY), "snoozed");
  // done (ticked) or a new date: gone
  assert.deepEqual(D.dueNagItems(D.dueTasks([todo("old", { due: "2026-11-20", done: true })], ctx), nagRec(), false, ctx), []);
  const moved = D.dueNagItems(D.dueTasks([todo("old", { due: "2026-11-23" })], ctx), nagRec(), false, ctx);
  assert.deepEqual(moved, []);   // given a new date two days out: quiet until that day's 3 hours
  const tomorrow = D.dueNagItems(D.dueTasks([todo("old", { due: "2026-11-22" })], ctx), nagRec(), false, ctx);
  assert.equal(tomorrow[0].pill, "Due today"); assert.equal(R.remStatus(asRem(tomorrow[0]), undefined, now, NY), "closed");
  // the next day is a new window with its own id (a Done from yesterday never hides it)
  const [k] = D.dueNagItems(D.dueTasks([todo("old", { due: "2026-11-20" })], ctxAt(tb("2026-11-22", "12:05"))), nagRec(), false, ctxAt(tb("2026-11-22", "12:05")));
  assert.notEqual(k.id, i.id); assert.equal(k.date, "2026-11-22");
});
ok("at the day end a task due today becomes overdue with no gap in the nagging", () => {
  const tasks = (now: number) => D.dueTasks([todo("a", { due: "2026-11-21" })], ctxAt(now));
  const [before] = D.dueNagItems(tasks(tb("2026-11-21", "11:59")), nagRec(), false, ctxAt(tb("2026-11-21", "11:59")));
  const [after] = D.dueNagItems(tasks(tb("2026-11-21", "12:00")), nagRec(), false, ctxAt(tb("2026-11-21", "12:00")));
  assert.equal(before.pill, "Due today"); assert.equal(after.pill, "Overdue");
  assert.equal(R.remStatus(asRem(after), undefined, tb("2026-11-21", "12:00"), NY), "show");
});
ok("today's nags come before the overdue ones, the most recent overdue first", () => {
  const now = tb("2026-11-21", "10:00");
  const t = D.dueTasks([todo("o1", { due: "2026-11-10" }), todo("o2", { due: "2026-11-19" }), todo("t", { due: "2026-11-21" })], ctxAt(now));
  assert.deepEqual(D.dueNagItems(t, nagRec(), false, ctxAt(now)).map((i) => i.task), ["t", "o2", "o1"]);
});
ok("the nag's words: the task's name, or {task} and {left} filled in", () => {
  const now = tb("2026-11-21", "09:00");
  const rec = D.patchDue(rec0(), false, { nag: { on: true, text: "{task}: {left} to go" } }, 1);
  const [i] = D.dueNagItems(D.dueTasks([todo("a", { due: "2026-11-21", title: "Send the invoice" })], ctxAt(now)), rec, false, ctxAt(now));
  assert.equal(i.text, "Send the invoice: 3 hours to go");
});

// ---------- the Priority 1 alarm ----------
const p1Rec = () => D.patchDue(rec0(), false, { p1: { on: true } }, 1);
const p1Task = () => todo("p", { title: "Send the invoice", p1: true, p1Since: new Date(tb("2026-11-20", "20:30")).toISOString() });
ok("the P1 alarm rings 1 hour before the 24 hours run out, with the task's name and the time left", () => {
  const now = tb("2026-11-21", "13:00");
  const { items, rings } = D.dueP1Items(D.dueTasks([p1Task()], ctxAt(now)), p1Rec(), false, ctxAt(now));
  assert.equal(rings.length, 1);
  assert.equal(rings[0].at, tb("2026-11-21", "19:30"));
  assert.equal(rings[0].text, "1 hour left: Send the invoice");
  assert.equal(rings[0].yes, "I acknowledge"); assert.equal(rings[0].title, "Priority 1"); assert.equal(rings[0].one, true);
  assert.equal(rings[0].day, "2026-11-21");
  const i = items[0];
  // the Mac card may open until the 24 hours run out (it only opens while the developer is at the Mac); its sound rings 10 minutes at most
  assert.equal(i.at, "19:30"); assert.equal(i.until, "20:30"); assert.equal(i.one, true); assert.equal(i.ring, true);
  // The developer: a click alone must not stop it. I acknowledge opens the box; only "yes" typed (any case) clears it, the Annoying reminder's own rule
  assert.equal(i.click, false); assert.equal(i.word, "yes"); assert.equal(i.yes, "I acknowledge"); assert.equal(rings[0].word, "yes");
  assert.equal(R.confirms(asRem(i), ""), false); assert.equal(R.confirms(asRem(i), "I acknowledge"), false);
  assert.equal(R.confirms(asRem(i), "yes"), true); assert.equal(R.confirms(asRem(i), " YES "), true);
  assert.equal(i.task, "p"); assert.equal(i.open, "");          // the task only so older shells keep the one day; no Open task
  assert.equal(D.autoTask(items, i.id), null);                   // I acknowledge never ticks the task
  assert.equal(R.remStatus(asRem(i), undefined, tb("2026-11-22", "19:30"), NY), "closed");   // once, not every day
  assert.equal(R.remStatus(asRem(i), undefined, tb("2026-11-21", "19:29"), NY), "closed");
  assert.equal(R.remStatus(asRem(i), undefined, tb("2026-11-21", "19:30"), NY), "show");
});
ok("The developer's refinement: a P1 rings an hour before the day end when that comes before its 24 hours", () => {
  const now = tb("2026-11-21", "08:00");
  const t = todo("q", { title: "Call the bank", p1: true, p1Since: new Date(tb("2026-11-21", "08:00")).toISOString() });   // made P1 4 hours before the day end
  const { rings, items } = D.dueP1Items(D.dueTasks([t], ctxAt(now)), p1Rec(), false, ctxAt(now));
  assert.equal(rings.length, 1);
  assert.equal(rings[0].at, tb("2026-11-21", "11:00"));
  assert.equal(rings[0].text, "1 hour left: Call the bank");
  assert.equal(items[0].until, "12:00");
});
ok("a P1 made 30 minutes before the day end rings at once, not an hour back", () => {
  const made = tb("2026-11-21", "11:30");
  const t = todo("q", { title: "Call the bank", p1: true, p1Since: new Date(made).toISOString() });
  const { rings } = D.dueP1Items(D.dueTasks([t], ctxAt(made + 20_000)), p1Rec(), false, ctxAt(made + 20_000));
  assert.equal(rings[0].at, made);
  assert.equal(rings[0].text, "30 mins left: Call the bank");
});
ok("never twice for the same task and moment; the next day end is a new moment", () => {
  const t = todo("m", { title: "Call the bank", p1: true, p1Since: new Date(tb("2026-11-20", "05:00")).toISOString() });   // Missed at 05:00 on 21 Nov
  const a = D.dueP1Items(D.dueTasks([t], ctxAt(tb("2026-11-21", "11:00"))), p1Rec(), false, ctxAt(tb("2026-11-21", "11:00")));
  const a2 = D.dueP1Items(D.dueTasks([t], ctxAt(tb("2026-11-21", "11:05"))), p1Rec(), false, ctxAt(tb("2026-11-21", "11:05")));
  assert.equal(a.rings[0].id, a2.rings[0].id);   // the same moment: the same id, so a phone that rang it does not ring it again
  const acked = R.applyAct(p1Rec(), { id: a.rings[0].id, act: "done", day: a.rings[0].day, at: tb("2026-11-21", "11:01") })!;
  assert.deepEqual(D.dueP1Items(D.dueTasks([t], ctxAt(tb("2026-11-21", "11:05"))), acked, false, ctxAt(tb("2026-11-21", "11:05"))).rings, []);
  const b = D.dueP1Items(D.dueTasks([t], ctxAt(tb("2026-11-21", "13:00"))), acked, false, ctxAt(tb("2026-11-21", "13:00")));
  assert.equal(b.rings[0].at, tb("2026-11-22", "11:00"));   // still not done: tomorrow's day end rings, a new id
  assert.notEqual(b.rings[0].id, a.rings[0].id);
});
ok("the lead time and the words are changeable", () => {
  const now = tb("2026-11-21", "13:00");
  const rec = D.patchDue(D.patchDue(p1Rec(), false, { lead: 30 }, 2), false, { p1: { text: "{task} runs out in {left}!" } }, 3);
  const { rings } = D.dueP1Items(D.dueTasks([p1Task()], ctxAt(now)), rec, false, ctxAt(now));
  assert.equal(rings[0].at, tb("2026-11-21", "20:00"));
  assert.equal(rings[0].text, "Send the invoice runs out in 30 mins!");
});
ok("I acknowledge on the phone stops the Mac card and the ring on every device (synced through the record)", () => {
  const now = tb("2026-11-21", "19:31");
  const tasks = D.dueTasks([p1Task()], ctxAt(now));
  const { items, rings } = D.dueP1Items(tasks, p1Rec(), false, ctxAt(now));
  // the phone sends {type:"remAct", id, act:"done", day} from the ring (ps-gos Gym.kt)
  const next = R.applyAct(p1Rec(), { id: rings[0].id, act: "done", day: rings[0].day, at: now, by: "phone" });
  assert.ok(next);
  // the Mac's next plan carries it as done: no card
  const mac = D.dueP1Items(tasks, next, false, ctxAt(now));
  assert.equal(mac.items[0].done, "2026-11-21");
  assert.equal(R.remStatus(asRem(mac.items[0]), st(mac.items[0]), now, NY), "done");
  assert.deepEqual(mac.rings, []);   // the phone's plan leaves it out, so a phone still ringing stops
  // a second device that never saw the answer merges it in
  const other = R.mergeRemind(p1Rec(), next!);
  assert.equal(other.auto?.[items[0].id]?.done, "2026-11-21");
  // the record survives the vault's cleaning
  assert.equal(R.cleanRemind(JSON.parse(JSON.stringify(next))).auto?.[items[0].id]?.done, "2026-11-21");
});
ok("Done on a nag from the Mac syncs to the phone and the iPhone (same id on every device)", () => {
  const now = tb("2026-11-21", "09:20");
  const tasks = D.dueTasks([todo("a", { due: "2026-11-21" })], ctxAt(now));
  const [mac] = D.dueNagItems(tasks, nagRec(), false, ctxAt(now));
  const [phone] = D.dueNagItems(tasks, nagRec(), false, ctxAt(now + 30_000));
  assert.equal(mac.id, phone.id);
  assert.match(mac.id, R.AUTO_ID);
  const done = R.applyAct(nagRec(), R.doneAct(asRem(mac), now, NY, "mac"))!;
  assert.equal(D.autoTask([mac], mac.id), "a");   // Done on a nag ticks its task (src/remwatch.ts remAnswer)
  const [after] = D.dueNagItems(tasks, done, false, ctxAt(now + M));
  assert.equal(R.remStatus(asRem(after), st(after), now + M, NY), "done");
  // a snooze on the phone puts it away for 15 minutes on the Mac too
  const sn = R.applyAct(nagRec(), R.snoozeAct(asRem(phone), now, "phone"))!;
  const [snz] = D.dueNagItems(tasks, sn, false, ctxAt(now + M));
  assert.equal(R.remStatus(asRem(snz), st(snz), now + M, NY), "snoozed");
  assert.equal(R.remStatus(asRem(snz), st(snz), now + 15 * M, NY), "show");
});
ok("an answer to an unknown or made up id is refused; an older answer never wins", () => {
  assert.equal(R.applyAct(nagRec(), { id: "zzzzzzzz", act: "done", day: "2026-11-21", at: 5 }), null);
  const a = R.applyAct(nagRec(), { id: "nabcdefghijk", act: "done", day: "2026-11-21", at: 10 })!;
  assert.equal(R.applyAct(a, { id: "nabcdefghijk", act: "snooze", until: 99, at: 9 }), null);
});
ok("a new P1 clock (done and opened again) is a new alarm with its own answer", () => {
  const a = D.autoId("p", "p", tb("2026-11-21", "20:30")), b = D.autoId("p", "p", tb("2026-11-22", "09:00"));
  assert.notEqual(a, b);
  assert.equal(D.autoId("p", "p", tb("2026-11-21", "20:30") + 20_000), a);   // seconds do not matter
  assert.notEqual(D.autoId("n", "p", tb("2026-11-21", "20:30")), a);
});
ok("past its 24 hours it waits for the next day end; none while off, none for a dated task", () => {
  const ctx = ctxAt(tb("2026-11-21", "20:31"));
  assert.deepEqual(D.dueP1Items(D.dueTasks([p1Task()], ctx), p1Rec(), false, ctx).rings.map((r) => r.at), [tb("2026-11-22", "11:00")]);
  const ctx2 = ctxAt(tb("2026-11-21", "13:00"));
  assert.deepEqual(D.dueP1Items(D.dueTasks([p1Task()], ctx2), D.patchDue(rec0(), false, { p1: { on: false } }, 1), false, ctx2).rings, []);
  assert.deepEqual(D.dueP1Items(D.dueTasks([todo("a", { due: "2026-11-21" })], ctx2), p1Rec(), false, ctx2).rings, []);
});

// ---------- your own P1 clock ----------
ok("own clock: a P1 gets its start now (or the squad's), loses it when it leaves P1, starts again when reopened", () => {
  const now = tb("2026-11-21", "07:00"), iso = new Date(now).toISOString();
  const squad = new Date(tb("2026-11-20", "15:00")).toISOString();
  const since = new Date(tb("2026-11-20", "10:00")).toISOString();
  const out = D.p1OwnStamps([
    todo("new", { p1: true }),
    todo("sq", { p1: true, p1At: squad }),
    todo("keep", { p1: true, p1Since: since }),
    todo("left", { p1: false, p1Since: since }),
    todo("daily", { p1: true, type: "daily", p1Since: since }),
    todo("reopen", { p1: true, p1Since: since, doneAt: new Date(tb("2026-11-20", "18:00")).toISOString() }),
    todo("donep1", { p1: true, done: true }),
    todo("gone", { p1: true, clearedAt: iso }),
  ], now);
  assert.deepEqual(out, [
    { id: "new", p1Since: iso }, { id: "sq", p1Since: squad }, { id: "left", p1Since: null }, { id: "daily", p1Since: null }, { id: "reopen", p1Since: iso },
  ]);
});
ok("the P1 timer on the row uses the squad clock first, then your own", () => {
  const now = tb("2026-11-21", "07:00");
  assert.equal(C.p1Deadline({ p1: true, p1Since: new Date(tb("2026-11-20", "20:30")).toISOString() }, now), tb("2026-11-21", "20:30"));
  assert.equal(C.p1Deadline({ p1: true, p1At: new Date(tb("2026-11-20", "15:00")).toISOString(), p1Since: new Date(tb("2026-11-20", "20:30")).toISOString() }, now), tb("2026-11-21", "15:00"));
});

// ---------- the record ----------
ok("the due settings and answers survive cleaning and merging; the newer settings win", () => {
  const a = D.patchDue(rec0(), true, { hours: 2 }, 100);
  const b = D.patchDue(rec0(), true, { lead: 30 }, 200);
  const m = R.mergeRemind(a, b);
  assert.equal(m.due?.lead, 30); assert.equal(m.due?.hours, 3);
  const c = R.cleanRemind(JSON.parse(JSON.stringify(a)));
  assert.equal(c.due?.hours, 2); assert.equal(c.due?.nag.id, "duenag"); assert.equal(c.due?.p1.alarm, true);
  assert.equal(R.cleanRemind({ due: { hours: 99, lead: 1 } }).due?.hours, 12);
  assert.equal(R.cleanRemind({ due: { hours: 99, lead: 1 } }).due?.lead, 5);
});
ok("old answers are let go after 3 days; at most 120 are kept", () => {
  const auto: Record<string, unknown> = {};
  for (let i = 0; i < 130; i++) auto[`n${String(i).padStart(11, "0")}`] = { done: "2026-11-21", at: 10 * 86_400_000 + i };
  auto["nold00000000"] = { done: "2026-11-01", at: 1 };
  const c = R.cleanRemind({ auto, at: 10 * 86_400_000 + 200 });
  assert.equal(Object.keys(c.auto ?? {}).length, 120);
  assert.equal(c.auto?.["nold00000000"], undefined);
});
ok("words: time left in plain words", () => {
  assert.equal(D.leftLong(H), "1 hour"); assert.equal(D.leftLong(2 * H), "2 hours"); assert.equal(D.leftLong(90 * M), "1 hour 30 mins");
  assert.equal(D.leftLong(45 * M), "45 mins"); assert.equal(D.leftLong(M), "1 min"); assert.equal(D.leftLong(10_000), "under a minute");
  assert.equal(D.leftLong(0), "no time"); assert.equal(D.leftLong(-H), "no time");
  assert.equal(D.fillWords("", "", H), "Your task");
  assert.ok(D.fillWords("{task}", "x".repeat(300), H).length <= D.DUE_TEXT_MAX);
});
ok("no em or en dashes in the new words", () => {
  const src = [D.leftLong(H), R.DUE_P1_TEXT, R.DUE_P1_YES, R.DUE_NAG_PILL, R.DUE_P1_TITLE, R.DUE_P1_WORD, D.DUE_OVERDUE_PILL, D.leftLong(-1)].join(" ");
  assert.ok(!/[\u2013\u2014]/.test(src));
});

console.log(`\n${n} passed`);
