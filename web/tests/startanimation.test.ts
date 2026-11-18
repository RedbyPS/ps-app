// Run: node --experimental-strip-types tests/startanimation.test.ts
// PS 1.67 Hatch: the start animation's switch (the developer, 18 Nov 2026: "a visible switch in Settings to turn it off, public build
// too, on by default"). The scene itself is native (ps-mac Hatch.swift, ui/hatch.html, tests/hatch-test.sh); the page only
// shows the switch and sends {type:"psSettings:launchScene", on} (ps-mac main.swift), and reads psSettings.launchScene.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const X = await import("../src/core/settingsindex.ts");

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const src = (p: string) => readFileSync(p, "utf8");

ok("the switch is in the Settings index, on the Mac, in the Dynamic Island tab", () => {
  const e = X.SETTINGS.find((x) => x.id === "start-animation");
  assert.ok(e);
  assert.equal(e!.group, "island");
  assert.deepEqual(e!.on, ["mac"]);
  assert.ok(e!.words?.includes("off") && e!.words?.includes("start"));
});
ok("not hidden from anyone (no owner flag): the public build has it too", () => {
  const e = X.SETTINGS.find((x) => x.id === "start-animation") as Record<string, unknown>;
  assert.equal(e.red, undefined);
});
ok("the Settings row sends the switch and reads it, on unless switched off", () => {
  const g = src("src/views/SettingsGroups.tsx");
  assert.match(g, /"start-animation": function StartAnimation[\s\S]*?st\?\.launchScene !== false[\s\S]*?psPost\(\{ type: "psSettings:launchScene", on \}\)/);
});
ok("the Mac settings page has the same switch", () => {
  const p = src("src/views/PsSettings.tsx");
  assert.match(p, /<StartAnimationSection \/>/);
  assert.match(p, /st\.launchScene !== false : true/);
  assert.match(p, /type: "psSettings:launchScene", on: e\.target\.checked/);
});
ok("the setting is typed", () => { assert.match(src("src/ps.ts"), /launchScene\?: boolean;/); });
ok("no dashes in the new words", () => {
  for (const f of ["src/views/PsSettings.tsx", "src/core/settingsindex.ts", "src/views/SettingsGroups.tsx"]) assert.ok(!/[–—]/.test(src(f)), f);
});
console.log(`\n${n} passed`);
