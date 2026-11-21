// V1.57: P1, P2 or P3 typed into a task's name while EDITING it works like in Add task (core/typedprio.ts typedEdit,
// prioStartFor, renamedPrio, with the same parsePrio and the same prioTyped / prioOnAdd state the add box uses).
import assert from "node:assert/strict";
import { parsePrio, prioDismiss, prioOnAdd, prioPicked, prioStartFor, prioTyped, renamedPrio, typedEdit, typedOrder } from "../src/core/typedprio.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
// The Tab list as Editor gets it (lists.ranked): the P1 group, the numbered tasks, then the ones with no priority.
const L = [
  { id: "a", order: 1, p1: true }, { id: "b", order: 2, p1: true },
  { id: "c", order: 3 }, { id: "d", order: 4 }, { id: "e", order: 5 },
  { id: "u", order: 6, unranked: true },
];

ok("same parser as Add: P1 to P3 as their own word, any case, anywhere", () => {
  assert.equal(parsePrio("call Sam p1")?.prio, 1);
  assert.equal(parsePrio("P2 call Sam")?.title, "call Sam");
  assert.equal(parsePrio("buy MP3 player"), null);
  assert.equal(parsePrio("call (P3).")?.title, "call.");
});
ok("edit: typing P1 into a numbered task puts it at the end of the P1 group", () => {
  const e = typedEdit(L, "d", 1)!;
  assert.equal(e.p1, true);
  assert.equal(e.order, 3, "one after b, the last of the group (P1 tasks sort first whatever their order)");
});
ok("edit: P1 for a task with no priority gives it one", () => {
  const e = typedEdit(L, "u", 1)!;
  assert.equal(e.p1, true);
});
ok("edit: P2 takes a task out of P1 and puts it on the P2 level (PS 1.73)", () => {
  const tag = () => "lnew";
  const e = typedEdit(L, "a", 2, tag)!;
  assert.equal(e.p1, false);
  assert.ok(e.order > 3 && e.order < 4, "right after c, the P2 task");
  assert.deepEqual(e.pair, { id: "c", prioGroup: "lnew" }, "c and a now share P2");
  assert.deepEqual(e, typedOrder(L.filter((x) => x.id !== "a"), 2, tag));
});
ok("edit: P3 puts it on the P3 level", () => {
  const e = typedEdit(L, "e", 3, () => "lnew")!;
  assert.equal(e.p1, false);
  // numbered after removing e: c (P2), d (P3): e joins d, right after it, above the task with no priority (u)
  assert.ok(e.order > 4 && e.order < 6);
  assert.deepEqual(e.pair, { id: "d", prioGroup: "lnew" });
});
ok("edit: already at that priority means no move, only the word comes out of the name", () => {
  assert.equal(typedEdit(L, "a", 1), null);
  assert.equal(typedEdit(L, "c", 2), null);
  assert.equal(typedEdit(L, "d", 3), null);
});
ok("edit: a short list puts P3 at the end of the numbered tasks", () => {
  const e = typedEdit([{ id: "x", order: 1 }, { id: "y", order: 2 }], "x", 3)!;
  assert.equal(e.p1, false);
  assert.ok(e.order > 2);
});
ok("edit: a name that already holds a priority word is not changed by opening and saving it", () => {
  const st = prioStartFor("fix the P2 bug");
  assert.equal(prioOnAdd(prioTyped(st, "fix the P2 bug"), "fix the P2 bug"), null);
  assert.equal(prioOnAdd(prioTyped(st, "fix the P2 bug now"), "fix the P2 bug now"), null);
});
ok("edit: a new priority word typed into such a name is taken", () => {
  const st = prioStartFor("fix the P2 bug");
  const t = "fix the P2 bug P1";
  const got = prioOnAdd(prioTyped(st, t), t);
  assert.equal(got?.prio, 1);
  assert.equal(got?.title, "fix the bug");
});
ok("edit: a plain name then P1 typed is taken, and a click on the priority after it wins", () => {
  let st = prioStartFor("call Sam");
  st = prioTyped(st, "call Sam P1");
  assert.equal(prioOnAdd(st, "call Sam P1")?.title, "call Sam");
  assert.equal(prioOnAdd(prioPicked(st), "call Sam P1"), null);
});
ok("edit: no thanks (x on the chip) keeps the word in the name", () => {
  const st = prioDismiss(prioTyped(prioStartFor("call Sam"), "call Sam P1"));
  assert.equal(prioOnAdd(st, "call Sam P1"), null);
});
ok("renamedPrio (Dimension X cards): only a word that is new counts", () => {
  assert.equal(renamedPrio("call Sam", "call Sam P1")?.prio, 1);
  assert.equal(renamedPrio("fix P2 bug", "fix P2 bug later"), null);
  assert.equal(renamedPrio("fix P2 bug", "fix P3 bug")?.prio, 3);
  assert.equal(renamedPrio("call Sam", "call Sam"), null);
  assert.equal(renamedPrio("call Sam", "P1")?.title, "");
});
console.log(`${n} of ${n} ok`);
