// Run: node --experimental-strip-types tests/islandsettingswindow.test.ts
// V1.58 the island's settings, built once (views/IslandSettings.tsx): the landscape window (the developer, 13 Nov 2026: "make it
// pop up in a bigger settings menu, like a landscape settings menu with everything much neater, instead of the long
// portrait looking thing") and the Dynamic Island tab in Settings ("this tab must hold the island settings THEMSELVES").
// Source checks: sections on the left, every row the old menu had is still there and saves the same way, Esc and a click
// outside close it, it animates in and out (none with reduce motion), the Settings tab and the older Mac page draw the
// same component, and nothing in it is for the developer's account only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const src = (p: string) => readFileSync(p, "utf8");
const tm = src("src/views/TaskMap.tsx"), css = src("src/views/islandsettings.css"), fn = src("src/views/IslandSettings.tsx");
const X = await import("../src/core/settingsindex.ts");

ok("Look and Position everywhere, Mac controls in the island window", () => {
  for (const [id, name] of [["look", "Look"], ["position", "Position"], ["fullscreen", "Full screen"], ["notify", "Notifications"]]) {
    assert.match(fn, new RegExp(`\\{ id: "${id}", name: "${name}", line: "[^"]+", mac: (true|false) \\}`), name);
  }
  assert.match(fn, /const sections = islSections\(PS, feature\(PROGRESS_FEATURE\)\)/);
  assert.match(fn, /if \(id === "progress"\)[\s\S]*<ProgressSwitch[\s\S]*<ProgressBody/);
});
ok("every row the old menu had is still in it, saved the same way", () => {
  for (const r of [/ISLAND_MODES\.map/, /<LookEditButton kind=\{m\.id\} onEdit=\{setEdit\} \/>/, /<IslandLookEditor key=\{edit\}/, /\{PS && <IslandTickSideRow /,
    /save\(\{ idle: prefs\.idle === "next" \? "none" : "next" \}\)/, /\{PS && <IslandPosRow \/>\}/, /<IslandHideRow value=\{prefs\.hide\}[^\n]*save\(\{ hide \}\)/,
    /\{PS && <IslandFullScreenRow /, /\{PS && <IslandCardsRows prefs=\{prefs\}/]) assert.match(fn, r, String(r));
  assert.match(tm, /<IslandSettingsWindow prefs=\{islandPrefs\(st\.island\)\} save=\{\(p\) => void taskMapActions\.looks\(\{ island: \{ \.\.\.islandPrefs\(st\.island\), \.\.\.p \} \}\)\} \/>/);
});
ok("a wide window in the middle, sections on the left", () => {
  assert.match(fn, /role="dialog" aria-modal="true"/);
  assert.match(fn, /<nav className="isw-side"/);
  assert.match(css, /\.isw \{[^}]*grid-template-columns: 228px minmax\(0, 1fr\);[^}]*width: min\(840px, 100%\)/);
  assert.match(css, /\.isw-back \{[^}]*place-items: center/);
});
ok("Esc steps out of a look's editor first, then closes; a click outside closes", () => {
  assert.match(fn, /e\.key === "Escape"\) \{ e\.stopPropagation\(\); e\.preventDefault\(\); if \(editing\.current\) setEdit\(null\); else closeRef\.current\(\); \}/);
  assert.match(fn, /onPointerDown=\{\(e\) => \{ if \(e\.target === e\.currentTarget\) close\(\); \}\}/);
  assert.match(fn, /aria-label="Close the island settings"/);
});
ok("smooth in and out, none with reduce motion", () => {
  assert.match(css, /@keyframes iswIn/);
  assert.match(css, /@keyframes iswOut/);
  assert.match(css, /prefers-reduced-motion: reduce\)[^@]*\.isw-back, \.isw, \.isw-pane, \.isw-back\.out, \.isw\.out \{ animation: none; \}/);
  assert.match(fn, /prefers-reduced-motion: reduce/);
});
ok("Settings has a Dynamic Island tab holding the same settings, not a door to somewhere else", () => {
  const g = X.groupById("island");
  assert.ok(g && g.label === "Dynamic Island" && g.on?.includes("mac"));
  const e = X.settingById("island")!;
  assert.equal(e.group, "island");
  assert.equal(e.go, undefined);
  const groups = src("src/views/SettingsGroups.tsx");
  assert.match(groups, /"island": function Island\(\{ e \}\) \{\n\s*const prefs = islandPrefs\(settingsData\(useVault\(\)\)\.island\);\n\s*return <SetRow e=\{e\} plain open body=\{<IslandSettingsPage prefs=\{prefs\} save=/);
  assert.match(src("src/views/PsSettings.tsx"), /<IslandSettingsPage prefs=\{prefs\}/);
  // The page and the window draw the same rows (one function), so they cannot drift.
  assert.match(fn, /export function IslandSettingsPage[\s\S]*<IslandSectionRows id=\{x\.id\}/);
  assert.match(fn, /export function IslandSettingsWindow[\s\S]*<IslandSectionRows id=\{shown\}/);
});
ok("Settings in the island's right click menu opens the window (ps-mac calls window.__psOpenIslandSettings)", () => {
  assert.match(fn, /g\.__psOpenIslandSettings = \(\) => \{ openIslandSettings\(\); return true; \};/);
});
ok("while the island is away, both places say until when and bring it back now", () => {
  assert.match(fn, /psPost\(\{ type: "island:show" \}\)/);
  assert.match(fn, /export function IslandSettingsPage[\s\S]*<IslandAwayRow \/>/);
  assert.match(fn, /<div className="isw-pane isl-rows"[^>]*>\n\s*<IslandAwayRow \/>/);
});
ok("public build: no account gate anywhere in the window", () => {
  assert.ok(fn.length > 0 && !/isRedAccount|isOwner|RED_ONLY/.test(fn));
});
ok("no em or en dashes in the new words", () => {
  assert.ok(!/[–—]/.test(fn) && !/[–—]/.test(css));
});
console.log(`${n} ok`);
