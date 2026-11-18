// Moves between Dimension X's ideas and tasks (core/dimxmove.ts, PS 1.68): a move keeps the item's id, runs once even
// when sent twice, a half done move is finished only when the same id is in both places, two devices never bring a moved
// task back, and the Mac's Tab list window sends every move to the window that holds the vault.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanDimxOp, dropIndex, insertDimx, moveLeftovers, staleEditOfDeleted, taskToIdea } from "../src/core/dimxmove.ts";
import type { DimxItem } from "../src/core/model.ts";
import { planMove, tabLists } from "../src/core/groups.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const card = (id: string, text: string, createdAt = "2026-11-18T10:00:00.000Z", zone: DimxItem["zone"] = "act"): DimxItem => ({ id, text, zone, createdAt });
const task = (id: string, title: string, createdAt = "2026-11-18T09:00:00.000Z", x: Record<string, unknown> = {}) =>
  ({ id, ws: null, kind: "todo", author: null, updatedAt: null, data: { title, type: "once", done: false, order: 0, createdAt, ...x } }) as never;
const T1 = "2026-11-18T12:00:00.000Z";

ok("a task that becomes an idea keeps its id, placed inside its band", () => {
  const list = [card("a1", "A", undefined, "act"), card("s1", "S", undefined, "soon"), card("a2", "B", undefined, "act")];
  const next = taskToIdea(list, { id: "t-123456", title: "  Launch the campaign " }, "act", 1, T1);
  assert.deepEqual(next.map((x) => x.id), ["a1", "s1", "t-123456", "a2"]);
  const c = next.find((x) => x.id === "t-123456")!;
  assert.equal(c.text, "Launch the campaign");
  assert.equal(c.createdAt, T1);   // dated when it arrived among the ideas
});

ok("the same move sent twice (a retry, two devices) adds one card, not two", () => {
  const once = taskToIdea([], { id: "t-123456", title: "X" }, "x", 0, T1);
  const twice = taskToIdea(once, { id: "t-123456", title: "X" }, "soon", 0, "2026-11-18T12:00:05.000Z");
  assert.equal(twice.length, 1);
  assert.equal(twice, once);   // nothing changed, nothing to save
});

ok("insertDimx: a card with the same id moves, never two; an index past the end lands last in its band", () => {
  const list = [card("a1", "A"), card("x1", "X", undefined, "x"), card("a2", "B")];
  assert.deepEqual(insertDimx(list, card("a1", "A"), 5).map((x) => x.id), ["x1", "a2", "a1"]);
  assert.deepEqual(insertDimx(list, card("n1", "N", undefined, "x"), 0).map((x) => x.id), ["a1", "n1", "x1", "a2"]);
  assert.deepEqual(insertDimx([], card("n1", "N"), NaN).map((x) => x.id), ["n1"]);
});

ok("half done move, task to idea (the delete never happened): the task goes, the card stays", () => {
  // The card (T1) arrived after the task was made (09:00): the newer place is where the person put it last.
  const l = moveLeftovers([card("t-1", "Write the brief", T1)], [task("t-1", "Write the brief")]);
  assert.deepEqual(l.tasks, ["t-1"]);
  assert.equal(l.dimx, null);
});

ok("half done move, idea to task (an old copy brought the card back): the card goes, the task stays", () => {
  const l = moveLeftovers([card("c-1", "Call the bank", "2026-11-17T08:00:00.000Z"), card("c-2", "Other")], [task("c-1", "call the bank ", T1)]);
  assert.deepEqual(l.tasks, []);
  assert.deepEqual(l.dimx!.map((x) => x.id), ["c-2"]);
});

ok("never on a guess: different ids with the same words both stay", () => {
  const l = moveLeftovers([card("c-1", "Same words", T1)], [task("t-9", "Same words")]);
  assert.deepEqual(l, { dimx: null, tasks: [] });
});

ok("same id but edited on one side, a done task, or no clear newer side: both stay", () => {
  assert.deepEqual(moveLeftovers([card("c-1", "Edited words", T1)], [task("c-1", "Old words")]), { dimx: null, tasks: [] });
  assert.deepEqual(moveLeftovers([card("c-1", "A", T1)], [task("c-1", "A", undefined, { done: true })]), { dimx: null, tasks: [] });
  assert.deepEqual(moveLeftovers([card("c-1", "A", T1)], [task("c-1", "A", T1)]), { dimx: null, tasks: [] });
  assert.deepEqual(moveLeftovers([card("c-1", "A", "not a date")], [task("c-1", "A")]), { dimx: null, tasks: [] });
  assert.deepEqual(moveLeftovers([card("c-1", "A", T1)], [{ ...task("c-1", "A"), kind: "note" } as never]), { dimx: null, tasks: [] });
});

ok("two devices: an unsent edit of a task deleted (or moved) since its copy is dropped", () => {
  const del = { deleted: true, updated_at: "2026-11-18T12:00:00Z" };
  // Device B ticked the task on the copy it had from 11:00; device A moved it to Ideas at 12:00.
  assert.equal(staleEditOfDeleted("todo", { deleted: false, base: "2026-11-18T11:00:00Z" }, del), true);
  // Made fresh (Undo of a delete, a new task): kept.
  assert.equal(staleEditOfDeleted("todo", { deleted: false, base: null }, del), false);
  // The server copy is not deleted, or the unsent change is a delete itself, or another kind: as before.
  assert.equal(staleEditOfDeleted("todo", { deleted: false, base: "x" }, { deleted: false, updated_at: "y" }), false);
  assert.equal(staleEditOfDeleted("todo", { deleted: true, base: "x" }, del), false);
  assert.equal(staleEditOfDeleted("settings", { deleted: false, base: "x" }, del), false);
  assert.equal(staleEditOfDeleted(undefined, { deleted: false, base: "x" }, del), false);
});

