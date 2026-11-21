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
// ---------- PS 1.69: Replay the update animation (Settings, About and updates) ----------
ok("the replay row is in About and updates, on the Mac only", () => {
  const e = X.SETTINGS.find((x) => x.id === "replay-update");
  assert.ok(e);
  assert.equal(e!.group, "about");
  assert.deepEqual(e!.on, ["mac"]);
  assert.equal(e!.name, "Replay the update animation");
  assert.ok(e!.words?.includes("replay") && e!.words?.includes("animation"));
});
ok("not hidden from anyone (no owner flag): the public build has the replay too", () => {
  const e = X.SETTINGS.find((x) => x.id === "replay-update") as Record<string, unknown>;
  assert.equal(e.red, undefined);
  assert.equal(e.private, undefined);
});
ok("search finds it by the words people use", () => {
  const ctx = { red: false, where: "mac", pf: true, ck: true } as const;
  for (const q of ["replay", "update animation", "play again", "hatch"]) assert.ok(X.searchSettings(q, ctx as never).slice(0, 3).some((h: { e: { id: string } }) => h.e.id === "replay-update"), q);
  const web = { red: false, where: "web", pf: true, ck: true } as const;
  assert.ok(!X.searchSettings("replay the update animation", web as never).some((h: { e: { id: string } }) => h.e.id === "replay-update"));
});
ok("the row is a button that asks the Mac to replay: no restart, no download, no What's new from the page", () => {
  const g = src("src/views/SettingsGroups.tsx");
  assert.match(g, /"replay-update": function ReplayUpdate[\s\S]*?psPost\(\{ type: "psSettings:replayHatch" \}\)/);
  assert.ok(!/replayHatch[\s\S]{0,200}(macUpdate|updater)/i.test(g.slice(g.indexOf('"replay-update"'), g.indexOf('"replay-update"') + 600)));
});
// ---------- PS Cake: the boot animation takes the switch; Replay the logo reveal (Settings, About and updates) ----------
ok("the switch's line says what the Cake boot animation does", () => {
  const e = X.SETTINGS.find((x) => x.id === "start-animation");
  assert.equal(e!.line, "Each time the app opens, one of three Cake scenes plays and builds the island. Esc skips it.");
  assert.match(src("src/views/PsSettings.tsx"), /One of three Cake scenes plays and builds the Dynamic Island\. It takes about six seconds; Esc or a click skips it\./);
});
ok("the logo reveal replay sits right under the update animation replay, Mac only", () => {
  const i = X.SETTINGS.findIndex((x) => x.id === "replay-update");
  const e = X.SETTINGS[i + 1];
  assert.equal(e.id, "replay-reveal");
  assert.equal(e.group, "about");
  assert.deepEqual(e.on, ["mac"]);
  assert.equal(e.name, "Replay the logo reveal");
  assert.equal(e.line, "Plays the logo reveal again: the old PS icon turns into the new one. Esc skips it.");
});
ok("not hidden from anyone: the public build has the logo reveal replay too", () => {
  const e = X.SETTINGS.find((x) => x.id === "replay-reveal") as Record<string, unknown>;
  assert.equal(e.red, undefined);
  assert.equal(e.private, undefined);
});
ok("search finds the logo reveal by the words people use, and not on the website", () => {
  const ctx = { red: false, where: "mac", pf: true, ck: true } as const;
  for (const q of ["logo reveal", "new icon", "replay logo", "knight"]) assert.ok(X.searchSettings(q, ctx as never).slice(0, 3).some((h: { e: { id: string } }) => h.e.id === "replay-reveal"), q);
  const web = { red: false, where: "web", pf: true, ck: true } as const;
  assert.ok(!X.searchSettings("replay the logo reveal", web as never).some((h: { e: { id: string } }) => h.e.id === "replay-reveal"));
});
ok("the row is a button that asks the Mac to replay the reveal, nothing else", () => {
  const g = src("src/views/SettingsGroups.tsx");
  assert.match(g, /"replay-reveal": function ReplayReveal[\s\S]*?psPost\(\{ type: "psSettings:replayReveal" \}\)/);
});
console.log(`\n${n} passed`);
