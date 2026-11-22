// PS 1.74: nothing on a full screen PS screen sits under the notch. On a MacBook Air with a notch the Clients tab row (client
// tabs, then + and Esc) sat under it and hid the top centre tabs. The Tab list window covers the menu bar, so every full
// screen PS screen (and every pop up at the top centre of it) starts below the menu bar and the notch: --safe-top, which
// the Mac app sets from the screen's own safe area (mac/Sources/ScreenFit.swift, web core/screenfit.ts). The website has
// no --safe-top (0), and the phone keeps its own status bar rules (--sat).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanScreen, screenVars } from "../src/core/screenfit.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const css = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
/** The rule that starts with this selector, up to its closing brace. */
const rule = (f: string, sel: string) => {
  const s = css(f), i = s.indexOf(`${sel} {`);
  assert.ok(i >= 0, `${f}: ${sel}`);
  return s.slice(i, s.indexOf("}", i) + 1);
};

ok("the Mac's notch reaches the page as --safe-top (points over the page zoom)", () => {
  const s = cleanScreen({ w: 1470, h: 956, scale: 2, zoom: 1, top: 38 })!;
  assert.equal(screenVars(s)["--safe-top"], "38px", "a MacBook Air with a notch");
  assert.equal(screenVars(cleanScreen({ w: 1280, h: 800, scale: 2, zoom: 0.889, top: 32 })!)["--safe-top"], "36px", "a smaller screen, zoomed out");
  assert.equal(screenVars(cleanScreen({ w: 1920, h: 1080, scale: 1, zoom: 1, top: 25 })!)["--safe-top"], "25px", "no notch: the menu bar");
});

ok("Clients: the whole screen, tab row first, starts below the notch on the Mac, the phone keeps its own rule", () => {
  assert.match(rule("clients/clientsbtn.css", ".clw-layer:not(.gos) .clw-body"), /padding-top: var\(--safe-top, 0px\);/);
  assert.match(rule("clients/clientsbtn.css", ".clw-layer.gos .clw-body"), /padding-top: var\(--sat, 0px\);/, "the phone, unchanged");
  assert.match(rule("clients/clientsbtn.css", ".clw-body"), /box-sizing: border-box;/, "the room comes off the inside, the screen does not grow");
  // The tab row is the first thing in the screen: nothing in it is placed against the window's top edge on its own.
  assert.doesNotMatch(rule("clients/clients.css", ".clw-tabs"), /position: (absolute|fixed)/);
});

ok("every other full screen PS screen over the Tab list already starts below the notch", () => {
  assert.match(css("soundboard/soundboard.css"), /top: calc\(var\(--safe-top, 0px\) \+ 1\.6vh\)/, "Soundboard");
  assert.match(rule("fitness/fitness.css", ".fit-scr"), /top: calc\(var\(--safe-top, 0px\) \+ 2\.2vh\)/, "Fitness");
  assert.match(rule("views/dimx.css", ".dx-win"), /top: calc\(var\(--safe-top, 0px\) \+ 2\.2vh\)/, "Dimension X");
  assert.match(rule("views/cstats.css", ".cs-win"), /top: calc\(var\(--safe-top, 0px\) \+ 2\.2vh\)/, "Settings and the Network monitor (one shell)");
  assert.match(css("views/gswin.css"), /padding-top: var\(--safe-top, 0px\);/, "G Squad");
  assert.match(rule("views/minecraft.css", ".mcw-topbtns"), /var\(--safe-top, 0px\)/, "Minecraft");
  assert.match(rule("views/editmode.css", ".ed-corner"), /var\(--safe-top, 0px\)/, "Edit mode");
  assert.match(rule("views/taskmap.css", ".tm-tr"), /var\(--safe-top, 0px\)/, "the Tab list's own top row");
});

ok("1.74: the screens and top centre pop ups that missed it now start below the notch on the Mac", () => {
  assert.match(rule("views/purchases.css", ".pc-head"), /max\(var\(--sat, env\(safe-area-inset-top, 0px\)\), var\(--safe-top, 0px\)\)/, "Purchases");
  assert.match(rule("views/series.css", ".sm-bar"), /max\(var\(--sat, 0px\), var\(--safe-top, 0px\)\)/, "the series map (Map pill)");
  assert.match(rule("views/featureintro.css", ".fi-layer.plain .fi-card"), /top: calc\(max\(var\(--sat, env\(safe-area-inset-top, 0px\)\), var\(--safe-top, 0px\)\) \+ 10px\)/, "a feature intro with the island off");
  assert.match(rule("views/chkremind.css", "html:not(.gos) .chk-pop"), /top: calc\(14px \+ var\(--safe-top, 0px\)\)/, "the checklist reminder");
  assert.match(rule("views/remind.css", "html:not(.gos) .rm-testcard"), /top: calc\(14px \+ var\(--safe-top, 0px\)\)/, "the reminder test card and the posture pop up");
  // max(): on the phone --safe-top is --sat (gos/gos.css), so nothing is counted twice there.
  assert.match(css("gos/gos.css"), /--safe-top: var\(--sat\);/);
});

ok("no em or en dashes in the changed styles", () => {
  const re = new RegExp("[\\u2013\\u2014]");
  for (const f of ["clients/clientsbtn.css", "views/purchases.css", "views/series.css", "views/featureintro.css", "views/chkremind.css", "views/remind.css"]) assert.doesNotMatch(css(f), re, f);
});

console.log(`\nnotch clear: ${n} passed`);
