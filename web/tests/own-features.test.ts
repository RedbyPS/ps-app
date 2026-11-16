// Run: node --experimental-strip-types tests/own-features.test.ts
// V1.61: the developer's own build has his friends' features. The developer's layer profile (ps-layer/profile.json) says othersShared "on"
// and switches Client emails on. A build made from his private tree carries only those two values (vite.config.ts
// `own`), and the page uses them ONLY on the developer's own account (core/features.ts whoFor). V1.62: every other signed in account
// gets Jan's shared features at their defaults (on), Client emails and WhatsApp included (tests/public-on.test.ts); the developer's
// own build stays as 1.61 left it (WhatsApp off through his profile). A person's own switch still wins over the profile.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const file = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const json = (p: string) => JSON.parse(file(p));

const F = await import("../src/core/features.ts");
const P = await import("../src/core/profile.ts");
const M = await import("../src/core/mailswitch.ts");

const core = json("core-root/features.json");
const layerProfile = json("ps-layer/profile.json");
const jans = F.cleanRegistry(core).filter((f) => f.owner === "jan");
const jansOn = jans.filter((f) => f.default === "on").map((f) => f.id);
// What vite.config.ts psBuild() bundles for a build from the private tree: no profile, core's list, and `own`.
const own = { othersShared: layerProfile.othersShared, features: layerProfile.features };
const redBuild = { profile: null, features: core, own };
const publicBuild = { profile: null, features: core };   // core's tree has no ps-layer/, so no `own`

const answers = (account: "red" | "other" | null, mine?: Record<string, boolean>) => {
  F.setFeatureContext(account, mine);
  return F.featureAnswers(F.registry(), F.whoFor(P.profile(), account), mine);
};

ok("The developer's layer profile: others' shared features on, Client emails on, WhatsApp off as 1.61 left it, Screen recording at its default", () => {
  assert.equal(layerProfile.name, "red");
  assert.equal(layerProfile.othersShared, "on");
  assert.deepEqual(layerProfile.features, { "client-emails": true, whatsapp: false, "second-computer": true });   // PS 1.65: Second Computer stays on on the developer's account
  assert.equal(layerProfile.rules.tabOverProtectedApps, false, "the 1Password and Signal rules are untouched");
  assert.equal(layerProfile.rules.islandOverProtectedApps, false);
});

ok("Jan's 1.60 features are all in core's registry (14 of them)", () => {
  assert.deepEqual(jans.map((f) => f.id).sort(), ["client-emails", "feature-intros", "fitness-island", "gsquad-island-reply", "gsquad-newlook", "gsquad-notify", "gym-scan-better",
    "island-moments", "remind-push", "remind-ring", "screen-recording", "welcome-back", "whatsapp", "workout-summary"]);
});

ok("The developer's build, the developer's account: every one of Jan's default on features is on, and Client emails", () => {
  P.setBuildForTests(redBuild);
  const a = answers("red");
  for (const id of jansOn) if (id !== "whatsapp") assert.equal(a[id], true, id);
  assert.equal(a["client-emails"], true);
  assert.equal(a.whatsapp, false, "WhatsApp needs his own Meta setup: off in his build, as 1.61 left it");
  assert.equal(a["screen-recording"], true, "Screen recording at its default; nothing records until he says yes in its own setup");
  assert.equal(a.campaigns, false, "core's features keep core's values");
  assert.equal(a["notebook-looks"], false);
  assert.equal(F.feature("island-moments"), true, "feature() agrees");
  P.setBuildForTests(undefined);
});

ok("The developer's build, anyone else's account (V1.62): every one of Jan's features on, Client emails on; the developer's profile never applies to them", () => {
  P.setBuildForTests(redBuild);
  const a = answers("other");
  for (const f of jans) assert.equal(a[f.id], true, f.id);
  assert.equal(a.whatsapp, true, "The developer's whatsapp: false is his own, never a friend's");
  assert.equal(M.mailSwitch(undefined, "other"), true);
  assert.equal(M.mailSwitch(undefined), true, "the default account is anyone else");
  assert.equal(F.feature("island-moments"), true);
  const before = answers(null);
  for (const f of jans) assert.equal(before[f.id], false, `${f.id} before anyone is signed in`);
  P.setBuildForTests(undefined);
});

