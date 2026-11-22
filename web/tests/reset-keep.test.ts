// Run: node --experimental-strip-types tests/reset-keep.test.ts
// PS 1.74: Reset saves each task on its newest copy (core/resetsave.ts, wired in core/actions.ts resetTodos). Reset plans
// every task first, then saves them one by one with waits in between. Each case is shown lost the old way first (the planned
// copy saved as it was), then kept. FICTIONAL data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planReset } from "../src/core/resetplan.ts";
import { saveResetPuts, undoResetPuts, undoLog, resetOnto } from "../src/core/resetsave.ts";
import { withSubOp } from "../src/core/subtasks.ts";
import type { Doc, Todo } from "../src/core/model.ts";
import type { DayLog } from "../src/core/daylog.ts";

let n = 0;
const tests: [string, () => unknown][] = [];
const ok = (name: string, fn: () => unknown) => tests.push([name, fn]);
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const AT = "2026-11-21T20:30:00.000Z", DONE = "2026-11-21T08:00:00.000Z", LATER = "2026-11-21T20:30:05.000Z";
const sub = (id: string, title: string, done = false) => ({ id, title, done, ...(done ? { doneAt: DONE } : {}) });
const task = (id: string, data: Partial<Todo>): Doc<Todo> =>
  ({ id, ws: null, kind: "todo", author: null, updatedAt: null, data: { title: id, type: "once", done: false, order: 0, ...data } }) as Doc<Todo>;

/** The vault as Reset sees it: every save waits (encrypting), and `during` runs inside the first wait, like a click. */
function vault(list: Doc<Todo>[], during?: (db: Map<string, Todo>) => void) {
  const db = new Map(list.map((d) => [d.id, clone(d.data)]));
  let first = true;
  const io = {
    get: (id: string) => db.get(id),
    put: async (id: string, data: Todo) => {
      db.set(id, clone(data));
      await new Promise((r) => setTimeout(r, 0));
      if (first && during) { first = false; during(db); }
    },
  };
  return { db, io };
}
/** The list at the start of a Reset, its plan and the copies it read. */
function start(list: Doc<Todo>[]) {
  const plan = planReset(list, { at: AT, tz: "UTC", atMin: 0 });
  return { plan, before: new Map(list.map((d) => [d.id, clone(d.data)])) };
}
/** The old way: each planned copy saved as it was planned. */
async function oldSave(plan: ReturnType<typeof planReset>, io: { put: (id: string, d: Todo) => Promise<unknown> }) {
  for (const x of plan.puts) await io.put(x.id, x.data);
}
const list = () => [
  task("t-walk", { title: "Walk", type: "daily", done: true, doneAt: DONE, order: 1, subtasks: [sub("w1", "Shoes on", true)] }),
  task("t-eve", { title: "Evening routine", type: "daily", done: true, doneAt: DONE, order: 2,
    subtasks: [sub("e1", "Stretch", true), sub("e2", "Read 10 pages"), sub("e3", "Plan tomorrow", true)] }),
  task("t-open", { title: "Write the plan", type: "once", done: false, order: 3, subtasks: [sub("o1", "Outline")] }),
];
const subs = (t?: Todo) => (t?.subtasks || []).map((s) => `${s.id}:${s.title}:${s.done ? "x" : "-"}`);

