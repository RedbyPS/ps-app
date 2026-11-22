// Run: node --experimental-strip-types tests/reset-undo-again.test.ts
// PS 1.74 check: End day, Cmd+Z, End day again (the second End day is what the person wants in the end).
// resetUndoSlot.undo waits for its Reset, but resetLane hands a Reset asked for while one of the same kind runs that SAME run.
// So the second End day joins Reset 1, then the waiting Undo takes Reset 1 back: the list ends NOT reset, the second End day
// silently did nothing (and its own Undo entry runs Undo 1 again). When Reset 1 already ended, the second End day runs at the
// same time as Undo 1 (Undo is not in the lane) and the two split the tasks. FICTIONAL data only.
import assert from "node:assert/strict";
import { planReset } from "../src/core/resetplan.ts";
import * as RS from "../src/core/resetsave.ts";
import type { Doc, Todo } from "../src/core/model.ts";

const AT = "2026-11-21T20:30:00.000Z";
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const task = (id: string, data: Partial<Todo>): Doc<Todo> =>
  ({ id, ws: null, kind: "todo", author: null, updatedAt: null, data: { title: id, type: "once", done: false, order: 0, ...data } }) as Doc<Todo>;
function setup() {
  const db = new Map<string, Todo>();
  for (const id of ["a", "b", "c", "d"]) db.set(id, task(id, { done: true, doneAt: "2026-11-21T09:00:00.000Z" }).data);
  const io = { get: (id: string) => db.get(id), put: async (id: string, d: Todo) => { await wait(5); db.set(id, clone(d)); } };
  const lane = RS.resetLane<() => Promise<void>>();
  // resetTodos as core/actions.ts runs it: through the lane, read, plan, save each task, hand back its Undo.
  const resetTodos = () => lane(false, async () => {
    const list = [...db].map(([id, data]) => task(id, clone(data)));
    const plan = planReset(list, { at: AT, tz: "UTC", atMin: 0 });
    const written = await RS.saveResetPuts(plan.puts, new Map(list.map((d) => [d.id, clone(d.data)])), io);
    return () => RS.undoResetPuts(written, io).then(() => {});
  });
  const cleared = () => [...db.values()].filter((t) => t.clearedAt).length;
  return { slot: RS.resetUndoSlot(), resetTodos, cleared };
}
let n = 0, bad = 0;
const ok = async (name: string, fn: () => unknown) => {
  try { await fn(); n++; console.log("ok", name); } catch (e) { bad++; console.log("FAIL", name, "|", (e as Error).message.split("\n")[0]); }
};

await ok("End day, Undo while it saves, End day again: the list ends reset", async () => {
  const { slot, resetTodos, cleared } = setup();
  const r1 = slot.reset(resetTodos);
  await wait(2);
  const u = slot.undo();
  const r2 = slot.reset(resetTodos);
  await Promise.all([r1, u, r2]);
  await wait(60);
  assert.equal(cleared(), 4, `the second End day must reset all 4 one-offs, ${cleared()} are reset`);
});

await ok("End day, Undo after it ended, End day at once: the list ends reset, never split", async () => {
  const { slot, resetTodos, cleared } = setup();
  await slot.reset(resetTodos);
  const u = slot.undo();
  await wait(7);   // Undo 1 is putting tasks back
  const r2 = slot.reset(resetTodos);
  await Promise.all([u, r2]);
  await wait(60);
  assert.equal(cleared(), 4, `the second End day must reset all 4 one-offs, ${cleared()} are reset`);
});

console.log(`${n} passed, ${bad} failed`);
if (bad) process.exit(1);