ok("Client emails: on for the developer in his build, off for a stranger's build (no own), and the developer's own switch wins", () => {
  P.setBuildForTests(redBuild);
  assert.equal(M.mailSwitch(undefined, "red"), true);
  assert.equal(M.mailSwitch({}, "red"), true);
  assert.equal(M.mailSwitch({ "client-emails": false }, "red"), false, "his own Off wins");
  assert.equal(M.mailOn({ status: "unlocked", role: "owner", primary: true }, M.mailSwitch(undefined, "red")), true);
  assert.equal(M.mailOn({ status: "unlocked", role: "owner", primary: false }, M.mailSwitch(undefined, "red")), false, "still only the project's first owner");
  P.setBuildForTests(publicBuild);
  assert.equal(M.mailSwitch(undefined, "red"), false, "core's tree (no own) on the developer's account: others' features off");
  assert.equal(M.mailSwitch(undefined, "other"), true, "V1.62: on for a friend by default");
  assert.equal(M.mailSwitch({ "client-emails": false }, "other"), false, "a friend's own Off wins");
  P.setBuildForTests(undefined);
});

ok("a per account switch (Settings, From the squad) still wins over the developer's profile", () => {
  P.setBuildForTests(redBuild);
  const mine = { "island-moments": false, "welcome-back": false, "client-emails": false, whatsapp: true };
  const a = answers("red", mine);
  assert.equal(a["island-moments"], false);
  assert.equal(a["welcome-back"], false);
  assert.equal(a["client-emails"], false);
  assert.equal(a.whatsapp, true);
  assert.equal(a["workout-summary"], true, "the ones he did not touch keep the profile's answer");
  P.setBuildForTests(undefined);
});

ok("the public build and core: the developer's account keeps core's values (others' features off), as in tests/features.test.ts", () => {
  P.setBuildForTests(publicBuild);
  const a = answers("red");
  for (const f of jans) assert.equal(a[f.id], false, f.id);
  assert.deepEqual(F.whoFor(null, "red"), { name: "red", othersShared: "off", overrides: {} });
  P.setBuildForTests(undefined);
  assert.deepEqual(F.whoFor(null, "red"), { name: "red", othersShared: "off", overrides: {} }, "no build file at all");
});

ok("an assembled build with a real profile ignores `own` (the profile decides)", () => {
  const gsquad = P.cleanProfile(json("core-root/profiles/gsquad.json"))!;
  P.setBuildForTests({ profile: gsquad, features: core, own: { othersShared: "off", features: { "island-moments": false } } });
  assert.equal(P.ownDefaults(), null);
  assert.equal(answers("red")["island-moments"], true, "G Squad: others' shared features on");
  P.setBuildForTests(undefined);
});

ok("cleanOwn: a wrong value never half applies", () => {
  for (const bad of [null, 1, "x", [], {}, { othersShared: "yes" }, { othersShared: true }]) assert.equal(P.cleanOwn(bad), null, JSON.stringify(bad));
  assert.deepEqual(P.cleanOwn({ othersShared: "on", features: { "client-emails": true, Bad: true, "x-y": 1, "a--b": false } }), { othersShared: "on", features: { "client-emails": true } });
  assert.deepEqual(P.cleanOwn({ othersShared: "off" }), { othersShared: "off", features: {} });
  P.setBuildForTests({ profile: null, features: core, own: { othersShared: "maybe" } });
  assert.deepEqual(F.whoFor(null, "red"), { name: "red", othersShared: "off", overrides: {} }, "a bad `own`: core's values");
  P.setBuildForTests(undefined);
});

ok("vite.config.ts bundles `own` only from ps-layer/profile.json and only without an assembled ps-build.json", () => {
  const v = file("vite.config.ts");
  assert.match(v, /own: !b && existsSync\("ps-layer\/profile\.json"\) \? ownOf\(read\("ps-layer\/profile\.json"\)\) : null/);
  assert.match(v, /function ownOf\(p: Record<string, unknown> \| null\): PsBuild\["own"\] \{\n  return p \? \{ othersShared: p\.othersShared \?\? null, features: p\.features \?\? null \} : null;/,
    "only othersShared and features, never the rules, the channel or the name");
});

ok("every page starts the feature sync (the website, the phone, the Mac), and the phone's shell gets the answers", () => {
  assert.match(file("src/App.tsx"), /\nstartFeatureSync\(\);/);
  assert.match(file("src/gos/main.tsx"), /\nstartFeatureSync\(gosPost\);/);
  assert.match(file("src/ps.ts"), /startFeatureSync\(psPost\);/);
  assert.match(file("src/core/mailsnap.ts"), /accountKind\(s\) === "red" \? "red" : "other"/);
});

console.log(`${n} ok`);