// ---------- 1. a mini task ticked, added or renamed while Reset runs ----------
ok("ticked while Reset runs: lost the old way, kept now (and the rest of the task is still reset)", async () => {
  const tickE2 = (db: Map<string, Todo>) => db.set("t-eve", withSubOp(db.get("t-eve")!, { op: "tick", id: "e2" }, LATER));
  const a = start(list()), old = vault(list(), tickE2);
  await oldSave(a.plan, old.io);
  assert.equal(old.db.get("t-eve")!.subtasks!.find((s) => s.id === "e2")!.done, false, "the old way saved over the tick");
  const b = start(list()), now = vault(list(), tickE2);
  await saveResetPuts(b.plan.puts, b.before, now.io);
  const eve = now.db.get("t-eve")!;
  assert.deepEqual(subs(eve), ["e1:Stretch:-", "e2:Read 10 pages:x", "e3:Plan tomorrow:-"]);
  assert.equal(eve.done, false, "the task itself is still unticked by Reset");
});
ok("added while Reset runs: the new mini task stays, in its place", async () => {
  const add = (db: Map<string, Todo>) => db.set("t-eve", withSubOp(db.get("t-eve")!, { op: "add", id: "e4", title: "Lights off" }, LATER));
  const a = start(list()), old = vault(list(), add);
  await oldSave(a.plan, old.io);
  assert.equal(old.db.get("t-eve")!.subtasks!.some((s) => s.id === "e4"), false, "the old way lost it");
  const b = start(list()), now = vault(list(), add);
  await saveResetPuts(b.plan.puts, b.before, now.io);
  assert.deepEqual(subs(now.db.get("t-eve")), ["e1:Stretch:-", "e2:Read 10 pages:-", "e3:Plan tomorrow:-", "e4:Lights off:-"]);
});
ok("renamed while Reset runs: the new name stays and Reset still unticks it", async () => {
  const ren = (db: Map<string, Todo>) => db.set("t-eve", withSubOp(db.get("t-eve")!, { op: "rename", id: "e1", title: "Stretch 5 min" }, LATER));
  const a = start(list()), old = vault(list(), ren);
  await oldSave(a.plan, old.io);
  assert.equal(old.db.get("t-eve")!.subtasks![0].title, "Stretch", "the old way lost the name");
  const b = start(list()), now = vault(list(), ren);
  await saveResetPuts(b.plan.puts, b.before, now.io);
  assert.deepEqual(subs(now.db.get("t-eve")), ["e1:Stretch 5 min:-", "e2:Read 10 pages:-", "e3:Plan tomorrow:-"]);
});
ok("a task renamed or ticked while Reset runs keeps the change (the task's own fields too)", async () => {
  const edit = (db: Map<string, Todo>) => db.set("t-eve", { ...db.get("t-eve")!, title: "Evening, slow", notes: "new note" });
  const b = start(list()), now = vault(list(), edit);
  await saveResetPuts(b.plan.puts, b.before, now.io);
  const eve = now.db.get("t-eve")!;
  assert.equal(eve.title, "Evening, slow");
  assert.equal(eve.notes, "new note");
  assert.equal(eve.done, false);
});

ok("a finished one-off unticked while Reset runs is never cleared as done; a repeating task ticked again keeps its tick", async () => {
  const L = () => [...list(), task("t-done", { title: "Send the invoice", type: "once", done: true, doneAt: DONE, order: 4 })];
  const edit = (db: Map<string, Todo>) => {
    db.set("t-done", { ...db.get("t-done")!, done: false, doneAt: null });
    db.set("t-eve", { ...db.get("t-eve")!, doneAt: LATER });   // ticked again just now (a new tick time)
  };
  const b = start(L()), now = vault(L(), edit);
  assert.ok(b.plan.puts.some((x) => x.id === "t-done" && x.data.clearedAt), "Reset planned to clear it");
  const w = await saveResetPuts(b.plan.puts, b.before, now.io);
  assert.equal(now.db.get("t-done")!.clearedAt ?? null, null);
  assert.equal(now.db.get("t-done")!.done, false);
  assert.equal(now.db.get("t-eve")!.done, true);
  assert.equal(now.db.get("t-eve")!.doneAt, LATER);
  assert.deepEqual(w.map((x) => x.id).sort(), ["t-walk"]);
});

// ---------- 2. a task deleted while Reset runs ----------
ok("deleted while Reset runs: it came back the old way, it stays deleted now", async () => {
  const del = (db: Map<string, Todo>) => db.delete("t-eve");
  const a = start(list()), old = vault(list(), del);
  await oldSave(a.plan, old.io);
  assert.equal(old.db.has("t-eve"), true, "the old way brought it back");
  const b = start(list()), now = vault(list(), del);
  const w = await saveResetPuts(b.plan.puts, b.before, now.io);
  assert.equal(now.db.has("t-eve"), false);
  assert.deepEqual(w.map((x) => x.id), ["t-walk"]);
});

