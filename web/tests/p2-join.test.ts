// PS 1.77 (the developer, 23 Nov 2026: "I make one task P2, and another P2, and one of them changes to P3/P4 instead"): the priority
// picker in Add task and Edit picks a LEVEL (the P number the list shows) and joins it, and a drop ON a lone numbered task
// joins its level. Pure parts: core/prio.ts (levelPick, placeInLevel, levelMove, canDropOnto, dropOnto), ui/dragOrder.ts
// (dragTarget). Source checks for the wiring that only lives in the views.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canDropOnto, dropOnto, levelMove, levelPick, placeInLevel, prioNumbers, prioRuns, sortPrio, unrankedAfterMove } from "../src/core/prio.ts";
import { ONTO_BAND, dragTarget } from "../src/ui/dragOrder.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
type T = { id: string; order: number; p1?: boolean; unranked?: boolean; prioGroup?: string | null };
const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const doc = (t: T) => ({ id: t.id, ws: null, kind: "todo", author: null, updatedAt: null, data: { title: t.id, type: "once", done: false, ...t } }) as never;
/** The list as the Tab list shows it (sortPrio), flat. */
const shown = (l: T[]): T[] => sortPrio(l.map(doc)).map((d: { data: T }) => d.data);
const nums = (l: T[]) => Object.fromEntries(prioNumbers(shown(l).map((x) => ({ id: x.id, p1: x.p1 === true, unranked: x.unranked === true, prioGroup: x.prioGroup ?? null }))));
const boxes = (l: T[]) => prioRuns(shown(l).map((x) => ({ id: x.id, p1: x.p1 === true, unranked: x.unranked === true, prioGroup: x.prioGroup ?? null }))).filter((r) => r.ids.length >= 2).map((r) => r.ids);
let k = 0;
const tag = () => `t${++k}`;
/** What Add task does with a level picked in Advanced (views/TaskMap.tsx add): placeInLevel, the pair write too. */
function addAt(l: T[], id: string, level: number): T[] {
  const r = placeInLevel(shown(l), level, tag);
  const out = l.map((x) => (r.pair && x.id === r.pair.id ? { ...x, prioGroup: r.pair.prioGroup } : x));
  return [...out, { id, order: r.order, ...(r.prioGroup ? { prioGroup: r.prioGroup } : {}) }];
}
/** What the Edit box's Save does with a level picked (views/TaskMap.tsx Editor save): levelMove, the pair write too. */
function editTo(l: T[], id: string, level: number): T[] {
  const e = levelMove(shown(l), id, level, tag);
  if (!e) return l;
  return l.map((x) => x.id === id ? { ...x, p1: false, unranked: false, order: e.order, prioGroup: e.prioGroup }
    : e.pair && x.id === e.pair.id ? { ...x, prioGroup: e.pair.prioGroup } : x);
}

