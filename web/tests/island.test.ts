// Run: node --experimental-strip-types tests/island.test.ts
// PS Dynamic Island (src/core/island.ts): what it shows, with FICTIONAL tasks and mail.
import assert from "node:assert/strict";
const I = await import("../src/core/island.ts");

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const T = "2026-10-30";
const d = (id: string, order: number, x: Record<string, unknown> = {}) =>
  ({ id, ws: null, kind: "todo", author: null, updatedAt: null, data: { title: "Task " + id, type: "once", done: false, order, ...x } }) as never;
const todos = [d("p1a", 0, { p1: true }), d("p1b", 1, { p1: true }), d("x", 2), d("y", 3), d("gone", 4, { done: true }), d("gym", 0, { type: "daily" })];
const base = { todos, today: T, mail: 0, leads: 0, event: null };
const S = (x: Record<string, unknown> = {}) => I.islandState({ ...base, settings: x as never });
const ev = { id: "m:r1", kind: "mail" as const, title: "Jane just sent an email", sub: "Northwind Silk · Homepage draft", url: "https://mail.google.com/mail/#all/t1" };

ok("defaults: around the notch, next Priority 1 when nothing is in progress", () => {
  const looks = { pill: { style: "classic", fill: null, color: null, size: "regular", icon: false }, notch: { style: "drop", fill: null, color: null, icon: false }, hide: 60, cards: true, top: [], fsMove: true, tickSide: "left", sounds: true };
  assert.deepEqual(I.islandPrefs(undefined), { mode: "notch", idle: "next", ...looks });
  assert.deepEqual(I.islandPrefs({ mode: "pill", idle: "none" }), { mode: "pill", idle: "none", ...looks });
  assert.deepEqual(I.islandPrefs({ mode: "evil", idle: 3 }), { mode: "notch", idle: "next", ...looks });
});
ok("the task in progress shows, bright, with the others counted", () => {
  const s = S({ workingIds: ["x", "gym"] });
  assert.deepEqual(s.task, { id: "x", title: "Task x", dim: false });
  assert.equal(s.more, 1);
  assert.deepEqual(s.tasks.map((t) => t.id), ["x", "gym"]);
});
ok("a ticked or deleted working task is skipped", () => {
  assert.equal(S({ workingIds: ["gone", "nobody", "y"] }).task?.id, "y");
});
ok("older saves with only workingOn still work", () => {
  assert.equal(S({ workingOn: "y" }).task?.id, "y");
});
ok("nothing in progress: the next Priority 1 task, dimmed", () => {
  assert.deepEqual(S({}).task, { id: "p1a", title: "Task p1a", dim: true });
  assert.equal(S({}).more, 0);
});
ok("no Priority 1 group: the top priority instead", () => {
  const s = I.islandState({ ...base, todos: [d("x", 2), d("y", 3)], settings: {} as never });
  assert.equal(s.task?.id, "x");
});
ok("idle none: nothing shows when nothing is in progress", () => {
  assert.equal(S({ island: { mode: "notch", idle: "none" } }).task, null);
});
ok("private mode: titles and the event say only what kind of thing it is", () => {
  const s = I.islandState({ ...base, settings: { workingIds: ["x"], privateMode: true } as never, event: ev });
  assert.equal(s.task?.title, I.PRIVATE_TITLE);
  assert.equal(s.tasks[0].title, I.PRIVATE_TITLE);
  assert.equal(s.task?.id, "x");
  assert.deepEqual(s.event, { ...ev, title: "New client email", sub: "" });
  assert.equal(I.islandState({ ...base, settings: { privateMode: true } as never, event: { ...ev, kind: "lead" } }).event?.title, "New lead reply");
  assert.equal(I.islandState({ ...base, settings: { privateMode: true } as never, event: { ...ev, kind: "chat" } }).event?.title, "A Claude chat finished");
});
ok("counts pass through, never negative", () => {
  const s = I.islandState({ ...base, settings: {} as never, mail: 2, leads: 3 });
  assert.equal(s.mail, 2); assert.equal(s.leads, 3);
  assert.equal(I.islandState({ ...base, settings: {} as never, mail: -1, leads: 0 }).mail, 0);
});
ok("off: says off and carries nothing", () => {
  const s = I.islandState({ ...base, settings: { island: { mode: "off", idle: "next" }, workingIds: ["x"] } as never, mail: 4, event: ev });
  const { pill: _p, notch: _n, ...rest } = s;
  assert.deepEqual(rest, { mode: "off", private: false, task: null, more: 0, tasks: [], mail: 0, leads: 0, event: null, hide: 60, cards: true, top: [], fsMove: true, tickSide: "left", sounds: true, taskOnly: true });
});
ok("pill mode carries the same content", () => {
  assert.equal(S({ island: { mode: "pill", idle: "next" }, workingIds: ["x"] }).mode, "pill");
});
ok("events: the newest fresh card new to this run pops it, once; old ones never", () => {
  const seen = new Set<string>();
  const c = (id: string, at: number, fresh: boolean) => ({ ...ev, id, at, fresh });
  assert.equal(I.pickEvent([c("old", 1, false)], seen), null, "a restart sending an old card");
  assert.equal(I.pickEvent([c("a", 5, true), c("b", 9, true), c("old", 1, false)], seen)?.id, "b");
  assert.equal(I.pickEvent([c("a", 5, true), c("b", 9, true)], seen), null, "each card pops once");
  assert.equal(I.pickEvent([c("old", 1, true)], seen), null, "seen while stale, never pops later");
  const e = I.pickEvent([c("z", 12, true)], seen)!;
  assert.deepEqual(Object.keys(e).sort(), ["id", "kind", "sub", "title", "url"]);
});
ok("hide time (V1.40): 1 minute by default, 5 s to 1 hour, whole seconds, sent to the island", () => {
  assert.equal(I.HIDE_DEFAULT, 60);
  assert.deepEqual([undefined, null, "x", "", true, 30, "300", 2, 99999, 12.6, -5, NaN, Infinity].map(I.hideTime), [60, 60, 60, 60, 60, 30, 300, 5, 3600, 13, 5, 60, 60]);
  assert.equal(I.islandPrefs({ hide: 900 }).hide, 900);
  assert.equal(I.islandPrefs({ hide: "evil" }).hide, 60);
  assert.equal(S({}).hide, 60);
  assert.equal(S({ island: { mode: "pill", idle: "next", hide: 300 } }).hide, 300);
  assert.equal(S({ island: { mode: "off", hide: 30 } }).hide, 30);
  assert.deepEqual(I.HIDE_CHOICES.map(I.hideLabel), ["5 s", "30 s", "1 min", "5 min", "15 min"]);
  assert.equal(I.hideLabel(150), "2 min 30 s");
  assert.equal(I.hideLabel(3600), "1 h");
  assert.ok(I.HIDE_CHOICES.every((c) => I.hideTime(c) === c));
});
ok("long titles are cut", () => {
  const s = I.islandState({ ...base, todos: [d("l", 0, { title: "word ".repeat(80) })], settings: { workingIds: ["l"] } as never });
  assert.ok(s.task!.title.length <= 120);
});
// V1.44 #10 (the developer, 9 Nov 2026, ss5): the island showed "NEXT UP Working" and a ticked "Working" with Undo, a task
// he never made. It was private mode (the mask on the Meetings panel): every task's name became "Working", the
// next up task too, so it read as a task called Working, and each tick on it ticked a REAL hidden task.
ok("phantom Working (V1.44 #10): private mode never shows a task called Working, and offers no hidden next up", () => {
  const s = I.islandState({ ...base, settings: { privateMode: true } as never });
  assert.equal(s.task, null, "a next up task you cannot see is never offered (its tick would tick a hidden task)");
  assert.equal(s.private, true);
  for (const x of [{ privateMode: true }, { privateMode: true, workingIds: ["x", "y"] }, { privateMode: true, island: { mode: "pill", idle: "next" } }]) {
    const t = I.islandState({ ...base, settings: x as never });
    for (const r of [t.task, ...t.tasks]) if (r) assert.notEqual(r.title, "Working", "a label must never read as a task title");
  }
  // Off again: the real next up comes straight back.
  assert.deepEqual(S({ privateMode: false }).task, { id: "p1a", title: "Task p1a", dim: true });
});
ok("ticks only reach a task the island is showing, open and not cleared", () => {
  const st = S({ workingIds: ["x"] });
  assert.deepEqual(I.shownIds(st), ["x"]);
  const todo = (x: Record<string, unknown> = {}) => ({ title: "t", type: "once", done: false, ...x }) as never;
  assert.equal(I.canTick(st, "x", todo()), true);
  assert.equal(I.canTick(st, "p1a", todo()), false, "not on the island (an old state the native side still had)");
  assert.equal(I.canTick(st, "x", todo({ done: true })), false, "already ticked");
  assert.equal(I.canTick(st, "x", todo({ clearedAt: "2026-11-09T10:00:00Z" })), false, "cleared from Completed");
  assert.equal(I.canTick(st, "x", undefined), false, "deleted");
  assert.equal(I.canTick(null, "x", todo()), false, "nothing sent yet");
  const idle = S({});
  assert.deepEqual(I.shownIds(idle), ["p1a"]);
  assert.equal(I.canTick(idle, "p1a", todo()), true, "the next up task when private mode is off");
  assert.deepEqual(I.shownIds(I.islandState({ ...base, settings: { privateMode: true } as never })), []);
});
ok("Undo only takes back the island's own last tick, and only for a short while", () => {
  const done = { title: "t", type: "once", done: true } as never, open = { title: "t", type: "once", done: false } as never;
  const last = { id: "x", at: 1_000, working: ["x"] };
  assert.equal(I.canUndo(last, "x", done, 1_000 + 5_000), true);
  assert.equal(I.canUndo(last, "y", done, 2_000), false, "another task");
  assert.equal(I.canUndo(last, "x", open, 2_000), false, "already open again");
  assert.equal(I.canUndo(last, "x", done, 1_000 + I.UNDO_MS + 1), false, "too late");
  assert.equal(I.canUndo(null, "x", done, 2_000), false, "no tick from the island");
  assert.equal(I.canUndo(last, "x", undefined, 2_000), false, "deleted");
});
console.log(`\n${n} passed`);
