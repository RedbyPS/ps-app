// Run: node --experimental-strip-types tests/reset-undo.test.ts
// PS 1.74 check: Undo pressed while its Reset still saves. End day in the Tab list puts its Undo entry up first
// (views/TaskMap.tsx endDay: pushUndo, then taskMapActions.reset()), so Cmd+Z right away reaches the main page while the Reset
// runs. ps.ts kept the Undo in psResetUndo only when the Reset finished, and never cleared it when a new one started, so that
// Undo took back the Reset BEFORE (yesterday's: its cleared one-offs come back, a daily not done today shows ticked again), and
// the Reset just asked for stayed. The main window's lastResetUndo (views/TaskMap.tsx) works the same way. FICTIONAL data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planReset } from "../src/core/resetplan.ts";
import * as RS from "../src/core/resetsave.ts";
import type { Doc, Todo } from "../src/core/model.ts";

const AT0 = "2026-11-20T20:30:00.000Z", AT1 = "2026-11-21T20:30:00.000Z";
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const task = (id: string, data: Partial<Todo>): Doc<Todo> =>
  ({ id, ws: null, kind: "todo", author: null, updatedAt: null, data: { title: id, type: "once", done: false, order: 0, ...data } }) as Doc<Todo>;
/** One Reset as resetTodos runs it (read, plan, save each task with a wait, hand back its Undo). */
const resetIn = (db: Map<string, Todo>, at: string) => {
  const io = { get: (id: string) => db.get(id), put: async (id: string, d: Todo) => { await new Promise((r) => setTimeout(r, 3)); db.set(id, clone(d)); } };
  return async () => {
    const list = [...db].map(([id, data]) => task(id, clone(data)));
    const plan = planReset(list, { at, tz: "UTC", atMin: 0 });
    const written = await RS.saveResetPuts(plan.puts, new Map(list.map((d) => [d.id, clone(d.data)])), io);
    return () => RS.undoResetPuts(written, io).then(() => {});
  };
};
/** Yesterday: one-off "old" done, then reset (cleared). Today: one-off "new" done, about to be reset by End day. */
async function day() {
  const db = new Map<string, Todo>([["old", task("old", { done: true, doneAt: "2026-11-20T08:00:00.000Z" }).data]]);
  const u0 = await resetIn(db, AT0)();
  const oldCleared = clone(db.get("old")!);
  assert.ok(oldCleared.clearedAt, "yesterday's Reset cleared the one-off");
  db.set("new", task("new", { done: true, doneAt: "2026-11-21T09:00:00.000Z" }).data);
  const newBefore = clone(db.get("new")!);
  return { db, u0, oldCleared, newBefore };
}
let n = 0;
const ok = async (name: string, fn: () => unknown) => { await fn(); n++; console.log("ok", name); };

await ok("the old way (ps.ts psResetUndo): Undo while the Reset runs takes back yesterday's Reset, today's stays", async () => {
  const { db, u0, oldCleared, newBefore } = await day();
  let psResetUndo: (() => Promise<void>) | null = u0;   // the main page kept yesterday's Undo all along
  const running = resetIn(db, AT1)().then((u) => { psResetUndo = u; });   // m.type === "reset"
  await new Promise((r) => setTimeout(r, 1));
  { const u = psResetUndo; psResetUndo = null; await u?.(); }   // m.type === "resetUndo", a moment later
  await running;
  assert.ok(!db.get("old")!.clearedAt && oldCleared.clearedAt, "yesterday's cleared one-off is back on the list");
  assert.ok(db.get("new")!.clearedAt && !newBefore.clearedAt, "and the Reset the Undo was for is not taken back");
});
await ok("resetUndoSlot: Undo while the Reset runs waits for it and takes back that Reset only", async () => {
  assert.equal(typeof (RS as Record<string, unknown>).resetUndoSlot, "function", "core/resetsave.ts resetUndoSlot is missing");
  const { db, u0, oldCleared, newBefore } = await day();
  const slot = (RS as unknown as { resetUndoSlot: () => { reset: (r: () => Promise<() => Promise<void>>) => Promise<void>; undo: () => Promise<void> } }).resetUndoSlot();
  await slot.reset(async () => u0);   // yesterday's, as the slot held it
  const running = slot.reset(resetIn(db, AT1));
  await new Promise((r) => setTimeout(r, 1));
  await slot.undo();
  await running;
  assert.deepEqual(db.get("old"), oldCleared, "yesterday's Reset stays");
  assert.deepEqual(db.get("new"), newBefore, "today's Reset is taken back");
  await slot.undo();   // a second Undo: nothing left to take back
  assert.deepEqual(db.get("old"), oldCleared);
});
await ok("ps.ts and the main window's Task map hold the Undo in a resetUndoSlot", () => {
  const ps = readFileSync(new URL("../src/ps.ts", import.meta.url), "utf8");
  const tm = readFileSync(new URL("../src/views/TaskMap.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(ps, /psResetUndo = u;/, "ps.ts still keeps the Undo only once the Reset ends");
  assert.doesNotMatch(tm, /lastResetUndo = await resetTodos\(\)/, "TaskMap.tsx still keeps the Undo only once the Reset ends");
});
console.log(`${n} passed`);