// ---------- the picker picks a level (Add task) ----------
ok("Add task: Priority 2 picked twice gives two P2 tasks in one box (was P2, P3, P4)", () => {
  let l: T[] = [{ id: "p1", order: 0, p1: true }, { id: "old", order: 1 }, { id: "x", order: 2 }];
  assert.deepEqual(nums(l), { p1: 1, old: 2, x: 3 });
  l = addAt(l, "a", 2);
  assert.deepEqual(nums(l), { p1: 1, old: 2, a: 2, x: 3 }, "joins the lone P2, x stays P3");
  assert.deepEqual(boxes(l), [["old", "a"]], "the box appears");
  l = addAt(l, "b", 2);
  assert.deepEqual(nums(l), { p1: 1, old: 2, a: 2, b: 2, x: 3 }, "a third joins the box, nothing moves to P3 or P4");
  assert.deepEqual(boxes(l), [["old", "a", "b"]]);
});
ok("Add task: with no P2 yet, two picks of Priority 2 still end up together", () => {
  let l: T[] = [{ id: "p1", order: 0, p1: true }];
  const { max } = levelPick(shown(l));
  assert.equal(max, 2, "nothing numbered yet: the picker goes up to P2");
  l = addAt(l, "a", 2);
  l = addAt(l, "b", 2);
  assert.deepEqual(nums(l), { p1: 1, a: 2, b: 2 });
});
ok("Add task: one past the last level makes a new level at the end, as before", () => {
  let l: T[] = [{ id: "a", order: 0 }, { id: "b", order: 1 }];
  const { max } = levelPick(shown(l));
  assert.equal(max, 4);
  l = addAt(l, "c", max);
  assert.deepEqual(nums(l), { a: 2, b: 3, c: 4 });
  assert.deepEqual(boxes(l), []);
});
ok("Add task: a task with no priority below stays below; the new one joins the level above it", () => {
  let l: T[] = [{ id: "a", order: 0 }, { id: "u", order: 1, unranked: true }];
  l = addAt(l, "b", 2);
  assert.deepEqual(shown(l).map((x) => x.id), ["a", "b", "u"]);
  assert.deepEqual(nums(l), { a: 2, b: 2 });
});

// ---------- the picker's range ----------
ok("levelPick: the task's own level and one past the other tasks' last level", () => {
  const l: T[] = [{ id: "p", order: 0, p1: true }, { id: "a", order: 1, prioGroup: "g" }, { id: "b", order: 2, prioGroup: "g" }, { id: "c", order: 3 }, { id: "u", order: 4, unranked: true }];
  assert.deepEqual(levelPick(shown(l)), { current: null, max: 4 }, "new task: P2 to P4");
  assert.deepEqual(levelPick(shown(l), "a"), { current: 2, max: 4 });
  assert.deepEqual(levelPick(shown(l), "c"), { current: 3, max: 3 }, "already the last level alone: nothing past it");
  assert.deepEqual(levelPick(shown(l), "p"), { current: null, max: 4 }, "Priority 1: no level");
  assert.deepEqual(levelPick(shown(l), "u"), { current: null, max: 4 }, "no priority: no level");
});

// ---------- the picker picks a level (Edit) ----------
ok("Edit: a P3 task given Priority 2 joins the lone P2 (both P2, in a box)", () => {
  let l: T[] = [{ id: "a", order: 0 }, { id: "b", order: 1 }, { id: "c", order: 2 }];
  l = editTo(l, "b", 2);
  assert.deepEqual(nums(l), { a: 2, b: 2, c: 3 });
  assert.deepEqual(boxes(l), [["a", "b"]]);
  l = editTo(l, "c", 2);
  assert.deepEqual(nums(l), { a: 2, b: 2, c: 2 });
});
ok("Edit: a lower task given Priority 2 joins it, and the levels between keep their own numbers", () => {
  let l: T[] = [{ id: "a", order: 0 }, { id: "b", order: 1 }, { id: "c", order: 2 }, { id: "d", order: 3 }];
  l = editTo(l, "d", 2);
  assert.deepEqual(nums(l), { a: 2, d: 2, b: 3, c: 4 });
});
ok("Edit: the same level as now changes nothing", () => {
  const l: T[] = [{ id: "a", order: 0 }, { id: "b", order: 1 }];
  assert.equal(levelMove(shown(l), "b", 3, tag), null);
});
ok("Edit: Priority 1 switched off with Priority 2 picked joins the P2 tasks", () => {
  let l: T[] = [{ id: "p", order: 0, p1: true }, { id: "a", order: 1 }, { id: "b", order: 2 }];
  l = editTo(l, "p", 2);
  assert.deepEqual(nums(l), { a: 2, p: 2, b: 3 });
});
ok("Edit: a task with no priority given a level gets that number", () => {
  let l: T[] = [{ id: "a", order: 0 }, { id: "u", order: 1, unranked: true }];
  l = editTo(l, "u", 2);
  assert.deepEqual(nums(l), { a: 2, u: 2 });
});