// ---------- 3. Undo takes back only what Reset wrote ----------
ok("Undo: what Reset changed goes back; an edit made after the Reset stays (it was undone the old way)", async () => {
  const b = start(list()), now = vault(list());
  const w = await saveResetPuts(b.plan.puts, b.before, now.io);
  // After the Reset: a new mini task on Walk, and the open task renamed (Reset never touched it).
  now.db.set("t-walk", withSubOp(now.db.get("t-walk")!, { op: "add", id: "w2", title: "Water" }, LATER));
  now.db.set("t-open", { ...now.db.get("t-open")!, title: "Write the plan today" });
  // The old Undo put back the copy of every task from before the Reset.
  const oldDb = new Map(now.db);
  for (const [id, d] of b.before) oldDb.set(id, clone(d));
  assert.equal(oldDb.get("t-open")!.title, "Write the plan", "the old Undo undid the rename");
  assert.equal(oldDb.get("t-walk")!.subtasks!.length, 1, "the old Undo lost the new mini task");
  await undoResetPuts(w, now.io);
  const walk = now.db.get("t-walk")!, eve = now.db.get("t-eve")!;
  assert.equal(walk.done, true);
  assert.deepEqual(subs(walk), ["w1:Shoes on:x", "w2:Water:-"]);
  assert.equal(eve.done, true);
  assert.deepEqual(subs(eve), ["e1:Stretch:x", "e2:Read 10 pages:-", "e3:Plan tomorrow:x"]);
  assert.equal(now.db.get("t-open")!.title, "Write the plan today");
});
ok("Undo: an edit made WHILE Reset ran stays too, and a task deleted after the Reset is not brought back", async () => {
  const ren = (db: Map<string, Todo>) => db.set("t-eve", withSubOp(db.get("t-eve")!, { op: "rename", id: "e3", title: "Plan the week" }, LATER));
  const b = start(list()), now = vault(list(), ren);
  const w = await saveResetPuts(b.plan.puts, b.before, now.io);
  now.db.delete("t-walk");
  await undoResetPuts(w, now.io);
  assert.equal(now.db.has("t-walk"), false);
  assert.deepEqual(subs(now.db.get("t-eve")), ["e1:Stretch:x", "e2:Read 10 pages:-", "e3:Plan the week:x"]);
});
ok("Undo: a change Reset made that was changed again since stays as it is now", async () => {
  const b = start(list()), now = vault(list());
  const w = await saveResetPuts(b.plan.puts, b.before, now.io);
  now.db.set("t-eve", withSubOp(now.db.get("t-eve")!, { op: "tick", id: "e1" }, LATER));   // ticked again after the Reset
  await undoResetPuts(w, now.io);
  const e1 = now.db.get("t-eve")!.subtasks!.find((s) => s.id === "e1")!;
  assert.equal(e1.done, true);
  assert.equal(e1.doneAt, LATER, "the new tick, not the one from before the Reset");
});
ok("nothing changed meanwhile: the same result as before (the planned copy)", () => {
  const b = start(list());
  for (const x of b.plan.puts) assert.deepEqual(resetOnto(b.before.get(x.id)!, x.data, clone(b.before.get(x.id)!)), x.data);
});

// ---------- the day log ----------
const item = (todoId: string, at: string) => ({ todoId, title: todoId, at });
ok("Undo of the day log: Reset's ticks come off, ticks filed since stay; a log Reset made is removed when nothing else is in it", () => {
  const prev: DayLog = { date: "2026-11-21", items: [item("a", "2026-11-21T07:00:00Z")], updatedAt: "x" };
  const wrote: DayLog = { ...prev, items: [...prev.items, item("b", "2026-11-21T08:00:00Z")], updatedAt: AT };
  const now: DayLog = { ...wrote, items: [...wrote.items, item("c", "2026-11-21T21:00:00Z")] };
  assert.deepEqual(undoLog(prev, wrote, now)!.items.map((i) => i.todoId), ["a", "c"]);
  assert.equal(undoLog(undefined, wrote, wrote), null);
  assert.deepEqual(undoLog(undefined, wrote, now)!.items.map((i) => i.todoId), ["c"]);
});
ok("Undo of the day log: the missed list goes back unless it changed since", () => {
  const prev: DayLog = { date: "d", items: [], updatedAt: "x", missed: [{ id: "m1", title: "Old" }] as any };
  const wrote: DayLog = { ...prev, missed: [{ id: "m2", title: "New" }] as any, missedAt: AT };
  assert.deepEqual(undoLog(prev, wrote, clone(wrote))!.missed, prev.missed);
  assert.equal(undoLog(prev, wrote, clone(wrote))!.missedAt, undefined);
  const changed = { ...clone(wrote), missed: [{ id: "m3", title: "Later" }] as any };
  assert.deepEqual(undoLog(prev, wrote, changed)!.missed, changed.missed);
});

// ---------- wiring ----------
ok("resetTodos saves through saveResetPuts and its Undo through undoResetPuts and undoLog (never the copy from the start)", () => {
  const a = readFileSync(new URL("../src/core/actions.ts", import.meta.url), "utf8");
  const r = a.slice(a.indexOf("async function resetTodosNow"), a.indexOf("// ---------- suggested tasks"));
  assert.match(r, /saveResetPuts\(plan\.puts, before, io\)/);
  assert.match(r, /undoResetPuts\(written, io\)/);
  assert.match(r, /undoLog\(/);
  assert.doesNotMatch(r, /for \(const x of plan\.puts\) await put/);
  assert.doesNotMatch(r, /for \(const b of before\) await put/);
});

for (const [name, fn] of tests) { await fn(); n++; console.log("ok -", name); }
console.log(`\n${n} passed`);
