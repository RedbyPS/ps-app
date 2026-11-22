// Run: node --experimental-strip-types tests/reset-overlap.test.ts
// PS 1.74 check: two Resets at once (the auto reset at your reset time and a click, the Tab list's sunset button and the main
// window's Reset, two quick clicks). Since 1.74 each Reset skips a task that changed after it read the list, so the two runs
// split the tasks between them, and the Undo you get (the one that finished last) put back only its own share: the rest stayed
// reset. Before 1.74 both runs wrote every task and either Undo put the whole list back. Now a Reset asked for while one runs
// gets that same run and its Undo (core/resetsave.ts resetLane, core/actions.ts resetTodos). FICTIONAL data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planReset } from "../src/core/resetplan.ts";
import * as RS from "../src/core/resetsave.ts";
import type { Doc, Todo } from "../src/core/model.ts";

const AT = "2026-11-21T20:30:00.000Z", DONE = "2026-11-21T08:00:00.000Z";
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const task = (id: string, data: Partial<Todo>): Doc<Todo> =>
  ({ id, ws: null, kind: "todo", author: null, updatedAt: null, data: { title: id, type: "once", done: false, order: 0, ...data } }) as Doc<Todo>;
const start = () => new Map([
  ...["a", "b", "c", "d"].map((id) => [id, clone(task(id, { type: "daily", done: true, doneAt: DONE }).data)] as const),
  ["e", clone(task("e", { type: "once", done: true, doneAt: DONE }).data)] as const,
]);
/** One Reset as resetTodos runs it: read the list, plan, save each task with a wait (encrypting), hand back its Undo. */
function resetIn(db: Map<string, Todo>) {
  const io = { get: (id: string) => db.get(id), put: async (id: string, d: Todo) => { await new Promise((r) => setTimeout(r, 2)); db.set(id, clone(d)); } };
  return async () => {
    const list = [...db].map(([id, data]) => task(id, clone(data)));
    const plan = planReset(list, { at: AT, tz: "UTC", atMin: 0 });
    const written = await RS.saveResetPuts(plan.puts, new Map(list.map((d) => [d.id, clone(d.data)])), io);
    return () => RS.undoResetPuts(written, io).then(() => {});
  };
}
const allBack = (db: Map<string, Todo>, was: Map<string, Todo>) => [...was].every(([id, d]) => JSON.stringify(db.get(id)) === JSON.stringify(d));

let n = 0;
const ok = async (name: string, fn: () => unknown) => { await fn(); n++; console.log("ok", name); };

await ok("the old way: two Resets at once split the tasks, and the Undo you keep puts back only some of them", async () => {
  const db = start(), was = clone([...db]);
  const run = resetIn(db);
  let last: (() => Promise<void>) | null = null;
  await Promise.all([run().then((u) => { last = u; }), new Promise((r) => setTimeout(r, 3)).then(run).then((u) => { last = u; })]);
  await last!();
  assert.equal(allBack(db, new Map(was)), false, "some tasks stay reset after Undo");
});

await ok("one Reset at a time: a Reset asked for while one runs gets that run's Undo, which puts the whole list back", async () => {
  assert.equal(typeof (RS as Record<string, unknown>).resetLane, "function", "core/resetsave.ts has resetLane");
  const lane = (RS as unknown as { resetLane: <T>() => (auto: boolean, run: () => Promise<T>) => Promise<T> }).resetLane<() => Promise<void>>();
  const db = start(), was = new Map(clone([...db]));
  const run = resetIn(db);
  let last: (() => Promise<void>) | null = null;
  const p1 = lane(false, run), p2 = new Promise((r) => setTimeout(r, 3)).then(() => lane(false, run));
  await Promise.all([p1.then((u) => { last = u; }), p2.then((u) => { last = u; })]);
  await last!();
  assert.ok(allBack(db, was), "Undo puts every task back");
});

await ok("an auto reset and a click: the click waits for the auto one, then runs on the newest copy (nothing written twice)", async () => {
  const lane = (RS as unknown as { resetLane: <T>() => (auto: boolean, run: () => Promise<T>) => Promise<T> }).resetLane<string>();
  const seen: string[] = [];
  const job = (name: string) => async () => { seen.push(`${name} start`); await new Promise((r) => setTimeout(r, 5)); seen.push(`${name} end`); return name; };
  const [a, b] = await Promise.all([lane(true, job("auto")), lane(false, job("click"))]);
  assert.deepEqual([a, b], ["auto", "click"]);
  assert.deepEqual(seen, ["auto start", "auto end", "click start", "click end"]);
  // A failed Reset does not block the next one.
  const bad = lane(false, async () => { throw new Error("disk full"); });
  await assert.rejects(bad);
  assert.equal(await lane(false, async () => "next"), "next");
});

await ok("resetTodos goes through the lane", () => {
  const src = readFileSync(new URL("../src/core/actions.ts", import.meta.url), "utf8");
  assert.match(src, /resetLane/);
  assert.match(src, /export function resetTodos\([^)]*\)[^{]*\{\s*return resetOne\(/);
});
console.log(`${n} passed`);
