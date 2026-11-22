// Run: node --experimental-strip-types tests/reset-auto-after-hand.test.ts
// PS 1.74 check: the automatic Reset is let in by maybeAutoReset (core/actions.ts) when it is due, then waits in the
// Reset lane (core/resetsave.ts resetLane) behind a Reset pressed by hand that was already running. It then ran anyway, on the
// list the hand Reset had just unticked: it closes yesterday and writes every daily task as missed yesterday (the hand Reset
// filed their ticks under today). Once the hand Reset has run, the automatic one is no longer due, so it must check again when
// its turn comes. FICTIONAL data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planReset } from "../src/core/resetplan.ts";
import type { Doc, Todo } from "../src/core/model.ts";

const task = (id: string, data: Partial<Todo>): Doc<Todo> =>
  ({ id, ws: null, kind: "todo", author: null, updatedAt: null, data: { title: id, type: "once", done: false, order: 0, createdAt: "2026-11-01T08:00:00.000Z", ...data } }) as Doc<Todo>;
let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok", name); };

ok("the old way: the automatic Reset after the hand one marks a daily done yesterday as missed yesterday", () => {
  const AT = "2026-11-22T09:00:00.000Z";
  const list = [task("gym", { type: "daily", done: true, doneAt: "2026-11-21T18:00:00.000Z" })];
  const hand = planReset(list, { at: AT, tz: "UTC", atMin: 0, dayEndsHour: 4 });
  const after = list.map((d) => ({ ...d, data: hand.puts.find((p) => p.id === d.id)?.data ?? d.data }));
  assert.equal(after[0].data.done, false, "the hand Reset unticked it");
  assert.ok(![...hand.logs.keys()].includes("2026-11-21"), "and filed its tick under today, not yesterday");
  const auto = planReset(after, { at: "2026-11-22T09:00:01.000Z", tz: "UTC", atMin: 0, auto: true });
  assert.equal(auto.missedDay, "2026-11-21");
  assert.deepEqual(auto.missed.map((m) => m.id), ["gym"], "the gym, done yesterday, is written down as missed yesterday");
});
ok("core/actions.ts: the automatic Reset checks again that it is due when its turn in the lane comes", () => {
  const a = readFileSync(new URL("../src/core/actions.ts", import.meta.url), "utf8");
  const body = a.slice(a.indexOf("async function resetTodosNow"), a.indexOf("const plan = planReset", a.indexOf("async function resetTodosNow")));
  assert.match(body, /opts\.auto && !autoResetDue\(/, "a waiting automatic Reset runs even after a hand Reset closed the day");
});
console.log(`${n} passed`);
