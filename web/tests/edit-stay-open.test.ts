// Run: node --experimental-strip-types tests/edit-stay-open.test.ts   (PS_MAC=<ps-mac checkout> also checks PS's side)
// V1.57 (the developer, 13 Nov 2026): "make it so on the macOS edit panel when you click on a page it doesn't just instantly back
// you out of the to do list, it keeps you in until you hold/let go of tab again or you click anywhere on screen that
// there isn't a button/panel".
// Cause: Edit keeps the list up by turning Keep overlay on for itself; leaving Edit turned it off, and PS's Keep off
// always put the list away. Now leaving Edit sends Keep off with stay: PS keeps the list up, pinned (ps-mac KeepCore).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const em = src("views/EditMode.tsx"), tm = src("views/TaskMap.tsx"), app = src("views/PsApp.tsx");
const between = (s: string, a: string, b: string) => { const i = s.indexOf(a); assert.ok(i >= 0, a); const j = s.indexOf(b, i); assert.ok(j > i, b); return s.slice(i, j); };

const button = between(em, "export function EditButton", "\n}\n");
const done = between(button, "const done = () => {", "};");

ok("leaving Edit turns Keep off with stay, and only when Edit turned it on", () => {
  assert.match(done, /if \(!keptBefore\.current\) onKeep\(false, true\);/);
  assert.doesNotMatch(done, /onKeep\(false\)/, "never a plain Keep off, which puts the list away");
});
ok("every way out of Edit goes through done: a page clicked, the room clicked, Done, Esc", () => {
  assert.match(button, /<Overview [^>]*onDone=\{done\}/);
  const leave = between(em, "const leave = () => {", "\n");
  assert.match(leave, /onDone\(\);/);
  assert.match(em, /camGlide\(0, leave, 0\.72\)/, "a page clicked flies in, then leave");
  assert.match(em, /onClick=\{\(\) => \{ sfx\.click\(\); leave\(\); \}\}>Done</);
});
ok("Edit still turns Keep on while it is open (clicks land on the list, Tab let go keeps it)", () => {
  assert.match(button, /if \(!kept\) onKeep\(true\);/);
});
ok("the page sends stay only with Keep off; the Keep tick itself still puts the list away", () => {
  const set = between(tm, "function setKept(on: boolean, stay?: boolean) {", "\n}");
  assert.match(set, /taskMapActions\.keep\(on, !on && stay \? true : undefined\)/);
  assert.match(app, /taskMapActions\.keep = async \(on, stay\) => psPost\(stay \? \{ type: "keep", on, stay: true \} : \{ type: "keep", on \}\)/);
  assert.match(tm, /onKeep=\{\(on\) => setKept\(on\)\}/, "the glass bar's tick: no stay");
  assert.match(tm, /<EditButton ready=\{ready\} kept=\{kept\} onKeep=\{setKept\}/);   // PS 1.68: not before the layout is in
});
ok("once Keep is off, a click on empty space closes the list; on a button or panel it does not", () => {
  assert.match(tm, /const bg = \(e: React\.MouseEvent\) => \{ if \(e\.target !== e\.currentTarget\) return; clearSel\(\); if \(!kept\) onClose\(\); \};/);
  for (const el of [/onMouseLeave=\{\(\) => \{ speed\.current = 0; \}\} onMouseDown=\{bg\}/, /className="tm-scroll" onMouseDown=\{bg\}/, /className="tm-inner" onMouseDown=\{bg\}/]) assert.match(tm, el);
  assert.match(app, /const close = \(\) => psPost\(\{ type: "close" \}\);/);
});
ok("no em or en dashes in what changed", () => {
  for (const s of [done, between(tm, "function setKept", "\n}"), between(tm, "keep: (on: boolean, stay?", "\n")]) assert.doesNotMatch(s, /[–—]/);
});

const mac = process.env.PS_MAC;
if (mac && existsSync(join(mac, "Sources/KeepCore.swift"))) {
  const main = readFileSync(join(mac, "Sources/main.swift"), "utf8"), core = readFileSync(join(mac, "Sources/KeepCore.swift"), "utf8");
  ok("PS: the keep message carries stay to setKeep", () => {
    assert.match(main, /setKeep\(msg\["on"\] as\? Bool \?\? false, stay: msg\["stay"\] as\? Bool == true\)/);
  });
  ok("PS: Keep off with stay keeps the list up, pinned, taking clicks; without it the list goes as before", () => {
    const f = between(main, "func setKeep(_ on: Bool, stay: Bool = false) {", "\n  func setHitRects");
    assert.match(f, /KeepCore\.off\(stay: stay, shown: shown\) == \.stayPinned/);
    assert.match(f, /w\.pinned = true/);
    assert.match(f, /panel\.ignoresMouseEvents = selfTest/);
    assert.match(f, /keepOpen\(\)/);
    assert.match(f, /\} else \{\s*hideOverlay\(force: true\)/);
    assert.match(core, /stay && shown \? \.stayPinned : \.hide/);
  });
} else console.log("skip - PS side (set PS_MAC to a ps-mac checkout with Sources/KeepCore.swift)");

console.log(`${n} ok`);
