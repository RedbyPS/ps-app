// Mini tasks (core/subtasks.ts): ops, the parent's tick, Reset and the sealed op's title match.
import assert from "node:assert/strict";
import { applySubOp, cleanSub, cleanSubOp, resetSubs, subCount, subStreak, tickParentSubs, titleMatches, type Subtask } from "../src/core/subtasks.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const T = "2026-10-24T10:00:00.000Z";
const three = (): Subtask[] => [{ id: "a", title: "Jo", done: false }, { id: "b", title: "Sam", done: false }, { id: "c", title: "Ana", done: false }];

ok("add, tick, rename, remove, restore, order", () => {
  let l = applySubOp([], { op: "add", id: "a", title: "Jo" }, T);
  l = applySubOp(l, { op: "add", id: "b", title: "Sam" }, T);
  l = applySubOp(l, { op: "add", id: "b", title: "Sam again" }, T);
  assert.equal(l.length, 2, "the same id never twice");
  l = applySubOp(l, { op: "tick", id: "a" }, T);
  assert.deepEqual(subCount(l), { done: 1, total: 2 });
  l = applySubOp(l, { op: "tick", id: "a" }, T);
  assert.equal(l[0].done, false, "a second tick unticks (Undo)");
  l = applySubOp(l, { op: "rename", id: "b", title: "Sam P" }, T);
  assert.equal(l[1].title, "Sam P");
  const gone = l[0];
  l = applySubOp(l, { op: "remove", id: "a" }, T);
  assert.deepEqual(l.map((s) => s.id), ["b"]);
  l = applySubOp(l, { op: "restore", item: gone, index: 0 }, T);
  assert.deepEqual(l.map((s) => s.id), ["a", "b"], "Undo puts it back where it was");
  l = applySubOp(l, { op: "order", ids: ["b", "a"] }, T);
  assert.deepEqual(l.map((s) => s.id), ["b", "a"]);
});
ok("all done does not tick the parent; ticking the parent ticks them, unticking puts them back", () => {
  let l = three();
  l = applySubOp(l, { op: "tick", id: "a" }, T);
  const on = tickParentSubs(l, true, T)!;
  assert.ok(on.every((s) => s.done));
  assert.ok(!on[0].byParent, "the one he ticked himself is his");
  const off = tickParentSubs(on, false, T)!;
  assert.deepEqual(off.map((s) => s.done), [true, false, false], "untick the parent: only the ones it ticked untick");
});
ok("Reset: a repeating task's mini tasks untick, an unfinished one-off drops its done ones", () => {
  const l = applySubOp(three(), { op: "tick", id: "b" }, T);
  assert.ok(resetSubs(l, true)!.every((s) => !s.done));
  assert.deepEqual(resetSubs(l, false)!.map((s) => s.id), ["a", "c"]);
});
ok("ops from outside are checked", () => {
  assert.equal(cleanSubOp({ op: "add", id: "x y", title: "a" }), null);
  assert.equal(cleanSubOp({ op: "add", id: "ok1", title: "  " }), null);
  assert.equal(cleanSubOp({ op: "nuke", id: "ok1" }), null);
  assert.deepEqual(cleanSubOp({ op: "tick", id: "ok1", extra: 1 }), { op: "tick", id: "ok1" });
});
ok("sealed ops find the parent by the words of its title", () => {
  assert.ok(titleMatches("Follow-ups for this week", "follow-ups week"));
  assert.ok(!titleMatches("Follow-ups", "follow-ups week"));
  assert.ok(!titleMatches("Anything", ""));
});
// ---------- PS 1.68 streaks on mini tasks (feature task-streaks) ----------
ok("a tick under a repeating task adds one to that mini task's streak, an untick takes it back, once per round", () => {
  let l = applySubOp(three(), { op: "tick", id: "a" }, T, true);
  assert.deepEqual([l[0].streak, l[0].streakTicked, l[0].bestStreak], [1, true, 1]);
  assert.equal(l[1].streak, undefined, "the others are untouched");
  l = applySubOp(l, { op: "tick", id: "a" }, T, true);
  assert.equal(l[0].done, false);
  assert.equal(l[0].streak, undefined, "untick takes the point back");
  assert.equal(l[0].streakTicked, undefined);
  l = applySubOp(l, { op: "tick", id: "a" }, T, true);
  l = applySubOp(l, { op: "tick", id: "a" }, T, true);
  l = applySubOp(l, { op: "tick", id: "a" }, T, true);
  assert.equal(l[0].streak, 1, "tick, untick, tick never counts twice");
});
ok("a one-off task's mini tasks never count a streak", () => {
  const l = applySubOp(three(), { op: "tick", id: "a" }, T);
  assert.equal(l[0].done, true);
  assert.equal(l[0].streak, undefined);
  assert.equal(applySubOp(three(), { op: "tick", id: "a" }, T, false)[0].streakTicked, undefined);
});
ok("ticking the repeating parent counts every mini task it ticks; unticking takes back only those", () => {
  let l = applySubOp(three(), { op: "tick", id: "b" }, T, true);   // b by hand first
  l = tickParentSubs(l, true, T, true)!;
  assert.deepEqual(l.map((s) => s.streak), [1, 1, 1], "b is not counted twice");
  l = tickParentSubs(l, false, T, true)!;
  assert.deepEqual(l.map((s) => s.streak ?? 0), [0, 1, 0], "b was ticked by hand, so it stays done and keeps its point");
  assert.deepEqual(l.map((s) => s.done), [false, true, false]);
});
ok("the Reset that ends the round keeps the streak of done mini tasks and ends the others'", () => {
  // Day 1: all three done. Day 2: a and b done, c missed. Day 3: a done.
  let l = tickParentSubs(three(), true, T, true)!;
  l = resetSubs(l, true, "over")!;
  assert.deepEqual(l.map((s) => [s.done, s.streak]), [[false, 1], [false, 1], [false, 1]]);
  assert.ok(l.every((s) => !s.streakTicked && !s.doneAt && !s.byParent));
  l = applySubOp(l, { op: "tick", id: "a" }, T, true);
  l = applySubOp(l, { op: "tick", id: "b" }, T, true);
  l = resetSubs(l, true, "over")!;
  assert.deepEqual(l.map((s) => s.streak ?? 0), [2, 2, 0]);
  assert.deepEqual(l.map((s) => s.bestStreak ?? 0), [2, 2, 1], "c's best stays");
  l = applySubOp(l, { op: "tick", id: "a" }, T, true);
  l = resetSubs(l, true, "over")!;
  assert.deepEqual(l.map((s) => s.streak ?? 0), [3, 0, 0]);
});
ok("a longer repeat still waiting for its date leaves its mini tasks exactly as they are", () => {
  const l = applySubOp(three(), { op: "tick", id: "a" }, T, true);
  assert.equal(resetSubs(l, true, "wait"), l);
});
ok("a mini task never done and with no streak is left as it is by a Reset", () => {
  const l = three();
  const r = resetSubs(l, true, "over")!;
  assert.equal(r[0], l[0]);
});
ok("streak numbers survive cleaning (Undo of a deleted mini task) and junk is dropped", () => {
  assert.deepEqual(cleanSub({ id: "a", title: "Stretch", done: false, streak: 7, bestStreak: 9, streakTicked: true }),
    { id: "a", title: "Stretch", done: false, streak: 7, bestStreak: 9, streakTicked: true });
  const bad = cleanSub({ id: "a", title: "Stretch", done: false, streak: -3, bestStreak: "9", streakTicked: "yes" })!;
  assert.equal(bad.streak, undefined); assert.equal(bad.bestStreak, undefined); assert.equal(bad.streakTicked, undefined);
  assert.equal(cleanSub({ id: "a", title: "x", done: false, streak: 1e12 })!.streak, 100000);
  assert.equal(cleanSub({ id: "a", title: "x", done: false, streak: NaN })!.streak, undefined);
});
ok("subStreak alone", () => {
  assert.deepEqual(subStreak({ id: "a", title: "x", done: false, streak: 4, bestStreak: 4 }, true), { streak: 5, streakTicked: true, bestStreak: 5 });
  assert.deepEqual(subStreak({ id: "a", title: "x", done: true, streak: 5, streakTicked: true, bestStreak: 9 }, false), { streak: 4, streakTicked: false, bestStreak: 9 });
});
console.log(`${n} passed`);
