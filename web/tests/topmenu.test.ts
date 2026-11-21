// Run: node --experimental-strip-types tests/topmenu.test.ts
// PS 1.70, the Tab list's top right (the developer, 19 Nov 2026: "all these different buttons and options everywhere, they're all
// very unclear... simplify it, kind of like Apple does"), and Pomodoro off the main screen.
// 1. The menu's rows (core/topmenu.ts): every old top right button is a row, plain names, private ones stay private.
// 2. Edit mode (core/tablayout.ts): menu originals are never on a page, copies are buttons on the page; Pomodoro is only
//    ever added from the Add panel and then sits where it always did.
// 3. The pieces in the page (views/TopMenu.tsx, views/TaskMap.tsx, views/EditMode.tsx): Esc, the phone, nothing lost.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as M from "../src/core/topmenu.ts";
import * as L from "../src/core/tablayout.ts";

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const strip = (t: string) => t.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const raw = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const src = (f: string) => strip(raw(f));
const AT = "2026-11-19T22:00:00.000Z";

// ---------- 1. the rows ----------
const TOP_RIGHT = ["afk", "screentime", "brief", "endday", "net", "activity", "lowpower", "mixer", "clipboard", "gear", "security", "second", "gsquad", "dnd", "pskeys"];
// PS 1.72 (Jan, 21 Nov 2026): The G Squad is the one addition on the page, its own button right beside the menu.
const ON_PAGE = ["screentime", "gear", "gsquad"];
ok("only Screen time, The G Squad and the gear stay on the page; every other top right button lives in the menu", () => {
  for (const id of TOP_RIGHT) {
    const s = L.slotInfo(id)!;
    assert.ok(s, id);
    assert.equal(!!s.menu, !ON_PAGE.includes(id), id);
  }
  assert.ok(L.slotInfo("menu")?.keep, "the menu button can never be removed, so nothing in it can become unreachable");
  assert.ok(!L.canHide("menu") && !L.canHide("gear") && L.canHide("screentime"));
});
ok("every menu slot has a row, and every row names a menu slot", () => {
  for (const s of L.SLOTS.filter((x) => x.menu)) assert.ok(M.TOP_MENU.some((m) => m.slot === s.id), s.id);
  for (const m of M.TOP_MENU) assert.ok(L.slotInfo(m.slot)?.menu, `${m.id} -> ${m.slot}`);
  assert.equal(new Set(M.TOP_MENU.map((m) => m.id)).size, M.TOP_MENU.length);
});
ok("plain names, Apple style: no description, no dashes, short; the developer's examples are there", () => {
  for (const m of M.TOP_MENU) {
    assert.ok(m.label.split(" ").length <= 3, m.label);
    assert.doesNotMatch(m.label, /[–—:.]/, m.label);
  }
  const names = M.TOP_MENU.map((m) => m.label);
  assert.ok(names.includes("Network") && names.includes("Clear clipboard"));
  assert.deepEqual(names, ["AFK timer", "Morning brief", "End day", "Network", "Activity monitor", "Volume mixer", "Low power mode", "Clear clipboard",
    "Do Not Disturb", "Second Computer", "Remote screen", "Tab overlay", "Security", "Lock"]);
});
ok("PS 1.72: The G Squad is out of the menu, its own button right after the menu's, named as Jan wrote it", () => {
  assert.ok(!M.TOP_MENU.some((m) => m.id === ("gsquad" as never) || m.sel === ".gs-btn"), "no G Squad row");
  assert.equal(L.slotInfo("gsquad")?.label, "The G Squad");
  const t = src("views/TaskMap.tsx");
  const menuAt = t.indexOf('<Slot id="menu"><TopMenu>{rest}</TopMenu></Slot>'), gsAt = t.indexOf('<Slot id="gsquad"><GSquadButton /></Slot>'), gearAt = t.indexOf('<Slot id="gear">');
  assert.ok(menuAt > 0 && gsAt > menuAt && gearAt > gsAt, "menu, then The G Squad, then the gear");
  assert.equal(t.slice(t.indexOf("const rest = ("), menuAt).includes("<GSquadButton"), false, "not inside the menu's dock");
  const g = raw("views/GSquad.tsx");
  assert.match(g, /data-tip="The G Squad"/);
  assert.match(g, /aria-label=\{v\.in \? `The G Squad\. /);
});
ok("Clear clipboard says what the button does: it empties the clipboard (NSPasteboard clearContents, or an empty text on the web)", () => {
  assert.match(src("views/TaskMap.tsx"), /clearClipboard: async \(\) => \{ await navigator\.clipboard\.writeText\(""\); \}/);
  assert.match(src("views/TaskMap.tsx"), /aria-label="Clear the clipboard"/);
  assert.equal(M.TOP_MENU.find((m) => m.id === "clipboard")!.sel, "[aria-label='Clear the clipboard']");
});
ok("a row shows only when its real button is there (a switched off feature, the developer's own elsewhere, the website)", () => {
  const all = M.topMenuItems(() => true);
  assert.equal(all.length, M.TOP_MENU.length);
  const some = M.topMenuItems((sel) => sel === ".nm-btn" || sel === ".dnd-btn");
  assert.deepEqual(some.map((m) => m.id), ["net", "dnd"]);
  assert.deepEqual(M.topMenuItems(() => false), []);
});
ok("private only buttons stay private only: the page draws them only where it did before", () => {
  const t = src("views/TaskMap.tsx");
  assert.match(t, /\{red && <Slot id="brief"><BriefButton/, "Morning brief: the developer's account only");
  assert.ok(L.slotInfo("brief")?.red, "and the gallery never offers it to anyone else");
  assert.match(t, /\{secondOnSnap\(s\) && <Slot id="second">/);
  assert.match(t, /\{!docked && PS && <Slot id="security"><SecurityButton/);
  assert.match(t, /\{PS && st\.netMonitor !== false && <Slot id="net"><NetButton \/>/);
  assert.match(t, /\{activityOn && !docked && <Slot id="activity">/);
});
ok("each row's state comes from its real button", () => {
  const b = (o: Partial<M.RealButton>): M.RealButton => ({ pressed: null, label: "", text: "", cls: "", ...o });
  assert.deepEqual(M.rowLive("lowpower", b({ pressed: true })), { on: true });
  assert.deepEqual(M.rowLive("tab", b({ pressed: false })), { on: false });
  assert.deepEqual(M.rowLive("dnd", b({ pressed: true })), { value: "On" });
  assert.deepEqual(M.rowLive("dnd", b({ pressed: false })), {});
  assert.deepEqual(M.rowLive("afk", b({ text: "AFK 14:32", cls: "afk-badge afk" })), { value: "14:32" });
  assert.deepEqual(M.rowLive("afk", b({ text: "Watcher 42:10 left", cls: "afk-badge watch" })), { label: "Watcher", value: "42:10 left" });
  assert.deepEqual(M.rowLive("second", b({ label: "Home M1: online" })), { value: "Online" });
  assert.deepEqual(M.rowLive("second", b({ label: "Second Computer" })), {});
  assert.deepEqual(M.rowLive("security", b({ cls: "sec-btn sec-warn" })), { dot: true });
  assert.deepEqual(M.rowLive("brief", b({ label: "Morning brief, new" })), { dot: true });
  assert.deepEqual(M.rowLive("clipboard", b({ cls: "tm-pill-btn icon ok" })), { value: "Cleared" });
  assert.deepEqual(M.rowLive("net", null), {});
});
ok("the mark on the menu button: needs a look first, then a mode that is on, and its label says which", () => {
  assert.deepEqual(M.menuMark([{ id: "net", live: {} }]), { mark: null, why: [] });
  assert.deepEqual(M.menuMark([{ id: "dnd", live: { value: "On" } }, { id: "lowpower", live: { on: false } }]), { mark: "on", why: ["Do Not Disturb is on"] });
  const w = M.menuMark([{ id: "dnd", live: { value: "On" } }, { id: "brief", live: { dot: true } }, { id: "security", live: { dot: true } }]);
  assert.equal(w.mark, "warn");
  assert.deepEqual(w.why, ["Morning brief needs a look", "Security needs a look"]);
  assert.equal(M.menuMark([{ id: "afk", live: { value: "3:02" } }]).mark, "on");
});
ok("keyboard: up and down wrap, Home and End, a letter jumps to the next row with it", () => {
  assert.equal(M.nextRow(-1, 5, "ArrowDown"), 0);
  assert.equal(M.nextRow(4, 5, "ArrowDown"), 0);
  assert.equal(M.nextRow(0, 5, "ArrowUp"), 4);
  assert.equal(M.nextRow(2, 5, "Home"), 0);
  assert.equal(M.nextRow(2, 5, "End"), 4);
  const names = ["End day", "Network", "Do Not Disturb", "Lock", "Low power mode"];
  assert.equal(M.nextRow(0, 5, "l", names), 3);
  assert.equal(M.nextRow(3, 5, "l", names), 4);
  assert.equal(M.nextRow(4, 5, "l", names), 3);
  assert.equal(M.nextRow(1, 5, "z", names), 1);
  assert.equal(M.nextRow(0, 0, "ArrowDown"), -1);
});

// ---------- 2. Edit mode ----------
ok("a menu original is never on a page or outlined; the gallery says it is in the menu; adding it makes a button", () => {
  const l = L.emptyLayout();
  const page = L.onPage(l, L.MAIN_PAGE, true);
  for (const id of L.MENU_SLOT_IDS) assert.ok(!page.includes(id), id);
  assert.ok(page.includes("menu") && page.includes("gear") && page.includes("screentime"));
  const g = L.gallery(l, L.MAIN_PAGE, true, true).find((x) => x.kind === "net")!;
  assert.deepEqual({ here: g.here, all: g.all, removed: g.removed, menu: g.menu }, { here: 0, all: 0, removed: false, menu: true });
  // An old record where Network was removed: adding it makes a copy (the original lives in the menu, always).
  const r = L.addPanel(L.hideSlot(l, "net", AT), "net", L.MAIN_PAGE, AT, undefined, () => 0.5);
  assert.ok(r.id && L.isCopy(r.id) && L.kindOf(r.id) === "net");
  assert.ok(L.onPage(r.layout, L.MAIN_PAGE, true).includes(r.id!));
  assert.ok(L.inMenu("net") && !L.inMenu(r.id!) && !L.inMenu("gear"));
  assert.ok(!L.MENU_SLOT_IDS.includes("pskeys"), "Tab and Lock is never a button of its own");
  assert.ok(L.drawsBare("net"), "no Edit mode (the website, the phone): the real button still draws, in the menu or the phone's own");
});
ok("Pomodoro: off the main screen for everyone (the developer too, with no migration), only added from the Add panel", () => {
  assert.ok(L.isOptIn("pomodoro") && L.copiesInPlace("pomodoro"));
  for (const red of [true, false]) assert.ok(!L.onPage(L.emptyLayout(), L.MAIN_PAGE, red).includes("pomodoro"));
  // The developer's own record from before (Pomodoro moved by hand): still not on the page.
  const old = L.moveSlot(L.emptyLayout(), "pomodoro", { x: 0.1, y: 0.2, w: 120, h: 34 }, AT);
  assert.ok(!L.onPage(old, L.MAIN_PAGE, true).includes("pomodoro"));
  const g = L.gallery(L.emptyLayout(), L.MAIN_PAGE, true, true).find((x) => x.kind === "pomodoro")!;
  assert.deepEqual({ here: g.here, all: g.all, removed: g.removed }, { here: 0, all: 0, removed: false });
  const r = L.addPanel(L.emptyLayout(), "pomodoro", L.MAIN_PAGE, AT, undefined, () => 0.25);
  assert.ok(r.id && L.isCopy(r.id) && L.onPage(r.layout, L.MAIN_PAGE, true).includes(r.id));
  assert.equal(L.drawsBare("pomodoro"), false, "the website To-do page and the phone follow the default too");
});
ok("an added Pomodoro follows a moved Time zones like the original did (the first one on its page only)", () => {
  let l = L.moveSlot(L.emptyLayout(), "clocks", { x: 0.5, y: 0.1, w: 300, h: 120 }, AT);
  const a = L.addPanel(l, "pomodoro", L.MAIN_PAGE, AT, undefined, () => 0.1); l = a.layout;
  const b = L.addPanel(l, "pomodoro", L.MAIN_PAGE, AT, undefined, () => 0.9); l = b.layout;
  assert.ok(L.followStyle(l, a.id!)?.left, "the first follows");
  assert.equal(L.followStyle(l, b.id!), null, "a second one sits in the column");
  assert.equal(L.followStyle(L.moveSlot(l, a.id!, { x: 0, y: 0, w: 120, h: 34 }, AT), a.id!), null, "moved itself: its own place");
});

// ---------- 3. the page ----------
ok("the Tab list: Screen time, the menu (holding every other button), the gear; the phone keeps its own menu", () => {
  const t = src("views/TaskMap.tsx");
  assert.match(t, /return isPhoneBuild\(\) \? rest : <Slot id="menu"><TopMenu>\{rest\}<\/TopMenu><\/Slot>;/);
  assert.match(t, /<InlineCopies kinds=\{MENU_SLOT_IDS\} \/>\s*<Slot id="gear">/);
  assert.doesNotMatch(t, /className="tm-tr2"/, "the row under the bar is gone (its buttons are in the menu)");
  assert.match(t, /<Slot id="pomodoro"><PomodoroButton docked=\{docked\} \/><\/Slot>\s*<InlineCopies kinds=\{POMODORO_SLOT\} \/>/);
  assert.match(t, /"\.tm-glass-wrap, \.tm-keep:not\(\.isl-hide\), \.tm-tr, \.tm-menu-pop,/, "PS lets clicks through to the open menu");
  // The phone's menu (gos/menu.ts) still finds the buttons it presses inside .tm-tr.
  assert.match(t, /<div className="tm-tr" onMouseDown=\{\(e\) => e\.stopPropagation\(\)\}>\s*\{shows\("screentime"\)/);
});
ok("the menu: Esc closes it and marks the key as used, a click outside closes it, it holds the list while open", () => {
  const s = src("views/TopMenu.tsx");
  assert.match(s, /if \(e\.key !== "Escape"\) return; e\.preventDefault\(\); e\.stopImmediatePropagation\(\); close\(true\);/);
  assert.match(s, /w\.__psDimxClose = esc;/);
  assert.match(s, /document\.addEventListener\("pointerdown", down, true\)/);
  assert.match(s, /psPost\(\{ type: "dimx", open: on \}\)/);
  assert.match(s, /role="menu"/);
  assert.match(s, /aria-haspopup="menu"/);
  assert.match(s, /if \(!shown && phaseRef\.current !== "closed"\) setPhase\("closed"\)/, "the list put away takes the menu with it");
});
ok("Edit mode: a menu original is drawn in the menu, never measured, never placed", () => {
  const e = src("views/EditMode.tsx");
  assert.match(e, /if \(inMenu\(id\)\) return <InstCtx\.Provider value=\{id\}><div data-slot=\{id\} className="ed-slot ed-menu">/);
  assert.match(e, /if \(el\.classList\.contains\("ed-menu"\)\) continue;/);
  assert.match(e, /if \(s\?\.keep \|\| inMenu\(id\)\) return true;/);
  assert.match(e, /filter\(\(id\) => !copiesInPlace\(kindOf\(id\)\)\)/);
  assert.match(e, /g\.menu \? "In the menu"/);
});
ok("only transform and opacity animate; reduced motion turns the motion off", () => {
  const c = raw("views/topmenu.css");
  for (const m of c.matchAll(/transition:\s*([^;]+);/g)) for (const part of m[1].split(/,(?![^()]*\))/)) assert.match(part.trim(), /^(transform|opacity|background|color|none)\b/, part);
  assert.match(c, /@media \(prefers-reduced-motion: reduce\)/);
  for (const k of c.matchAll(/@keyframes [\w-]+ \{([^}]*\}[^}]*)\}/g)) assert.doesNotMatch(k[1], /\b(top|left|width|height|margin)\s*:/, k[0]);
});
ok("Pomodoro's Settings line says where its button is now", () => {
  assert.match(src("core/settingsindex.ts"), /id: "pomo-on", group: "pomodoro", name: "Pomodoro", line: "Add its button to your Tab list with Edit, then Add panel\. Off hides it and stops a running timer\."/);
  assert.match(src("views/Walkthrough.tsx"), /pomodoro\?\.on === false \|\| !pomoShowing\(\)/, "the 1.58 walkthrough never points at a Pomodoro that is not there");
});
ok("no em or en dashes in the new and changed files", () => {
  for (const f of ["core/topmenu.ts", "views/TopMenu.tsx", "views/topmenu.css", "views/topicons.tsx"]) assert.doesNotMatch(raw(f), /[–—]/, f);
});

console.log(`topmenu: ${n} passed`);
