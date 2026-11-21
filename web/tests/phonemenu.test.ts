// Run: node --experimental-strip-types tests/phonemenu.test.ts
// PS 1.72 (the developer, 21 Nov 2026): the phone's 1.67 wheel (hold the round button bottom left) is gone: "this awkward GTA 5 looking
// radio station nav bar", "it sucks", and a button parked bottom left blocks what other apps put there. The hamburger is back
// at the top left, always there, and a tap brings out a plain list with every destination the wheel had (gos/navitems.ts,
// gos/GosLayer.tsx GosMenu, gos/launch.ts).
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { MENU, menuItems } from "../src/gos/menu.ts";
import { NAV_ORDER, navItems } from "../src/gos/navitems.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const has = (f: string) => existsSync(new URL(`../${f}`, import.meta.url));
const all = () => true;
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const red = navItems({ red: true, has: all, show: all });
const friend = navItems({ red: false, has: all, show: all });
const layer = read("src/gos/GosLayer.tsx");

ok("every destination the wheel had is in the menu, with the same the developer only rules", () => {
  for (const it of menuItems({ red: true, has: all })) assert.ok(ids(red).includes(it.id), it.id);
  for (const it of menuItems({ red: false, has: all })) assert.ok(ids(friend).includes(it.id), it.id);
  for (const id of ["rules", "numerology", "brief", "campaigns"]) assert.ok(!ids(friend).includes(id), id);
  for (const m of MENU) assert.ok(NAV_ORDER.some((o) => o.id === m.id), `${m.id} has a place`);
  for (const id of ["sleep", "dnd", "clocks", "gym", "numerology", "gsquad", "receipts", "settings", "sounds", "whatsnew", "plan", "inbox", "vault"]) assert.ok(ids(red).includes(id), id);
});
ok("a plain list in the wheel's order, under its headings: Most used, Your day, Tools", () => {
  const secs = red.map((x) => x.section).filter((s, i, a) => a.indexOf(s) === i);
  assert.deepEqual(secs, ["Most used", "Your day", "Tools"]);
  assert.deepEqual(ids(red).slice(0, 3), ["sleep", "dnd", "clocks"]);
});
ok("switched off or missing things drop out: Sleep mode off, screen time off", () => {
  const w = navItems({ red: true, has: (sel) => !sel.includes("tm-st-btn"), show: (id) => id !== "sleep" });
  assert.ok(!ids(w).includes("sleep") && !ids(w).includes("screentime"));
  assert.ok(ids(w).includes("dnd") && ids(w).includes("clocks"));
});
ok("the wheel and its round button are gone, and so is its Settings switch", () => {
  for (const f of ["src/gos/PhoneWheel.tsx", "src/gos/wheel.ts", "src/gos/wheel.css"]) assert.ok(!has(f), f);
  assert.doesNotMatch(layer, /PhoneWheel|wheelOn|gosWheel/);
  assert.doesNotMatch(read("src/core/settingsindex.ts"), /"phone-wheel"/);
  assert.doesNotMatch(read("src/gos/PhoneRows.tsx"), /phone-wheel/);
  assert.doesNotMatch(read("src/gos/phoneprefs.ts"), /wheel: "ps\.phone\.wheel"/);
  assert.doesNotMatch(layer, /round button at the bottom left/);
});
ok("the hamburger is always there, top left, on every page (Vault too), and opens the list", () => {
  assert.match(layer, /<GosMenu open=\{menu\} onOpen=\{setMenu\} items=\{navList\} onLaunch=\{navLaunch\} \/>/);
  assert.match(read("src/gos/gos.css"), /\.gos-menu \{ position: fixed; z-index: 46; top: calc\(var\(--gos-top\) \+ 10px\); left: 12px;/);
  // The Vault pages' own header steps right of it.
  assert.match(read("src/gos/polish/inbox.css"), /html\.gos header\.top \.brand \{ margin-left: calc\(46px \+ 8px\); min-height: 56px; \}/);
});
ok("it never collides: it steps aside for sheets and screens, the Add task + hides while it is open, the island hides too", () => {
  assert.match(read("src/gos/gos.css"), /body:has\(\.dx-layer, \.tm-add-layer, \.gos-sheet-wrap\.open, \.nt-pop, \.tm-pop-wrap\.open\) \.gos-menu \{ opacity: 0;/);
  assert.match(read("src/gos/gos.css"), /\.fp-ask-layer, \.gos-menu\.open\) \.gos-fab \{/);
  assert.match(layer, /<PhoneIsland hidden=\{view === "vault" \|\| settingsOpen \|\| menu \|\|/);
  assert.match(read("src/gos/gos.css"), /\.gos-show-back \{\n\s+position: fixed; z-index: 45; top: calc\(var\(--gos-top\) \+ 10px\); left: 66px;/, "Back to Meetings sits beside it");
});
ok("it closes on a tap beside it, Back and Esc; haptics on taps; Reduce Motion: no slide", () => {
  assert.match(layer, /className="gos-menu-dim" onClick=\{\(\) => \{ haptic\("press"\); onOpen\(false\); \}\}/);
  assert.match(layer, /if \(menu\) \{ e\.preventDefault\(\); setMenu\(false\); \}/);
  assert.match(layer, /if \(e\.key === "Escape"\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); onOpen\(false\); \}/);
  assert.match(read("src/gos/gos.css"), /@media \(prefers-reduced-motion: reduce\) \{ \.gos-menu-list, \.gos-menu-it \{ animation: none; \} \}/);
});
ok("an item's screen still zooms out of where it was tapped and opens full screen (gos/launch.ts, gos/launch.css)", () => {
  assert.match(layer, /onLaunch\(it\.id, \{ x: r\.left \+ r\.width \/ 2, y: r\.top \+ r\.height \/ 2 \}, Math\.max\(r\.width, r\.height\)\)/);
  assert.match(read("src/gos/launch.ts"), /hasAttribute\("data-gos-launch"\)/);
  assert.match(layer, /r\.dataset\.gosLaunch = "";/);
  assert.match(read("src/gos/launch.css"), /html\.gos\[data-gos-launch\] :is\(\.dx-win, \.cs-win, \.bf-win, \.ms-win, \.nu-win, \.sp-win\)/);
});
ok("no new words, and no em or en dashes", () => {
  for (const f of ["src/gos/navitems.ts", "src/gos/launch.ts", "src/gos/launch.css", "src/gos/GosLayer.tsx"]) assert.ok(!/[–—]/.test(read(f)), f);
});
console.log(`${n} passed`);
