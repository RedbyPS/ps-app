// Run: node --experimental-strip-types tests/islandtaskonly.test.ts
// PS 1.74 (the developer, 22 Nov 2026: "I should ONLY be able to see the task at hand on the dynamic island"): the closed island
// shows only the task, everything else on hover (core/island.ts TASK_ONLY_FEATURE; the Mac draws it, ps-mac IslandCloseCore.swift).
// This checks the state the page sends, the feature entry, its Settings switch, its intro and the words. No vault, no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const I = await import("../src/core/island.ts");
const X = await import("../src/core/settingsindex.ts");
const F = await import("../src/core/featureintro.ts");

let n = 0;
const ok = (name: string, fn: () => void) => { n++; fn(); console.log("ok - " + name); };
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const base = { todos: [{ id: "x", data: { title: "Get back to the client", done: false } }] as never, today: "2026-11-22", mail: 2, leads: 1, event: null, now: Date.UTC(2026, 10, 22, 12) };

ok("the feature id", () => assert.equal(I.TASK_ONLY_FEATURE, "island-task-only"));
ok("the island says task only when told (and by default)", () => {
  assert.equal(I.islandState({ ...base, settings: { workingIds: ["x"] } as never }).taskOnly, true);
  assert.equal(I.islandState({ ...base, settings: { workingIds: ["x"] } as never, taskOnly: true }).taskOnly, true);
  assert.equal(I.islandState({ ...base, settings: { workingIds: ["x"] } as never, taskOnly: false }).taskOnly, false);
});
ok("it changes nothing else: the counts, the task and +1 still go to the Mac for the open island", () => {
  const a = I.islandState({ ...base, settings: { workingIds: ["x"] } as never, taskOnly: true });
  const b = I.islandState({ ...base, settings: { workingIds: ["x"] } as never, taskOnly: false });
  assert.deepEqual({ ...a, taskOnly: false }, b);
  assert.equal(a.mail, 2); assert.equal(a.leads, 1); assert.equal(a.task?.title, "Get back to the client");
});
ok("the island off still carries it (the Mac keeps its default)", () => {
  assert.equal(I.islandState({ ...base, settings: { island: { mode: "off" } } as never, taskOnly: false }).taskOnly, false);
});
ok("the page sends the feature's answer", () => {
  assert.match(read("../src/island.ts"), /islandState\(\{[^}]*taskOnly: feature\(TASK_ONLY_FEATURE\) \}\)/);
});
ok("features.json: shared, by jan, since 1.74, on by default, web and Mac", () => {
  const f = JSON.parse(read("../../features.json")).features.find((x: { id: string }) => x.id === "island-task-only");
  assert.ok(f);
  assert.equal(f.owner, "jan"); assert.equal(f.scope, "shared"); assert.equal(f.since, "1.74"); assert.equal(f.default, "on");
  assert.deepEqual(f.parts, ["web", "mac"]);
});
ok("FEATURES.md says what it does and where its switch is", () => {
  assert.match(read("../../FEATURES.md"), /\| Only the task on the closed island \|.*island-task-only.*Settings, Mac, Dynamic Island, "Only the task when closed"/);
});
ok("its switch in Settings, Dynamic Island (Mac), the same one as in From the squad", () => {
  const e = X.SETTINGS.find((x: { id: string }) => x.id === "island-task-only");
  assert.ok(e);
  assert.equal(e.group, "island");
  assert.equal(e.name, "Only the task when closed");
  assert.deepEqual(e.on, ["mac"]);
  const g = read("../src/views/SettingsGroups.tsx");
  assert.match(g, /"island-task-only": function IslandTaskOnlyRow/);
  assert.match(g, /on=\{feature\(TASK_ONLY_FEATURE\)\}/);
  assert.match(g, /save\(\{ squadFeatures: \{ \.\.\.mine, \[TASK_ONLY_FEATURE\]: on \} \}\)/);
});
ok("an island intro, once, only on a Mac with the feature on", () => {
  const d = F.INTROS.find((x: { id: string }) => x.id === "island-task-only-174");
  assert.ok(d);
  assert.equal(d.show, "Ok"); assert.equal(d.choice, true);
  assert.match(read("../src/views/FeatureIntro.tsx"), /"island-task-only-174": async \(_can, s\) => \(PS && feature\(TASK_ONLY_FEATURE\) && s\.status === "unlocked" && s\.role === "owner"/);
});
ok("no em or en dashes in its words", () => {
  const e = X.SETTINGS.find((x: { id: string }) => x.id === "island-task-only");
  const d = F.INTROS.find((x: { id: string }) => x.id === "island-task-only-174");
  assert.ok(!/[–—]/.test(JSON.stringify([e, d])));
});
console.log(`\n${n} passed`);
