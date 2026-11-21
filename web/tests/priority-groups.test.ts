// PS 1.73 (the developer, 21 Nov 2026): Priority 2, 3... groups like Priority 1, plain by default, and no priority on a new task
// unless one is picked. Pure parts: core/prio.ts (levels, order, drag, looks, new task rank), core/groups.ts (moves),
// core/aiinbox.ts (AI tasks into Priorities). Source checks for the pieces that only live in the views and the bridge.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LEVEL_GROUP_MIN, LV_PLAIN, P1_DEFAULT, levelAfterMove, levelMove, levelTag, lvLook, lvLookPatch, lvMoves, newTaskRank,
  placeInLevel, prioNumbers, prioRuns, sortPrio,
} from "../src/core/prio.ts";
import { planMove, tabLists } from "../src/core/groups.ts";
import { intoSection } from "../src/core/aiinbox.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const T = "2026-11-21";
const d = (id: string, order: number, x: Record<string, unknown> = {}) =>
  ({ id, ws: null, kind: "todo", author: null, updatedAt: null, data: { title: id, type: "once", done: false, order, ...x } }) as never;
const item = (id: string, x: { p1?: boolean; unranked?: boolean; prioGroup?: string | null } = {}) => ({ id, p1: x.p1 === true, unranked: x.unranked, prioGroup: x.prioGroup ?? null });
const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

// ---------- grouping rules ----------
ok("neighbours with the same level tag share one P number; the rest count on from it", () => {
  const nums = prioNumbers([item("p", { p1: true }), item("a", { prioGroup: "g" }), item("b", { prioGroup: "g" }), item("c"), item("d", { prioGroup: "h" }), item("e", { prioGroup: "h" }), item("u", { unranked: true })]);
  assert.deepEqual([...nums.entries()], [["p", 1], ["a", 2], ["b", 2], ["c", 3], ["d", 4], ["e", 4]]);
  assert.equal(nums.has("u"), false, "no priority: no number");
});
ok("with no tags at all the numbers are exactly as before (P2, P3, P4...)", () => {
  const nums = prioNumbers([item("p", { p1: true }), item("a"), item("b"), item("c")]);
  assert.deepEqual([...nums.values()], [1, 2, 3, 4]);
});
ok("a tag split by another task is two levels, never one number across a gap", () => {
  const nums = prioNumbers([item("a", { prioGroup: "g" }), item("x"), item("b", { prioGroup: "g" })]);
  assert.deepEqual([...nums.values()], [2, 3, 4]);
});
ok("runs: each level's tasks; a box only from two tasks (one task alone stays a plain row)", () => {
  const runs = prioRuns([item("a", { prioGroup: "g" }), item("b", { prioGroup: "g" }), item("c"), item("d", { prioGroup: "lone" })]);
  assert.deepEqual(runs, [{ level: 2, ids: ["a", "b"] }, { level: 3, ids: ["c"] }, { level: 4, ids: ["d"] }]);
  assert.equal(LEVEL_GROUP_MIN, 2);
  assert.deepEqual(runs.filter((r) => r.ids.length >= LEVEL_GROUP_MIN).map((r) => r.level), [2]);
});
ok("a tag means nothing on a P1 task or a task with no priority", () => {
  assert.equal(levelTag({ p1: true, prioGroup: "g" }), null);
  assert.equal(levelTag({ unranked: true, prioGroup: "g" }), null);
  assert.equal(levelTag({ prioGroup: "g" }), "g");
  assert.equal(levelTag({ prioGroup: "" }), null);
});

// ---------- ordering ----------
ok("order stays P1, then the levels, then the tasks with no priority; a level's tasks always sit together", () => {
  const list = [d("u", 0, { unranked: true }), d("b2", 9, { prioGroup: "g" }), d("x", 3), d("b1", 2, { prioGroup: "g" }), d("p", 50, { p1: true })];
  assert.deepEqual(sortPrio(list).map((x: { id: string }) => x.id), ["p", "b1", "b2", "x", "u"], "b2's order (9) does not split it from b1");
});
ok("two levels with the same first order never interleave", () => {
  const list = [d("a1", 1, { prioGroup: "ga" }), d("s", 1), d("a2", 5, { prioGroup: "ga" })];
  const out = sortPrio(list).map((x: { id: string }) => x.id);
  assert.ok(out.indexOf("a2") - out.indexOf("a1") === 1, out.join());
});

