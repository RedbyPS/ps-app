// Run: node --experimental-strip-types tests/overview-ui.test.ts
// V1.55 Edit mode overview (views/EditMode.tsx, TaskMap.tsx, ListPager.tsx): the rules that live in the drawing code,
// checked in the source. The pure rules are in tests/overview-layout.test.ts; the real clicks in the headless Brave
// frames (ps-handover-notes/edit-overview/frames.mjs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanPages } from "../src/core/lists.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const em = src("views/EditMode.tsx"), tm = src("views/TaskMap.tsx"), css = src("views/editmode.css"), lp = src("views/ListPager.tsx");

ok("Esc in the overview: the calendar menu, a question, the gallery, then out (leave: the row glides home as it zooms); always marked as used", () => {
  const h = em.slice(em.indexOf("// Esc: the calendar menu"), em.indexOf("useEffect(() => { if (!sure) return;"));
  assert.match(h, /e\.preventDefault\(\); e\.stopImmediatePropagation\(\);/);
  const order = ["calPickNow", "sure", "galleryOpen", "leave()"].map((k) => h.indexOf(k));
  assert.ok(order.every((i, j) => i > 0 && (j === 0 || i > order[j - 1])), String(order));
  assert.doesNotMatch(h, /locked|auth|unlock/i, "never gated");
});
ok("a first copy, page or size on an account that never moved anything is saved", () => {
  assert.match(src("core/actions.ts"), /if \(!keep && isDefault\(data\)\) return;/);
});
ok("the gear and Tab and Lock show on every page and never move to another", () => {
  assert.match(em, /if \(s\?\.keep \|\| inMenu\(id\)\) return true;/);   // PS 1.70: and what lives in the top right menu
  assert.match(em, /slotInfo\(g\.id\)\?\.keep \? null : dropTargetAt/);
});
ok("hidden wins over moved: a moved panel on another page (or removed) is never drawn", () => {
  const i = css.indexOf(".ed-slot.ed-moved.ed-hidden { display: none; }"), j = css.indexOf(".ed-slot.ed-moved { display: flex;");
  assert.ok(i > j && j > 0, "after the moved rule, so it wins");
});
ok("The developer only Google calendars stay the developer only (onRedProject), everyone else picks a Mac account", () => {
  assert.match(tm, /cal\.kind === "google" && !\(isRedAccount\(vs\) && onRedProject\(\)\)/);
  assert.match(em, /const google = red && onRedProject\(\);/);
  assert.match(em, /\{google && \(\s*<button type="button" role="menuitemradio" aria-checked=\{cur\.kind === "google"\}/);
  assert.match(em, /\{!red && accts\.map/);
});
ok("the gallery offers only what this device draws, and every panel and button of it", () => {
  assert.match(em, /gallery\(layout, page, red, PS, pages\)\.filter\(\(g\) => made\.has\(g\.kind\)/);
});
ok("the overview is the floating list's only; the phone and the website's To-do page never edit", () => {
  assert.match(tm, /const editable = !docked && !GOS;/);
  assert.match(tm, /if \(editable\) setOverviewPages\(/);
  assert.match(tm, /This page holds panels\. They show on your Mac and in the Tab list on the website\./);
});
ok("a page made with the overview's + is a page of panels, kept by the lists' cleaning", () => {
  const p = cleanPages([{ id: "abcd1234", name: "Page 2", secs: [], kind: "panels" }, { id: "efgh5678", name: "Gym", secs: [], kind: "nope" }]);
  assert.equal(p[0].kind, "panels");
  assert.equal(p[1].kind, undefined);
  assert.match(lp, /export function newPanelsPage\(at: number\)/);
  assert.match(lp, /kind: "panels"/);
});
ok("the Meetings panel's three buttons are Inner (they drag out and back in)", () => {
  for (const k of ["calrefresh", "privacy"]) assert.match(tm, new RegExp(`<Inner kind="${k}">`));
});
ok("copies are drawn by CopySlots inside the Edit scope, after the columns", () => {
  const a = tm.indexOf('<Slot id="sleep">'), b = tm.indexOf("<CopySlots />");
  assert.ok(a > 0 && b > a);
});
ok("leaving is calm (no overshoot past the screen); the spring is only on the way in", () => {
  assert.match(css, /\.tm-overlay\.ed-able \{\n  transform-origin: 50% 50%;\n  transition: background-color \.22s ease, transform \.5s cubic-bezier\(\.2, \.85, \.25, 1\)/);
  assert.match(css, /html\.ov-on \.tm-overlay\.ed-able \{\n  transition: [^;]*var\(--ov-spring/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\n  \.tm-overlay\.ed-able, \.ov-slot/);
});
ok("no em or en dashes in the new code", () => {
  for (const t of [em, css, src("core/tablayout.ts"), src("core/calfeeds.ts"), readFileSync(new URL("./overview-ui.test.ts", import.meta.url), "utf8")])
    assert.doesNotMatch(t, new RegExp("[\\u2013\\u2014]"));
});

console.log(`\n${n} passed`);
