// Run: node --experimental-strip-types tests/islandon.test.ts
// PS 1.67 (the developer, 18 Nov 2026): the Dynamic Island on for everyone. Once per account an island switched off goes back to
// "notch" with a marker, so a later Off in Settings stays off; once per phone the same for Island inside PS.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const I = await import("../src/core/islandon.ts");

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const src = (p: string) => readFileSync(p, "utf8");
const looks = { pill: { fill: "#000" }, notch: { fill: "#111" }, hide: 300, cards: false, top: ["mail"], idle: "none" };

ok("off becomes notch once, every other island choice kept", () => {
  const p = I.islandOnPatch({ island: { mode: "off", ...looks } } as never);
  assert.deepEqual(p, { island: { mode: "notch", ...looks }, islandOn167: true });
});
ok("a later Off stays off (the marker is there)", () => {
  assert.equal(I.islandOnPatch({ island: { mode: "off", idle: "next" }, islandOn167: true } as never), null);
});
ok("on stays as it was, only the marker is written", () => {
  assert.deepEqual(I.islandOnPatch({ island: { mode: "pill", ...looks } } as never), { islandOn167: true });
  assert.deepEqual(I.islandOnPatch({ island: { mode: "notch", idle: "next" } } as never), { islandOn167: true });
  assert.deepEqual(I.islandOnPatch({} as never), { islandOn167: true });
});
ok("settings not loaded yet: nothing", () => {
  assert.equal(I.islandOnPatch(null), null);
  assert.equal(I.islandOnPatch(undefined), null);
});

const mem = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
};
ok("phone: off is cleared once and the marker written", () => {
  const s = mem({ [I.PHONE_ISLAND_KEY]: "off", "ps.phone.addButton": "off" });
  assert.equal(I.phoneIslandOnce(s), true);
  assert.equal(s.getItem(I.PHONE_ISLAND_KEY), null);
  assert.equal(s.getItem(I.PHONE_MARK_KEY), "1");
  assert.equal(s.getItem("ps.phone.addButton"), "off");   // the other phone switch is untouched
});
ok("phone: a later Off stays off", () => {
  const s = mem({ [I.PHONE_ISLAND_KEY]: "off", [I.PHONE_MARK_KEY]: "1" });
  assert.equal(I.phoneIslandOnce(s), false);
  assert.equal(s.getItem(I.PHONE_ISLAND_KEY), "off");
});
ok("phone: on stays on, marker written", () => {
  const s = mem();
  assert.equal(I.phoneIslandOnce(s), false);
  assert.equal(s.getItem(I.PHONE_MARK_KEY), "1");
  assert.equal(s.m.size, 1);
});
ok("wired: the account step runs with the other once steps, the phone step on the first read", () => {
  assert.match(src("src/App.tsx"), /void migrateIslandOn\(\)/);
  assert.match(src("src/core/actions.ts"), /export async function migrateIslandOn\(\)[\s\S]*?islandOnPatch\(/);
  assert.match(src("src/gos/phoneprefs.ts"), /if \(k === "island"\) \{ try \{ phoneIslandOnce\(localStorage\)/);
  assert.match(src("src/core/model.ts"), /islandOn167\?: boolean/);
});
ok("the quick hides stay (grab line hide time, the default is still on)", async () => {
  const isl = await import("../src/core/island.ts");
  assert.equal(isl.ISLAND_DEFAULT.mode, "notch");
  assert.equal(isl.ISLAND_DEFAULT.hide, 60);
});
console.log(`\n${n} passed`);
