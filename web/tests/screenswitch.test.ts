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
ok("screenPrefsMsg: defaults (Sharp, no numbers, §, not from anywhere) and only known values pass", () => {
  assert.deepEqual(S.screenPrefsMsg({}), { picture: "sharp", numbers: false, hold: "section", anywhere: false, relayUrl: "" });
  assert.deepEqual(S.screenPrefsMsg({ screenPicture: "faster", screenNumbers: true, screenHoldKey: "f13" }), { picture: "faster", numbers: true, hold: "f13", anywhere: false, relayUrl: "" });
  assert.deepEqual(S.screenPrefsMsg({ screenPicture: "ultra", screenNumbers: "yes", screenHoldKey: "tab", screenAnywhere: "yes" }), { picture: "sharp", numbers: false, hold: "section", anywhere: false, relayUrl: "" });
  assert.equal(S.screenPrefsMsg({ screenHoldKey: "off" }).hold, "off");
});
ok("every choice has its words", () => {
  for (const p of S.SCREEN_PICTURES) assert.ok(S.SCREEN_WORDS.pictures[p]);
  for (const h of S.SCREEN_HOLDS) assert.ok(S.SCREEN_WORDS.holds[h]);
  assert.equal(S.SCREEN_WORDS.holds.section, "§");
});
ok("PS 1.77 From anywhere: the switch and the relay's address go to the Mac; the key never does", () => {
  const m = S.screenPrefsMsg({ screenAnywhere: true, screenRelayUrl: " https://ps-relay.example.workers.dev/ " });
  assert.equal(m.anywhere, true); assert.equal(m.relayUrl, "https://ps-relay.example.workers.dev");
  for (const bad of ["http://ps-relay.example.workers.dev", "https://u:p@example.com", "https://example.com/?k=1", "https://example.com/#x", "ftp://x", "", 7, "https://" + "a".repeat(200)]) assert.equal(S.relayUrlClean(bad), "", String(bad));
  assert.equal(S.relayUrlClean("https://relay.example.com/ps"), "https://relay.example.com/ps");
  assert.ok(!("relayKey" in m) && !Object.keys(m).some((k) => /key/i.test(k)), "no key in the prefs message");
  assert.ok(S.relayKeyOK("k".repeat(32)) && !S.relayKeyOK("k".repeat(31)) && !S.relayKeyOK("k".repeat(40) + " x") && !S.relayKeyOK("k".repeat(257)));
});
ok("PS 1.77 words: no em or en dashes, every From anywhere word there", () => {
  for (const [k, w] of Object.entries(S.SCREEN_WORDS)) if (typeof w === "string") assert.ok(!/[\u2013\u2014]/.test(w), k);
  for (const k of ["anywhere", "anywhereLine", "relayUrl", "relayUrlLine", "relayKey", "relayKeyLine", "relayKeySaved", "relayKeyMissing", "relayKeyBad"]) assert.ok((S.SCREEN_WORDS as Record<string, unknown>)[k], k);
});
console.log(`\n${n} passed`);