ok("two devices end to end: B's stale edit is dropped, so the task is in one place on both", () => {
  // A: task t-7 becomes an idea (card t-7, task deleted on the server). B: its unsent tick of t-7 is dropped by the rule,
  // and had it gone through anyway, the next tidy finds the same id in both places and keeps the newer (the card).
  const ideas = taskToIdea([], { id: "t-7", title: "Plan Q1" }, "soon", 0, T1);
  assert.equal(staleEditOfDeleted("todo", { deleted: false, base: "2026-11-18T11:59:00Z" }, { deleted: true, updated_at: T1 }), true);
  assert.deepEqual(moveLeftovers(ideas, [task("t-7", "Plan Q1", "2026-11-10T08:00:00.000Z")]).tasks, ["t-7"]);
});

ok("the Mac Tab list window's move op is checked field by field", () => {
  assert.deepEqual(cleanDimxOp({ op: "toIdea", id: "abcd1234-ef", zone: "x", index: 2.4 }), { op: "toIdea", id: "abcd1234-ef", zone: "x", index: 2 });
  assert.deepEqual(cleanDimxOp({ op: "toTask", id: "abcd1234-ef", order: 3.5, p1: true }), { op: "toTask", id: "abcd1234-ef", order: 3.5, p1: true });
  assert.deepEqual(cleanDimxOp({ op: "tidy", id: "whatever" }), { op: "tidy" });
  assert.equal(cleanDimxOp({ op: "toIdea", id: "abcd1234", zone: "nope", index: 0 }), null);
  assert.equal(cleanDimxOp({ op: "toIdea", id: "../x", zone: "x", index: 0 }), null);
  assert.equal(cleanDimxOp({ op: "toTask", id: "abcd1234", order: "x" }), null);
  assert.equal(cleanDimxOp({ op: "delete", id: "abcd1234" }), null);
  assert.equal(cleanDimxOp(null), null);
  assert.equal(cleanDimxOp({ op: "toIdea", id: "abcd1234", zone: "act", index: -5 })!.op, "toIdea");
});

ok("drop index: a row dragged inside its own section counts as planMove counts it", () => {
  assert.equal(dropIndex(1, 0), 2);    // A,B,C: A dropped after B
  assert.equal(dropIndex(0, 2), 0);    // C to the top
  assert.equal(dropIndex(1, 1), 2);    // let go where it was: same place
  assert.equal(dropIndex(3, -1), 3);   // from another section: as shown
});

ok("an AI Inbox task dragged into a list section joins it at the drop place and leaves the inbox in the same write", () => {
  const all = [task("a", "A", undefined, { group: "g1", order: 0 }), task("b", "B", undefined, { group: "g1", order: 1 }), task("i", "I", undefined, { aiInbox: true, order: 9 })];
  const lists = tabLists(all, [{ id: "g1", name: "Campaigns" }], "2026-11-18");
  assert.equal(lists.groups.get("g1")!.length, 2);   // the inbox task is on no list
  assert.deepEqual(planMove(lists, { ids: ["i"], to: "g:g1", index: 1 }), []);   // without the inbox it is not found (as before)
  const plan = planMove(lists, { ids: ["i"], to: "g:g1", index: 1, inbox: true }, all.filter((d: { data: { aiInbox?: boolean } }) => d.data.aiInbox));
  const byId = new Map(plan.map((p) => [p.id, p.patch]));
  assert.deepEqual(byId.get("i"), { order: 1, aiInbox: false, group: "g1" });
  assert.deepEqual(byId.get("b"), { order: 2 });
  assert.equal(byId.has("a"), false);
  // A task that is not in the inbox is never taken from that list.
  assert.deepEqual(planMove(lists, { ids: ["zz"], to: "g:g1", index: 0, inbox: true }, [task("zz", "Z")]), []);
});

// The bug Jan saw on the Mac (18 Nov 2026): the Tab list window holds no keys, so any write it makes itself is refused
// (core/vault.ts mirror writer); a move to Ideas called an action that was not sent to the main window, the delete was
// refused, and the task stayed on the list too. Every write Dimension X makes must be one the Mac sends across.
ok("every action Dimension X calls is sent to the main window on the Mac", () => {
  const used = new Set<string>();
  for (const f of ["../src/views/DimensionX.tsx", "../src/views/DimxLists.tsx"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    for (const m of src.matchAll(/taskMapActions\.(\w+)\(/g)) used.add(m[1]);
  }
  const ps = readFileSync(new URL("../src/views/PsApp.tsx", import.meta.url), "utf8");
  const sent = new Set([...ps.matchAll(/taskMapActions\.(\w+) = /g)].map((m) => m[1]));
  const missing = [...used].filter((a) => !sent.has(a));
  assert.deepEqual(missing, [], `not sent to the main window on the Mac: ${missing.join(", ")}`);
  for (const a of ["toIdea", "toTask", "dimxTidy"]) assert.ok(used.has(a) || a === "toTask", `Dimension X uses ${a}`);
});

console.log(`dimxmove: ${n} passed`);