// ---------- drop ON a lone task ----------
const items = (l: T[]) => shown(l).filter((x) => !x.p1).map((x) => ({ id: x.id, p1: false, unranked: x.unranked === true, prioGroup: x.prioGroup ?? null }));
ok("canDropOnto: only a numbered task alone on its level, never the dragged one", () => {
  const l: T[] = [{ id: "a", order: 0, prioGroup: "g" }, { id: "b", order: 1, prioGroup: "g" }, { id: "c", order: 2 }, { id: "d", order: 3 }, { id: "u", order: 4, unranked: true }];
  assert.equal(canDropOnto(items(l), "c", "d"), true, "lone c");
  assert.equal(canDropOnto(items(l), "a", "d"), false, "a is in a box: let go inside the box instead");
  assert.equal(canDropOnto(items(l), "u", "d"), false, "no priority: no level to join");
  assert.equal(canDropOnto(items(l), "d", "d"), false, "itself");
  assert.equal(canDropOnto(items(l), "d", "a"), true, "a box member onto a lone task");
});
/** What Section's drop does (views/TaskMap.tsx onEnd with onto): dropOnto, then setTodoOrder's rules. */
function drop(l: T[], next: string[], moved: string, over: string): T[] {
  const tags = new Map(l.map((x) => [x.id, x.prioGroup ?? null] as [string, string | null]));
  const unr = new Set(l.filter((x) => x.unranked).map((x) => x.id));
  const j = dropOnto(next, moved, over, tags, unr, tag);
  const nowUnranked = unrankedAfterMove(j.next, moved, unr);
  return j.next.map((id, i) => {
    const x = l.find((y) => y.id === id)!;
    if (id === moved) return { ...x, order: i, unranked: nowUnranked, prioGroup: nowUnranked ? null : j.prioGroup };
    return { ...x, order: i, ...(j.pair && id === j.pair.id ? { prioGroup: j.pair.prioGroup } : {}) };
  });
}
ok("a task dropped ON a lone P2 task: both P2, in a box (was a level of its own)", () => {
  let l: T[] = [{ id: "a", order: 0 }, { id: "b", order: 1 }, { id: "c", order: 2 }];
  l = drop(l, ["a", "c", "b"], "c", "a");   // c let go on a, coming up from below: the drag lands it just below a
  assert.deepEqual(nums(l), { a: 2, c: 2, b: 3 });
  assert.deepEqual(boxes(l), [["a", "c"]]);
});
ok("dropped ON a lone task that already has a tag: it keeps that tag, no write for it", () => {
  const j = dropOnto(["a", "b"], "b", "a", new Map([["a", "old"], ["b", null]]), new Set(), tag);
  assert.equal(j.prioGroup, "old");
  assert.equal(j.pair, undefined);
});
ok("a task with no priority dropped ON the last numbered task joins it (put just above, so it gets a number)", () => {
  let l: T[] = [{ id: "a", order: 0 }, { id: "b", order: 1 }, { id: "u", order: 2, unranked: true }, { id: "v", order: 3, unranked: true }];
  // From below, onto b: the drag lands it just after b, where it would stay with no priority.
  l = drop(l, ["a", "b", "u", "v"], "u", "b");
  assert.deepEqual(nums(l), { a: 2, b: 3, u: 3 });
  assert.equal(l.find((x) => x.id === "u")!.unranked, false);
  assert.equal(l.find((x) => x.id === "v")!.unranked, true, "the other one stays below");
});
ok("dropped ON a lone task right next to it (no move) still joins", () => {
  let l: T[] = [{ id: "a", order: 0 }, { id: "b", order: 1 }];
  l = drop(l, ["a", "b"], "b", "a");
  assert.deepEqual(nums(l), { a: 2, b: 2 });
});

