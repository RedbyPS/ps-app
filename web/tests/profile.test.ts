// Run: node --experimental-strip-types tests/profile.test.ts
// V1.58 multiple developers (profiles-158): one small settings file per build (core-root/profiles/gsquad.json for the
// G Squad build, ps-layer/profile.json for the developer's). Checks the reader (src/core/profile.ts), the G Squad file, the rules
// per BUILD (PS 1.71: the profile decides when it says, G Squad on and the developer's own build off for every account) and that
// a build without a file keeps V1.57's per account answers.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const file = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const has = (p: string) => existsSync(new URL(`../${p}`, import.meta.url));

const P = await import("../src/core/profile.ts");
const gsquadRaw = JSON.parse(file("core-root/profiles/gsquad.json"));
const red = { schema: 1, name: "red", display: "Owner", channel: { kind: "url", url: "https://example.com/ps-update.json" }, othersShared: "off", features: {}, rules: { tabOverProtectedApps: false, islandOverProtectedApps: false } };

ok("the G Squad profile reads fully", () => {
  const g = P.cleanProfile(gsquadRaw);
  assert.ok(g);
  assert.deepEqual(g, { schema: 1, name: "gsquad", display: "the G Squad", channel: { kind: "gsquad" }, othersShared: "on", features: {}, rules: { tabOverProtectedApps: true, islandOverProtectedApps: true } });
});
ok("G Squad: Tab overlay and island over 1Password and Signal are ON", () => {
  assert.equal(gsquadRaw.rules.tabOverProtectedApps, true);
  assert.equal(gsquadRaw.rules.islandOverProtectedApps, true);
});
ok("The developer's profile (when the flip's ps-layer/profile.json is here): both rules OFF, others' shared features ON (V1.61)", () => {
  if (!has("ps-layer/profile.json")) return;
  const r = JSON.parse(file("ps-layer/profile.json"));
  assert.equal(r.name, "red");
  assert.equal(r.othersShared, "on");
  assert.deepEqual(r.features, { "client-emails": true, whatsapp: false, receipts: true, "second-computer": true, "remote-screen": true, "auto-approve-defaults": false, "audio-priority": false }, "V1.62: WhatsApp now defaults on in core; his build keeps it off as 1.61 left it. PS 1.65: Receipts named on, as the developer asked; Second Computer on for the developer. PS 1.70: Remote screen on for the developer");
  assert.equal(r.rules.tabOverProtectedApps, false);
  assert.equal(r.rules.islandOverProtectedApps, false);
});
ok("a wrong file never half applies", () => {
  for (const bad of [null, 1, "x", [], {}, { ...red, schema: 2 }, { ...red, name: "Red" }, { ...red, name: "1red" }, { ...red, othersShared: "yes" },
    { ...red, channel: { kind: "url", url: "http://x" } }, { ...red, channel: { kind: "url", url: "" } }, { ...red, channel: { kind: "ftp" } }, { ...red, channel: undefined }]) {
    assert.equal(P.cleanProfile(bad), null, JSON.stringify(bad));
  }
});
ok("only known rules, real true or false, and feature ids are kept", () => {
  const p = P.cleanProfile({ ...red, features: { "good-id": true, "Bad": true, "x--y": false, "n": 1 }, rules: { tabOverProtectedApps: "false", islandOverProtectedApps: false, other: true } })!;
  assert.deepEqual(p.features, { "good-id": true });
  assert.deepEqual(p.rules, { islandOverProtectedApps: false });
  assert.equal(P.profileRule("tabOverProtectedApps", p), null);
});
ok("display falls back to the name and is cut at 60", () => {
  assert.equal(P.cleanProfile({ ...red, display: "  " })!.display, "red");
  assert.equal(P.cleanProfile({ ...red, display: "x".repeat(99) })!.display.length, 60);
});
ok("a build without a file: profile() is null (never a gsquad default) and every rule is the per account answer", () => {
  P.setBuildForTests(null);
  assert.equal(P.profile(), null);
  assert.equal(P.profileName(), null);
  for (const r of P.RULES) for (const a of [true, false]) assert.equal(P.joinRule(r, a), a);
  P.setBuildForTests({});
  assert.equal(P.profile(), null);
  P.setBuildForTests(undefined);
});
ok("this test run has no __PS_BUILD__ (like the dev server): no profile", () => {
  assert.equal(P.buildFile(), null);
  assert.equal(P.profile(), null);
});
ok("profile() reads the build file's profile", () => {
  P.setBuildForTests({ profile: gsquadRaw });
  assert.equal(P.profileName(), "gsquad");
  P.setBuildForTests({ profile: red });
  assert.equal(P.profileName(), "red");
  P.setBuildForTests(undefined);
});
ok("PS 1.71: the rules are per BUILD, the 2x2 (G Squad on for every account, the developer's own build off for every account)", () => {
  // The developer, 13 Nov 2026, again 19 Nov ("it's just turned off again"): two rules per build, never one shared switch. The per
  // account answer is false on the developer's account and true on a friend's (and on nobody signed in yet).
  const g = P.cleanProfile(gsquadRaw), r = P.cleanProfile(red);
  const own = has("ps-layer/profile.json") ? P.cleanProfile(JSON.parse(file("ps-layer/profile.json"))) : r;
  for (const rule of P.RULES) {
    assert.equal(P.joinRule(rule, true, g), true, "G Squad build, a friend's account: on");
    assert.equal(P.joinRule(rule, false, g), true, "G Squad build, the developer's account: on (the 19 Nov bug: it was off)");
    assert.equal(P.joinRule(rule, true, r), false, "The developer's build, a friend's account: off");
    assert.equal(P.joinRule(rule, false, r), false, "The developer's build, the developer's account: off");
    assert.equal(P.joinRule(rule, true, own), false, "The developer's real layer profile, any account: off");
    assert.equal(P.joinRule(rule, false, own), false);
  }
});
ok("PS 1.71: a profile that does not say keeps the per account answer", () => {
  const quiet = P.cleanProfile({ ...red, rules: {} });
  for (const rule of P.RULES) for (const a of [true, false]) assert.equal(P.joinRule(rule, a, quiet), a);
  const half = P.cleanProfile({ ...red, rules: { tabOverProtectedApps: true } });
  assert.equal(P.joinRule("tabOverProtectedApps", false, half), true);
  assert.equal(P.joinRule("islandOverProtectedApps", false, half), false, "island not said: the developer's account answer");
  assert.equal(P.joinRule("islandOverProtectedApps", true, half), true);
});
ok("PS 1.71: the Mac does the same (Profile.allows lets the build decide) when its source is next to this tree", () => {
  const mac = process.env.PS_MAC_PROFILE_SWIFT ?? `${process.env.HOME}/Projects/ps-mac/Sources/Profile.swift`;
  if (!existsSync(mac)) return;
  const src = readFileSync(mac, "utf8");
  if (!src.includes("layerRules")) return;   // a Mac tree from before 1.71
  assert.ok(!src.includes("v && account"), "the old AND join is gone on the Mac");
  assert.ok(src.includes("if let v = profile?.rule(rule) { return v }"), "the profile decides on the Mac");
});
ok("the rule names match the Mac (Profile.swift) and the phone (Profile.kt)", () => {
  const mac = `${process.env.HOME}/Projects/.worktrees/profiles-158/Sources/Profile.swift`;
  if (existsSync(mac)) for (const r of P.RULES) assert.ok(readFileSync(mac, "utf8").includes(`"${r}"`), r);
  assert.deepEqual([...P.RULES], ["tabOverProtectedApps", "islandOverProtectedApps"]);
});
ok("no em or en dashes in the new files", () => {
  for (const p of ["src/core/profile.ts", "core-root/profiles/gsquad.json", "tests/profile.test.ts"]) assert.ok(![...file(p)].some((c) => c === String.fromCharCode(8211) || c === String.fromCharCode(8212)), p);
});
console.log(`${n} ok`);
