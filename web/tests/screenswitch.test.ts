// Run: node --experimental-strip-types tests/screenswitch.test.ts
// The remote screen's switch and settings (PS 1.69, core/screenswitch.ts): its features.json entry (off by default like
// Second Computer, shared, web and Mac), what the Mac is told (Picture, Delay numbers, Hold key), and the words being one place.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const S = await import("../src/core/screenswitch.ts");
let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };

ok("features.json: remote-screen, core, shared, since 1.69, off by default, web and mac", () => {
  const reg = JSON.parse(readFileSync(new URL("../core-root/features.json", import.meta.url), "utf8")).features as { id: string; owner: string; scope: string; since: string; default: string; parts: string[] }[];
  const f = reg.find((x) => x.id === S.SCREEN_FEATURE);
  assert.ok(f);
  assert.deepEqual([f!.owner, f!.scope, f!.since, f!.default], ["core", "shared", "1.69", "off"]);
  assert.deepEqual(f!.parts, ["web", "mac"]);
  const second = reg.find((x) => x.id === "second-computer")!;
  assert.equal(f!.default, second.default, "the same default as Second Computer");
});
ok("the developer's layer has it on, like Second Computer", () => {
  const p = JSON.parse(readFileSync(new URL("../ps-layer/profile.json", import.meta.url), "utf8"));
  assert.equal(p.features["remote-screen"], true); assert.equal(p.features["second-computer"], true);
});
ok("screenPrefsMsg only sends picture, delay numbers and hold key", () => {
  assert.deepEqual(S.screenPrefsMsg({}), { picture: "sharp", numbers: false, hold: "section" });
  assert.deepEqual(S.screenPrefsMsg({ screenPicture: "faster", screenNumbers: true, screenHoldKey: "f13" }), { picture: "faster", numbers: true, hold: "f13" });
  assert.deepEqual(S.screenPrefsMsg({ screenPicture: "ultra", screenNumbers: "yes", screenHoldKey: "tab" }), { picture: "sharp", numbers: false, hold: "section" });
  const oldSettings = { screenAnywhere: false, screenRelayUrl: "https://old-relay.example", screenHoldKey: "off" };
  assert.deepEqual(S.screenPrefsMsg(oldSettings), { picture: "sharp", numbers: false, hold: "off" });
});
ok("every choice has its words", () => {
  for (const p of S.SCREEN_PICTURES) assert.ok(S.SCREEN_WORDS.pictures[p]);
  for (const h of S.SCREEN_HOLDS) assert.ok(S.SCREEN_WORDS.holds[h]);
  assert.equal(S.SCREEN_WORDS.holds.section, "§");
});
ok("automatic relay settings have no address or key inputs", () => {
  const ui = readFileSync(new URL("../src/views/SecondSwitch.tsx", import.meta.url), "utf8");
  assert.match(ui, /screen:connect/);
  assert.equal(S.SCREEN_WORDS.test, "Test connection");
  assert.doesNotMatch(ui, /relayKey|relayUrl|screenAnywhere/);
});
console.log(`
${n} passed`);