// ---------- the drag: on a row vs between rows ----------
// Rows 40 high, 50 apart: middles 20, 70, 120, 170.
const mids = [20, 70, 120, 170], halves = [20, 20, 20, 20];
ok("dragTarget: without canOnto it is the plain reorder (passing a row's middle swaps)", () => {
  assert.deepEqual(dragTarget(mids, halves, 0, 71), { to: 1, onto: null });
  assert.deepEqual(dragTarget(mids, halves, 0, 69), { to: 0, onto: null });
  assert.deepEqual(dragTarget(mids, halves, 3, 119), { to: 2, onto: null });
});
ok("dragTarget: in the middle half of a row that takes it, the row stays put and is ON", () => {
  const all = () => true;
  assert.equal(ONTO_BAND, 0.5);
  // Coming down from row 0 onto row 2: the dragged row lands just above it; row 2 does not move.
  assert.deepEqual(dragTarget(mids, halves, 0, 125, all), { to: 1, onto: 2 });
  assert.deepEqual(dragTarget(mids, halves, 0, 112, all), { to: 1, onto: 2 });
  // Coming up from row 3 onto row 1: lands just below it.
  assert.deepEqual(dragTarget(mids, halves, 3, 65, all), { to: 2, onto: 1 });
  assert.deepEqual(dragTarget(mids, halves, 3, 78, all), { to: 2, onto: 1 });
});
ok("dragTarget: the top and bottom quarter of a row are between rows (it places, no join)", () => {
  const all = () => true;
  assert.deepEqual(dragTarget(mids, halves, 0, 105, all), { to: 1, onto: null }, "upper quarter of row 2: above it");
  assert.deepEqual(dragTarget(mids, halves, 0, 135, all), { to: 2, onto: null }, "lower quarter of row 2: below it");
});
ok("dragTarget: a row that does not take it (a box, no priority) is a plain reorder", () => {
  assert.deepEqual(dragTarget(mids, halves, 0, 125, (i) => i !== 2), { to: 2, onto: null });
  assert.deepEqual(dragTarget(mids, halves, 0, 20, () => true), { to: 0, onto: null }, "its own row is never ON");
});

// ---------- the wiring in the views ----------
ok("views: Add task and Edit use the level rules; the drag lets go ON a lone task; the row lights up", () => {
  const tm = src("views/TaskMap.tsx");
  assert.match(tm, /placeInLevel\(prio\.map\(\(d\) => \(\{ id: d\.id, \.\.\.d\.data \}\)\), Math\.min\(o\.place, max\)\)/, "Add task: a picked level joins it");
  assert.match(tm, /levelMove\(ranked\.map\(\(x\) => \(\{ id: x\.id, \.\.\.x\.data \}\)\), d\.id, p\)/, "Edit: a picked level joins it");
  assert.doesNotMatch(tm, /orderForPriority\(ranked\.filter\(\(x\) => x\.id !== d\.id\), p\)/, "Edit: no more place in the list");
  assert.match(tm, /canOnto: kind === "prio"/);
  assert.match(tm, /dropOnto\(e\.next, e\.id, e\.onto/);
  assert.match(tm, /data-drop-on=\{drag\["data-drop-on"\]\}/);
  assert.match(src("views/taskmap.css"), /\.tm-row\[data-drop-on\]/);
  assert.match(src("ui/dragOrder.ts"), /"data-drop-on"/);
});
ok("views: the picker's words have no dashes", () => {
  const tm = src("views/TaskMap.tsx");
  const pick = tm.slice(tm.indexOf("function PriorityPicker"), tm.indexOf("export const taskMapActions"));
  for (const w of pick.match(/(?:title|aria-label)="[^"]*"|>[^<>{}]+</g) ?? []) assert.doesNotMatch(w, /[–—]/, w);
  assert.match(pick, /Priority<\/span>/);
  assert.match(tm, />Give it a priority</);
});

console.log(`\n${n} passed`);
