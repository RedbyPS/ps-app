// Run: node --experimental-strip-types tests/edgeguard.test.ts
// PS 1.73 swipe leak on the phone (core/edgeguard.ts, gos/edgeguard.ts): while PS's own pages can be swiped, the side edges over
// them are PS's, not Android's Back. Checks the rule, and that every swipe, scroll and Back path from before is untouched.
// Reads sources with comments taken out; no DOM.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const G = await import("../src/core/edgeguard.ts");
const P = await import("../src/core/phonepanels.ts");

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const src = (f: string) => strip(readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8"));

const home = { home: true, over: false, top: 80, bottom: 760, vh: 800 };

ok("home pages, nothing over them: their area is guarded", () => {
  assert.deepEqual(G.guardArea(home), { top: 80, bottom: 760 });
});
ok("any panel, sheet, menu, pop-up or dialog open: no strips, Back owns every edge", () => {
  assert.equal(G.guardArea({ ...home, over: true }), null);
});
ok("not on the home pages (Vault, signed out, PS in the background): no strips", () => {
  assert.equal(G.guardArea({ ...home, home: false }), null);
});
ok("clamped to the page, and nothing for a sliver or nonsense", () => {
  assert.deepEqual(G.guardArea({ ...home, top: -40, bottom: 900 }), { top: 0, bottom: 800 });
  assert.equal(G.guardArea({ ...home, top: 100, bottom: 140 }), null);
  assert.equal(G.guardArea({ ...home, top: NaN }), null);
  assert.equal(G.guardArea({ ...home, vh: 0 }), null);
});
ok("the message: rounded, and off is 0, 0", () => {
  assert.deepEqual(G.guardMessage({ top: 80.4, bottom: 759.6 }), { type: "edgeGuard", top: 80, bottom: 760 });
  assert.deepEqual(G.guardMessage(null), { type: "edgeGuard", top: 0, bottom: 0 });
});
ok("the layers Back closes are all counted as over the pages", () => {
  const back = src("gos/GosLayer.tsx");
  for (const sel of [".tm-pop-wrap.open", ".cs-layer", "[role='dialog']:not(.tm-overlay)"]) {
    assert.ok(back.includes(sel), `GosLayer back handler still names ${sel}`);
    assert.ok((G.OVER_PAGES as readonly string[]).includes(sel), sel);
  }
  for (const sel of [".dx-layer", ".ms-layer", ".tm-add-layer", ".nt-win", ".scrim", ".sm-overlay", ".gos-sheet-wrap"]) {
    assert.ok((P.PANEL_LAYERS as readonly string[]).includes(sel), sel);
  }
  assert.ok(back.includes("className={`gos-menu${open ? \" open\" : \"\"}`}"), "the menu still opens with .open");
  assert.ok((G.OVER_PAGES as readonly string[]).includes(".gos-menu.open"));
  const edit = src("gos/PhoneEditMode.tsx");
  assert.ok(edit.includes("pm-room") && (G.OVER_PAGES as readonly string[]).includes(".pm-room"));
});
ok("the watcher: asks panelOpen and the extra layers, only on the home swipe area, and posts only edgeGuard", () => {
  const w = src("gos/edgeguard.ts");
  assert.ok(w.includes("panelOpen()"));
  assert.ok(w.includes("OVER_SELECTOR"));
  assert.ok(w.includes("\".gos-home .gos-swipe\""));
  assert.ok(w.includes("document.visibilityState === \"visible\""));
  assert.equal((w.match(/gosPost\(/g) ?? []).length, 1);
  assert.ok(w.includes("if (key === last) return;"), "sends only on a change");
  assert.ok(!/attributeFilter: \[[^\]]*"style"/.test(w), "a finger's drag (style) never makes it look again every frame");
  assert.ok(src("gos/GosLayer.tsx").includes("<div className=\"gos-home\""), "the home layer keeps its class");
  assert.ok(src("gos/GosLayer.tsx").includes("<div ref={ref} className=\"gos-swipe\">"), "the swipe area keeps its class");
});
ok("Back is unchanged: the top layer first, then background with nothing open", () => {
  const t = src("gos/touch.ts");
  assert.ok(t.includes("new CustomEvent(\"gos-back\", { cancelable: true })"));
  assert.ok(t.includes("if (!handled && !changed) gosPost({ type: \"back:none\" });"));
  assert.ok(t.includes("onShell((m) => { if (m.type === \"back\") back(); });"));
  assert.ok(t.includes("startEdgeGuard();"));
});
ok("PS's own swipes are unchanged: every pager still leaves the gesture alone with a panel open", () => {
  assert.ok(src("gos/GosLayer.tsx").includes("if (panelOpen()) { mode = null; return; }"));
  assert.ok(src("gos/PhonePages.tsx").includes("panelOpen()"));
  assert.ok(src("views/ListPager.tsx").includes("panelOpen"));
  const lists = src("core/lists.ts");
  assert.ok(lists.includes("export function pageGesture"), "the one gesture rule is still there");
});
ok("scrolling inside lists: the pane swipe still lets up and down go, and vertical first stays a scroll", () => {
  const g = src("gos/GosLayer.tsx");
  assert.ok(g.includes("mode = Math.abs(x) > Math.abs(y) * 1.4 ? \"x\" : \"y\";"));
  assert.ok(g.includes("if (mode === \"y\") return;"));
});
ok("the iPhone web app sends nothing to a shell (it has none)", () => {
  const b = src("gos/bridge.ts");
  assert.ok(/if \(MWEB\) \{[^\n]*return; \}/.test(b));
});
console.log(`${n} of ${n} ok`);
