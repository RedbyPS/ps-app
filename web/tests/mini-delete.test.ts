// PS 1.73 (the developer, 21 Nov 2026): "when you have a mini task under a task and you delete the mini task, I don't want you to
// delete the whole task. I want you to delete just the mini task." Every way a mini task can be deleted takes ONLY that
// mini task; the task, its other mini tasks, its priority, level, timers and Priority 1 clock stay. Undo puts back just
// that mini task. Deleting the task on purpose still takes its mini tasks with it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applySubOp, cleanSubOp, withSubOp, type Subtask } from "../src/core/subtasks.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const AT = "2026-11-21T10:00:00.000Z";
const subs: Subtask[] = [{ id: "s1", title: "Email Sam", done: false }, { id: "s2", title: "Call Jo", done: true, doneAt: AT }, { id: "s3", title: "Book room", done: false }];
const parent = { title: "Follow-ups", type: "once" as const, done: false, order: 4, p1: true, p1At: "2026-11-21T08:00:00.000Z", prioGroup: null, unranked: false, due: "2026-11-22", subtasks: subs };

ok("the save: deleting a mini task changes only the mini task list", () => {
  const after = withSubOp(parent, { op: "remove", id: "s2" }, AT);
  assert.deepEqual(after.subtasks!.map((s) => s.id), ["s1", "s3"], "the other mini tasks stay, in order");
  const { subtasks: _a, ...restAfter } = after, { subtasks: _b, ...restBefore } = parent;
  assert.deepEqual(restAfter, restBefore, "title, priority, P1 clock (p1At), level, order, date all untouched");
});
ok("the save: deleting the last mini task leaves the task there with none", () => {
  const one = { ...parent, subtasks: [subs[0]] };
  const after = withSubOp(one, { op: "remove", id: "s1" }, AT);
  assert.deepEqual(after.subtasks, []);
  assert.equal(after.title, "Follow-ups");
});
ok("the save: an unknown mini task id changes nothing", () => {
  assert.deepEqual(withSubOp(parent, { op: "remove", id: "nope" }, AT).subtasks, subs);
});
ok("Undo: restore puts back just that mini task, in its old place, once", () => {
  const gone = applySubOp(subs, { op: "remove", id: "s2" }, AT);
  const back = applySubOp(gone, { op: "restore", item: subs[1], index: 1 }, AT);
  assert.deepEqual(back, subs);
  assert.deepEqual(applySubOp(back, { op: "restore", item: subs[1], index: 1 }, AT), subs, "a second Undo adds no copy");
});
ok("the Mac bridge: a mini task op from the Tab list is applied as a mini task op, never as a task delete", () => {
  const ps = src("ps.ts");
  const subAt = ps.indexOf('"subOp" in m.patch'), rmAt = ps.indexOf('m.type === "remove" && typeof m.id === "string") void deleteTodo');
  assert.ok(subAt > 0 && rmAt > subAt, "the mini task branch comes first");
  assert.match(ps.slice(subAt, subAt + 400), /void subtaskOp\(m\.id, op\)/);
  assert.deepEqual(cleanSubOp({ op: "remove", id: "s2" }), { op: "remove", id: "s2" });
  assert.match(src("core/actions.ts"), /put<Todo>\("todo", withSubOp\(d\.data, op, now\(\)\)/, "the main window saves only the mini task change");
});
ok("the right click menu: a mini task opens its own menu, whose Delete removes only that mini task", () => {
  const mt = src("views/MiniTasks.tsx"), menu = src("views/TaskMenu.tsx");
  assert.match(mt, /onContextMenu=\{\(e\) => \{ if \(edit\) e\.stopPropagation\(\); else openMiniMenu\(e, d\.id, s\.id\); \}\}/, "on each mini task");
  assert.match(mt, /className="mt-box"[\s\S]{0,200}onContextMenu=\{\(e\) => \{ e\.stopPropagation\(\);/, "the rest of the mini list never opens the task's menu");
  assert.match(menu, /export function openMiniMenu\(e: React\.MouseEvent, id: string, subId: string\) \{\n  e\.stopPropagation\(\);/, "it stops before the task row's own menu");
  const mm = menu.slice(menu.indexOf("function MiniMenu("), menu.indexOf("/** Edit from the Overdue card"));
  assert.match(mm, /label: "Delete", hint: "⌫", danger: true, run: \(\) => deleteMini\(d, mini\)/);
  assert.doesNotMatch(mm, /deleteTask|taskMapActions\.remove/, "nothing in the mini task's menu can delete its task");
  assert.match(mm, /e\.key === "Delete" \|\| e\.key === "Backspace"\) \{ own\(\); pick\(items\.find\(\(x\) => x\.key === "x"\)!\); \}/, "Backspace in it: the mini task");
  assert.match(menu, /\{mine && m && m\.mini && <MiniMenu /);
  assert.match(menu, /\{mine && m && !m\.mini && <Menu /, "the task's menu never opens for a mini task");
});
ok("the menu's words are the task menu's own (no new words)", () => {
  const menu = src("views/TaskMenu.tsx");
  const mm = menu.slice(menu.indexOf("function MiniMenu("), menu.indexOf("/** Edit from the Overdue card"));
  const labels = [...mm.matchAll(/label: (?:[^"]*\? )?"([^"]+)"(?: : "([^"]+)")?/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean);
  for (const w of labels) assert.ok(menu.slice(0, menu.indexOf("function MiniMenu(")).includes(`"${w}"`), `${w} is already a task menu word`);
});
ok("the keyboard: Backspace or Delete on a hovered or picked mini task removes only it, and never while a menu is open", () => {
  const mt = src("views/MiniTasks.tsx");
  const key = mt.slice(mt.indexOf("function onKey("), mt.indexOf("function onDown("));
  assert.match(key, /removeMini\(p\)/);
  assert.match(key, /document\.querySelector\("\.tm-ctx"\)\) return;/);
  const rm = mt.slice(mt.indexOf("function removeMini("), mt.indexOf("// ---------- a mini task's own right click menu"));
  assert.match(rm, /miniAct\(d, \{ op: "remove", id: s\.id \}\)/);
  assert.match(rm, /op: "restore", item: s, index/, "with Undo of just that mini task");
  assert.doesNotMatch(rm, /deleteTask|taskMapActions\.remove|deleteTodo/);
});
ok("renaming a mini task to nothing keeps it (no delete by an empty name)", () => {
  const mt = src("views/MiniTasks.tsx");
  assert.match(mt, /if \(v && v !== s\.title\) miniAct\(d, \{ op: "rename", id: s\.id, title: v \}\);\n    else setTitle\(s\.title\);/);
});
ok("the phone, the task API and the AI Inbox have no way to delete a mini task, so none can take its task", () => {
  assert.doesNotMatch(src("gos/touch.ts"), /deleteTask|taskMapActions\.remove|op: "remove"/);
  assert.doesNotMatch(src("core/taskapi.ts"), /subOp|applySubOp|op: "remove"/, "the API only reads mini tasks");
  assert.doesNotMatch(src("core/aiinbox.ts"), /subtasks|subOp/);
});
ok("deleting the task on purpose still takes its mini tasks with it, and its Undo brings them all back", () => {
  const tm = src("views/TaskMap.tsx");
  const del = tm.slice(tm.indexOf("export function deleteTask("), tm.indexOf("/** What the row shows: done or not"));
  assert.match(del, /const data: Todo = \{ \.\.\.t \};/, "the whole task, its mini tasks included, kept for Undo");
  assert.match(del, /taskMapActions\.restore\(id, data\)/);
  assert.match(del, /void taskMapActions\.remove\(id\);/);
});
ok("no em or en dashes in the changed files", () => {
  const re = new RegExp("[\\u2013\\u2014]");
  for (const f of ["views/MiniTasks.tsx", "core/subtasks.ts"]) assert.doesNotMatch(src(f), re, f);
  const menu = src("views/TaskMenu.tsx");
  assert.doesNotMatch(menu.slice(menu.indexOf("function MiniMenu("), menu.indexOf("/** Edit from the Overdue card")), re);
});

console.log(`\nmini delete: ${n} passed`);