// ---------- drag ----------
const tags = new Map<string, string | null>([["a", "g"], ["b", "g"], ["c", null], ["m", null]]);
ok("drag: let go inside a box joins that level", () => {
  assert.equal(levelAfterMove(["c", "m", "a", "b"], "m", tags, "g"), "g");
});
ok("drag: between two tasks of one level joins it, even with no box under the pointer", () => {
  assert.equal(levelAfterMove(["a", "m", "b", "c"], "m", tags, null), "g");
  assert.equal(levelAfterMove(["a", "m", "b", "c"], "m", tags), "g");
});
ok("drag: let go outside every box, next to a level, it is a level of its own", () => {
  assert.equal(levelAfterMove(["a", "b", "m", "c"], "m", tags, null), null);
  const own = new Map(tags); own.set("m", "g");
  assert.equal(levelAfterMove(["a", "b", "m", "c"], "m", own, null), null, "a member dragged out of its box leaves the level");
  assert.equal(levelAfterMove(["a", "b", "m", "c"], "m", own), "g", "no pointer: it keeps its level while it still sits next to it");
});
ok("planMove: a task dropped into Priorities between two tasks of one level joins it; elsewhere it has none", () => {
  const all = [d("p", 0, { p1: true }), d("a", 1, { prioGroup: "g" }), d("b", 2, { prioGroup: "g" }), d("c", 3)];
  const L = tabLists(all, [], T);
  const into = planMove(L, { ids: ["p"], to: "prio", index: 1 });
  assert.equal(into.find((w) => w.id === "p")?.patch.prioGroup, "g");
  const after = planMove(L, { ids: ["p"], to: "prio", index: 3 });
  assert.equal(after.find((w) => w.id === "p")?.patch.prioGroup, undefined, "no tag to write: it had none and gets none");
  const box = planMove(L, { ids: ["p"], to: "prio", index: 3, level: "g" });
  assert.equal(box.find((w) => w.id === "p")?.patch.prioGroup, "g", "let go over the box: that level");
  const toP1 = planMove(tabLists([d("a", 1, { prioGroup: "g" }), d("b", 2, { prioGroup: "g" })], [], T), { ids: ["a"], to: "p1", index: 0 });
  assert.equal(toP1.find((w) => w.id === "a")?.patch.prioGroup, null, "into Priority 1: the level goes");
});

// ---------- joining a level (typed P2, the menu) ----------
const R = [{ id: "p", order: 0, p1: true }, { id: "a", order: 1 }, { id: "b", order: 2 }, { id: "u", order: 9, unranked: true }];
ok("joining a level that is one task makes a group of two (both get the new tag)", () => {
  assert.deepEqual(placeInLevel(R, 2, () => "lx"), { order: 1.5, prioGroup: "lx", pair: { id: "a", prioGroup: "lx" } });
});
ok("past the last level: a level of its own above the tasks with no priority", () => {
  assert.deepEqual(placeInLevel(R, 7, () => "lx"), { order: 5.5, prioGroup: null });
});
ok("the menu's Priority: by the number on the badge; already there is nothing to do", () => {
  const ranked = [{ id: "a", order: 1 }, { id: "b", order: 2 }, { id: "c", order: 3 }];
  assert.equal(levelMove(ranked, "b", 3), null);
  assert.deepEqual(levelMove(ranked, "c", 3, () => "lx"), { order: 3, prioGroup: "lx", pair: { id: "b", prioGroup: "lx" } }, "c onto P3 (b) joins b, right after it");
  assert.deepEqual(levelMove(ranked, "a", 4, () => "lx"), { order: 4, prioGroup: "lx", pair: { id: "c", prioGroup: "lx" } }, "a onto P4 joins c, the task showing P4");
  assert.deepEqual(levelMove(ranked, "a", 5, () => "lx"), { order: 4, prioGroup: null }, "past the last: its own level at the end");
});

