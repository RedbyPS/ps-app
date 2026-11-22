// PS 1.73 (the developer, 21 Nov 2026): "when you have a mini task under a task and you delete the mini task, I don't want you to
// delete the whole task. I want you to delete just the mini task." Every way a mini task can be deleted takes ONLY that
// mini task; the task, its other mini tasks, its priority, level, timers and Priority 1 clock stay. Undo puts back just
// that mini task. Deleting the task on purpose still takes its mini tasks with it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applySubOp, cleanSubOp, withSubOp, type Subtask } from "../src/core/subtasks.ts";
import { isMenuKey, miniBinShown, miniMenuFor, splitMiniRef } from "../src/core/minimenu.ts";

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
  assert.match(rm, /const cur = fresh\(d\), l = miniList\(cur\), index = l\.findIndex/, "its place from the newest list (break-it 174 round 2)");
  assert.match(rm, /miniAct\(cur, \{ op: "remove", id: s\.id \}\)/);
  assert.match(rm, /op: "restore", item, index/, "with Undo of just that mini task");
  assert.doesNotMatch(rm, /deleteTask|taskMapActions\.remove|deleteTodo/);
});
ok("renaming a mini task to nothing keeps it (no delete by an empty name)", () => {
  const mt = src("views/MiniTasks.tsx");
  assert.match(mt, /if \(v && v !== s\.title\) miniAct\(d, \{ op: "rename", id: s\.id, title: v \}\);\n    else setTitle\(s\.title\);/);
});
ok("the phone's touch code, the task API and the AI Inbox never delete a task for a mini task", () => {
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
// ---------- PS 1.74: the Menu key, the bin, and the phone ----------
ok("1.74 keys: the Menu key and Shift+F10 open a menu, nothing else does", () => {
  assert.equal(isMenuKey({ key: "ContextMenu" }), true);
  assert.equal(isMenuKey({ key: "F10", shiftKey: true }), true);
  assert.equal(isMenuKey({ key: "F10" }), false, "F10 alone is not the menu");
  assert.equal(isMenuKey({ key: "F10", shiftKey: true, metaKey: true }), false);
  assert.equal(isMenuKey({ key: "ContextMenu", ctrlKey: true }), false);
  assert.equal(isMenuKey({ key: "Backspace" }), false);
});
ok("1.74 keys: a mini task mark splits into its task and itself", () => {
  assert.deepEqual(splitMiniRef("t1/s2"), { id: "t1", subId: "s2" });
  assert.deepEqual(splitMiniRef("a/b/s9"), { id: "a/b", subId: "s9" }, "at the last slash");
  for (const bad of [null, undefined, "", "t1", "/s2", "t1/"]) assert.equal(splitMiniRef(bad), null, String(bad));
});
ok("1.74 keys: focus on a mini task opens ITS menu, a clicked one too, otherwise the task's menu as before", () => {
  const base = { focused: null, picked: null, pickedShown: false, focusHoldsPicked: false, menuOpen: false };
  assert.equal(miniMenuFor({ ...base, focused: "t1/s1" }), "t1/s1", "focus on its tick or its name box");
  assert.equal(miniMenuFor({ ...base, focused: "t1/s1", picked: "t1/s3", pickedShown: true, focusHoldsPicked: true }), "t1/s1", "focus wins over an older click");
  assert.equal(miniMenuFor({ ...base, picked: "t1/s3", pickedShown: true, focusHoldsPicked: true }), "t1/s3", "after a click on one");
  assert.equal(miniMenuFor({ ...base, picked: "t1/s3", pickedShown: false, focusHoldsPicked: true }), null, "a clicked one no longer on screen");
  assert.equal(miniMenuFor({ ...base, picked: "t1/s3", pickedShown: true, focusHoldsPicked: false }), null, "focus moved to another task: that task's menu");
  assert.equal(miniMenuFor(base), null, "no mini task: the task's menu, as before");
  assert.equal(miniMenuFor({ ...base, focused: "t1/s1", menuOpen: true }), null, "a menu already open decides its own keys");
  assert.equal(miniMenuFor({ ...base, focused: "broken" }), null);
});
ok("1.74 keys: the listener runs first (window, capture) and opens the mini task's menu, stopping the task row's", () => {
  const mt = src("views/MiniTasks.tsx");
  const mk = mt.slice(mt.indexOf("function onMenuKey("), mt.indexOf("function onKey("));
  assert.match(mk, /miniMenuFor\(\{ focused, picked, pickedShown: !!pickedEl, focusHoldsPicked: /);
  assert.match(mk, /e\.preventDefault\(\); e\.stopPropagation\(\);\n  openMiniMenuAt\(el, at\.id, at\.subId\);/);
  assert.doesNotMatch(mk, /openTaskMenu/, "never the task's menu");
  assert.match(mt, /function onKey\(e: KeyboardEvent\) \{\n  if \(isMenuKey\(e\)\) \{ onMenuKey\(e\); return; \}/);
  assert.match(mt, /window\.addEventListener\("keydown", onKey, true\)/, "capture phase on the window: before the task row's onKeyDown");
  assert.match(mt, /className="mt-box"[\s\S]{0,500}onKeyDown=\{\(e\) => \{ if \(isMenuKey\(e\)\) e\.stopPropagation\(\); \}\}/, "the Add box never opens the task's menu");
  const menu = src("views/TaskMenu.tsx");
  const at = menu.slice(menu.indexOf("export function openMiniMenuAt("), menu.indexOf("const plusDays"));
  assert.match(at, /kb: true, mini: subId \}\);/, "the mini task's own menu, opened by the keyboard");
  const om = menu.slice(menu.indexOf("export function openMiniMenu("), menu.indexOf("export function openMiniMenuAt("));
  assert.match(om, /menu\?\.kb && menu\.mini === subId && menu\.id === id && Date\.now\(\) - menu\.key < 800\) return;/, "the keyboard's own context menu event keeps it");
});
ok("1.74 bin: shows while renaming on every device and on a tapped mini task on the phone only", () => {
  assert.equal(miniBinShown({ editing: true, phone: false, picked: false }), true, "renaming, Mac and website");
  assert.equal(miniBinShown({ editing: true, phone: true, picked: false }), true, "renaming, phone");
  assert.equal(miniBinShown({ editing: false, phone: true, picked: true }), true, "tapped, phone");
  assert.equal(miniBinShown({ editing: false, phone: true, picked: false }), false);
  assert.equal(miniBinShown({ editing: false, phone: false, picked: true }), false, "a clicked one on the Mac: Backspace or right click");
});
ok("1.74 bin: it removes only that mini task with Undo, is called Delete, and never saves a half typed name first", () => {
  const mt = src("views/MiniTasks.tsx");
  const item = mt.slice(mt.indexOf("function MiniItem("), mt.indexOf("function MiniAdd("));
  const bin = item.slice(item.indexOf("miniBinShown("));
  assert.match(bin, /className="mt-bin no-drag" aria-label="Delete" title="Delete"/, "the existing word Delete");
  assert.match(bin, /onClick=\{\(e\) => \{ e\.stopPropagation\(\); gone\.current = true; removeMini\(\{ d, s, index, undo \}\); \}\}/, "removeMini: only that mini task, Undo in its place");
  assert.match(bin, /onPointerDown=\{\(e\) => \{ e\.preventDefault\(\); e\.stopPropagation\(\); \}\} onMouseDown=\{\(e\) => e\.preventDefault\(\)\}/, "the name box keeps focus, no drag starts");
  assert.doesNotMatch(bin.slice(0, bin.indexOf("</button>")), /deleteTask|taskMapActions\.remove|deleteTodo/);
  assert.match(item, /const save = \(\) => \{\n    if \(gone\.current\) return;/, "a deleted mini task is not renamed after");
  assert.match(item, /miniBinShown\(\{ editing: edit, phone: GOS, picked: sel \}\)/);
  assert.match(mt, /const GOS = import\.meta\.env\.MODE === "gos";/);
});
ok("1.74 Undo after the bin: the mini task comes back once, in its old place, its done state and streak kept", () => {
  const rich: Subtask[] = [subs[0], { ...subs[1], streak: 4, bestStreak: 6 }, subs[2]];
  const gone = applySubOp(rich, { op: "remove", id: "s2" }, AT);
  assert.deepEqual(gone.map((x) => x.id), ["s1", "s3"]);
  const back = applySubOp(gone, { op: "restore", item: rich[1], index: 1 }, AT);
  assert.deepEqual(back, rich);
  const first = applySubOp(rich, { op: "remove", id: "s1" }, AT);
  assert.deepEqual(applySubOp(first, { op: "restore", item: rich[0], index: 0 }, AT).map((x) => x.id), ["s1", "s2", "s3"], "the first one back at the top");
});
ok("no em or en dashes in the changed files", () => {
  const re = new RegExp("[\\u2013\\u2014]");
  for (const f of ["views/MiniTasks.tsx", "core/subtasks.ts", "core/minimenu.ts", "views/minitasks.css"]) assert.doesNotMatch(src(f), re, f);
  const menu = src("views/TaskMenu.tsx");
  assert.doesNotMatch(menu.slice(menu.indexOf("function MiniMenu("), menu.indexOf("/** Edit from the Overdue card")), re);
});

console.log(`\nmini delete: ${n} passed`);
