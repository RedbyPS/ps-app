// Run: node --experimental-strip-types tests/profile.test.ts
// V1.58 multiple developers (profiles-158): one small settings file per build (core-root/profiles/gsquad.json for the
// G Squad build, ps-layer/profile.json for the developer's). Checks the reader (src/core/profile.ts), the G Squad file, the rule
// join with protected-158's per account answer (fails closed) and that a build without a file keeps V1.57's answers.
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
  assert.deepEqual(r.features, { "client-emails": true, whatsapp: false, receipts: true, "second-computer": true, "auto-approve-defaults": false, "audio-priority": false }, "V1.62: WhatsApp now defaults on in core; his build keeps it off as 1.61 left it. PS 1.65: Receipts named on, as the developer asked; Second Computer on for the developer");
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
ok("rule join fails closed: on only when the profile AND the per account answer allow it", () => {
  const g = P.cleanProfile(gsquadRaw), r = P.cleanProfile(red);
  for (const rule of P.RULES) {
    assert.equal(P.joinRule(rule, true, g), true, "G Squad build, a friend's account");
    assert.equal(P.joinRule(rule, false, g), false, "G Squad build on the developer's account stays off");
    assert.equal(P.joinRule(rule, true, r), false, "The developer's build stays off whoever is signed in");
    assert.equal(P.joinRule(rule, false, r), false);
  }
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