// ---------- default looks ----------
ok("P2 and lower: Plain by default, no colour, nothing moves; Priority 1 keeps its own look", () => {
  assert.deepEqual(lvLook(undefined, 2), { style: LV_PLAIN, color: null });
  assert.deepEqual(lvLook({}, 5), { style: LV_PLAIN, color: null });
  assert.equal(lvMoves(LV_PLAIN), false);
  assert.equal(P1_DEFAULT, "red-glisten", "Priority 1 is untouched");
});
ok("looks are per level, cleaned, and a level back to Plain with no colour is not saved", () => {
  let v = lvLookPatch(undefined, 2, { color: "#1FE0FF" });
  assert.deepEqual(v, { "2": { color: "#1fe0ff" } });
  v = lvLookPatch(v, 3, { style: "purple" });
  assert.deepEqual(lvLook(v, 3), { style: "purple", color: null });
  assert.deepEqual(lvLook(v, 2), { style: LV_PLAIN, color: "#1fe0ff" }, "level 2 kept");
  v = lvLookPatch(v, 2, { color: null });
  assert.deepEqual(v, { "3": { style: "purple" } });
  assert.deepEqual(lvLook({ "2": { style: "googly", color: "nope" } }, 2), { style: LV_PLAIN, color: null }, "junk reads as Plain");
  assert.equal(lvMoves("red-glisten"), true);
});

// ---------- no priority on add ----------
ok("a new task with no place and no P1 gets no priority (at the bottom, no P number)", () => {
  assert.deepEqual(newTaskRank({ title: "x" } as never), { unranked: true });
  assert.deepEqual(newTaskRank({ type: "once" }), { unranked: true });
});
ok("only an explicit choice gives a priority: P1, a place, the caller's own rank; other lists are left alone", () => {
  assert.deepEqual(newTaskRank({ p1: true }), {});
  assert.deepEqual(newTaskRank({ order: 3 }), {}, "a drag to a spot or a typed P2");
  assert.deepEqual(newTaskRank({ unranked: false }), {});
  assert.deepEqual(newTaskRank({ type: "daily" }), {});
  assert.deepEqual(newTaskRank({ group: "abcd1" }), {});
  assert.deepEqual(newTaskRank({ aiInbox: true }), {});
});
ok("an AI task sent to Priorities has no priority; only Priority 1 gives one", () => {
  const L = tabLists([d("a", 1), d("b", 2)], [], T);
  assert.deepEqual(intoSection("prio", L), { group: null, order: 3, p1: false, unranked: true, prioGroup: null });
  assert.equal(intoSection("p1", L).p1, true);
});
ok("every add path that is not a typed priority adds with no priority", () => {
  assert.match(src("core/actions.ts"), /t = \{ \.\.\.t, \.\.\.newTaskRank\(t\) \};/, "addTodo");
  assert.match(src("views/DimensionX.tsx"), /order, unranked: true, \.\.\.r \}\);/, "Dimension X add box");
  assert.match(src("views/Todo.tsx"), /unranked: data\.unranked === true/, "Undo of a delete puts back exactly what was there");
});

// ---------- wiring ----------
ok("the bridge carries the level and the looks; Settings has the row; the header has its picker", () => {
  assert.match(src("ps.ts"), /"prioGroup" in p\) o\.prioGroup = cleanLevelTag/);
  assert.match(src("ps.ts"), /o\.tmLvLook = lvLookPatch/);
  assert.match(src("ps.ts"), /level: cleanLevelTag\(t\.level\)/);
  assert.match(src("views/PsApp.tsx"), /type: "reorder", ids, p1, \.\.\.\(level \? \{ level \} : \{\}\)/);
  assert.match(src("core/settingsindex.ts"), /id: "prio-groups", group: "looks", name: "Priority groups"/);
  assert.match(src("views/SettingsGroups.tsx"), /"prio-groups": looks\("lvl"\)/);
  assert.match(src("views/TaskMap.tsx"), /<LvHead level=\{head\.level\}/);
  assert.match(src("views/TaskMenu.tsx"), /key: "l", label: myLevel/);
});
ok("no em or en dashes in the new code", () => {
  const re = new RegExp("[\\u2013\\u2014]");
  for (const f of ["core/prio.ts", "core/typedprio.ts", "core/groups.ts", "core/aiinbox.ts", "views/TaskMenu.tsx", "views/taskmap.css", "core/looksoptions.ts", "core/settingsindex.ts"]) assert.doesNotMatch(src(f), re, f);
  const tm = src("views/TaskMap.tsx");
  const lv = tm.slice(tm.indexOf("// ---------- PS 1.73: the Priority 2, 3... group boxes"), tm.indexOf('// ---------- Priority 1 colour (the developer, 2 Nov 2026'));
  assert.ok(lv.length > 1000);
  assert.doesNotMatch(lv, re);
});

console.log(`\npriority groups: ${n} passed`);
