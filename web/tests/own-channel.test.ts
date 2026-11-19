// Run: node --experimental-strip-types tests/own-channel.test.ts
// V1.69 (the developer, 18 Nov 2026, after the G Squad's V1.68 reached his Mac): a private tree's own update channel
// (scripts/own-channel.mjs). Its Mac build carries the channel alone (Resources/channel.json, read by ps-mac
// UpdateRoute.resolve), its releases go only there, and a layer profile whose channel cannot be used stops the build.
// FICTIONAL addresses (example.invalid) except the check of the developer's real layer profile; nothing goes online.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const O = await import("../scripts/own-channel.mjs");

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const here = join(import.meta.dirname, "..");
const prof = (channel: unknown, name = "red") => ({ schema: 1, name, display: "X", channel, othersShared: "on", features: {}, rules: {} });
const good = { kind: "url", url: "https://example.invalid/client/ps/own-0123456789abcdef/" };

ok("an own channel: its name, address and website folder", () => {
  assert.deepEqual(O.ownChannel(prof(good)), { name: "red", url: good.url, folder: "/client/ps/own-0123456789abcdef/" });
});
ok("anything that would leave the build on the G Squad channel is refused", () => {
  for (const [p, why] of [
    [prof({ kind: "gsquad" }), "G Squad channel"], [prof({ kind: "local" }), "no channel"], [prof({ kind: "url", url: "" }), "empty address"],
    [prof({ kind: "url", url: "http://example.invalid/client/ps/own-0123456789abcdef/" }), "not https"],
    [prof({ kind: "url", url: "https://example.invalid/client/ps/own-0123456789abcdef" }), "no ending /"],
    [prof({ kind: "url", url: "https://example.invalid/client/ps/" }), "the public folder itself"],
    [prof({ kind: "url", url: "https://example.invalid/client/ps/updates/" }), "a short name"],
    [prof({ kind: "url", url: "https://example.invalid/elsewhere/own-0123456789abcdef/" }), "not under /client/ps/"],
    [prof({ kind: "url", url: "https://example.invalid/client/ps/own-0123456789abcdef/?x=1" }), "a query"],
    [prof({ kind: "url", url: "https://example.invalid/client/ps/../own-0123456789abcdef/" }), "not plain"],
    [prof(good, "gsquad"), "named gsquad"], [prof(good, "Owner"), "a bad name"], [null, "not an object"],
  ] as const) assert.throws(() => O.ownChannel(p), undefined, why);
});
ok("the app's channel.json is the channel alone, in the profile's shape (no rules, no features)", () => {
  const f = JSON.parse(O.appFile(O.ownChannel(prof(good))));
  assert.deepEqual(f, { name: "red", channel: { kind: "url", url: good.url } });
});
ok("CLI: url and name are empty without a layer profile; a bad one stops with exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "own-ch-"));
  const run = (...a: string[]) => spawnSync("node", [join(here, "scripts/own-channel.mjs"), ...a], { encoding: "utf8" });
  try {
    assert.equal(run("url", join(dir, "none.json")).stdout, "");
    writeFileSync(join(dir, "bad.json"), JSON.stringify(prof({ kind: "url", url: "" })));
    const bad = run("url", join(dir, "bad.json"));
    assert.equal(bad.status, 1); assert.match(bad.stderr, /own-channel: /);
    const appBad = run("app-file", join(dir, "bad.json"), join(dir, "channel.json"));
    assert.equal(appBad.status, 1); assert.ok(!existsSync(join(dir, "channel.json")));
    writeFileSync(join(dir, "good.json"), JSON.stringify(prof(good)));
    assert.equal(run("url", join(dir, "good.json")).stdout, good.url);
    assert.equal(run("name", join(dir, "good.json")).stdout, "red");
    // an app with that channel.json follows it; an app without one (V1.68 and older) follows none
    mkdirSync(join(dir, "PS.app/Contents/Resources"), { recursive: true });
    assert.equal(run("installed", join(dir, "PS.app")).stdout, "");
    assert.equal(run("app-file", join(dir, "good.json"), join(dir, "PS.app/Contents/Resources/channel.json")).status, 0);
    assert.equal(run("installed", join(dir, "PS.app")).stdout, good.url);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
ok("the version of a signed note, for the 'already live' check", () => {
  const note = (p: unknown) => JSON.stringify({ key: "ps-update-1", sig: "x", signed: Buffer.from(JSON.stringify(p)).toString("base64") });
  assert.equal(O.noteVersion(note({ name: "V1.69", channel: "red" })), "1.69");
  assert.equal(O.noteVersion(note({ name: "nonsense" })), "");
  assert.equal(O.noteVersion("<html>404</html>"), "");
  assert.equal(O.noteVersion(""), "");
});
ok("The developer's layer profile names a usable own channel (else his Mac would follow the G Squad channel)", () => {
  if (!existsSync(join(here, "ps-layer/profile.json"))) return;
  const c = O.ownChannelOf(join(here, "ps-layer/profile.json"));
  assert.ok(c && c.name === "red" && c.url.startsWith("https://cincee.com/client/ps/own-"), JSON.stringify(c));
});
ok("the own channel's folder is never exported and never on GitHub", () => {
  const os = readFileSync(join(here, "scripts/open-source.mjs"), "utf8");
  assert.match(os, /\^web\\\/ps-layer\\\//, "open-source.mjs drops ps-layer/");
  const gi = readFileSync(join(here, ".gitignore"), "utf8").split("\n");
  assert.ok(gi.includes("ps-own-release"), "ps-own-release/ is gitignored");
  const pb = readFileSync(join(here, "scripts/postbuild.mjs"), "utf8");
  assert.match(pb, /ownChannelOf\(\)/); assert.match(pb, /ps-own-release/);
  const gh = readFileSync(join(here, "scripts/github-channel.mjs"), "utf8");
  assert.ok(!/ps-own-release/.test(gh), "the GitHub channel never reads the own channel's folder");
});
ok("V1.69 hotfix: a missing file under /client/ps/ is a real 404, never the page fallback (checked before it)", () => {
  const pb = readFileSync(join(here, "scripts/postbuild.mjs"), "utf8");
  const rules = (/writeFileSync\("dist\/_redirects", `([\s\S]*?)`\)/.exec(pb) || [])[1] || "";
  const lines = rules.split("\n").map((l) => l.trim().split(/\s+/)).filter((l) => l.length === 3);
  const ps = lines.findIndex((l) => l[0] === "/client/ps/*"), spa = lines.findIndex((l) => l[0] === "/client/*");
  assert.ok(ps >= 0 && spa >= 0 && ps < spa, rules);
  assert.deepEqual(lines[ps], ["/client/ps/*", "/client/ps/404.html", "404"]);
  assert.ok(!lines[ps][2].endsWith("!"), "never forced: real channel files are served as they are");
  assert.match(pb, /writeFileSync\("dist\/client\/ps\/404\.html"/);
});
ok("V1.69 hotfix: the Google Drive copy is signed for the release's own channel, not labelled G Squad", () => {
  const rel = readFileSync(join(here, "scripts/release.sh"), "utf8");
  const drive = rel.split("\n").filter((l) => /step drive /.test(l));
  assert.equal(drive.length, 2);
  for (const l of drive) assert.match(l, /PS_UPDATE_CHANNEL="\$\{OWN_NAME:-gsquad\}" PS_FLAVOUR="\$OWN_NAME" bash \.\.\/ps-mac\/release\/publish\.sh/);
});
// ---- V1.71: the phone asks the same folder (its APK carries the layer profile) ----
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const CERT = "65".repeat(32);
// A fictional APK: a zip with assets/profile.json (the layer profile the build put in), or none (`inside` null).
function fakeApk(file: string, inside: unknown = prof(good)) {
  const tmp = mkdtempSync(join(tmpdir(), "own-apk-"));
  try {
    mkdirSync(join(tmp, "assets"));
    writeFileSync(join(tmp, "assets/other.txt"), "fictional apk " + file);
    if (inside !== null) writeFileSync(join(tmp, "assets/profile.json"), JSON.stringify(inside, null, 2) + "\n");
    rmSync(file, { force: true });
    const z = spawnSync("zip", ["-q", "-X", "-r", file, "assets"], { cwd: tmp });
    assert.equal(z.status, 0, "zip is needed for these tests");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  return readFileSync(file);
}
function stagePhone(dir: string, over: Record<string, unknown> = {}, apkName = "ps-gos-1.71.apk", inside: unknown = prof(good)) {
  mkdirSync(dir, { recursive: true });
  const apk = fakeApk(join(dir, apkName), inside);
  const note = { versionCode: 76, versionName: "V1.71", keyword: "Test", apk: apkName, sha256: sha(apk), size: apk.length, cert: CERT, notes: "", released: "2026-11-19T00:00:00.000Z", channel: "red", by: "red", shared: true, ...over };
  writeFileSync(join(dir, "version.json"), JSON.stringify(note, null, 1));
  return note;
}
ok("V1.71 phone: a staged phone build made for this channel may go there (note and APK beside the Mac's files)", () => {
  const dir = mkdtempSync(join(tmpdir(), "own-phone-"));
  try {
    stagePhone(dir);
    assert.deepEqual(O.phoneNote(dir, O.ownChannel(prof(good)), "V1.71"), { note: join(dir, "version.json"), apk: "ps-gos-1.71.apk" });
    assert.equal(O.PHONE_NOTE, "gos-version.json");   // what the phone asks for (ps-gos build.gradle.kts updateNote)
    assert.ok(O.PHONE_APK.test("ps-gos-1.71-b77.apk") && !O.PHONE_APK.test("../ps-gos-1.71.apk") && !O.PHONE_APK.test("ps-gos.apk"));
    assert.equal(O.phoneNote(join(dir, "nothing-here"), O.ownChannel(prof(good))), null);   // nothing staged
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
ok("V1.71 phone: anything that would leave the phone without the release, or give it the wrong file, is refused", () => {
  const c = O.ownChannel(prof(good));
  for (const [over, why, re] of [
    [{ channel: "gsquad" }, "made for the G Squad channel (an APK without the layer profile)", /gsquad channel, not red's own/],
    [{ channel: undefined }, "a note for no channel", /G Squad channel/],
    [{ channel: "jan" }, "another person's channel", /jan channel/],
    [{ versionName: "V1.70" }, "an older build still staged", /is V1\.70, not V1\.71/],
    [{ sha256: "0".repeat(64) }, "a sha256 that does not match", /sha256/],
    [{ size: 1 }, "a size that does not match", /size/],
    [{ cert: "" }, "no certificate", /certificate/],
    [{ apk: "../ps-gos-1.71.apk" }, "a strange APK name", /strange APK/],
    [{ apk: "ps-gos-1.72.apk" }, "an APK that is not there", /not in/],
  ] as const) {
    const dir = mkdtempSync(join(tmpdir(), "own-phone-"));
    try { stagePhone(dir, over as Record<string, unknown>); assert.throws(() => O.phoneNote(dir, c, "V1.71"), re, why); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  // The label is right but the APK itself would still ask the G Squad channel (an older ps-gos release.sh labels the
  // note from PS_UPDATE_CHANNEL but builds without the profile), or another person's folder.
  for (const [inside, why] of [[null, "no profile in the APK"], [prof({ kind: "gsquad" }, "gsquad"), "the G Squad profile"],
    [prof({ kind: "url", url: "https://example.invalid/client/ps/own-fedcba9876543210/" }), "another folder"], [prof(good, "jan"), "another name"]] as const) {
    const dir = mkdtempSync(join(tmpdir(), "own-phone-"));
    try { stagePhone(dir, {}, "ps-gos-1.71.apk", inside); assert.throws(() => O.phoneNote(dir, c, "V1.71"), /does not carry red's layer profile/, why); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const dir = mkdtempSync(join(tmpdir(), "own-phone-"));
  try { stagePhone(dir); assert.deepEqual(O.apkProfile(join(dir, "ps-gos-1.71.apk")), prof(good)); assert.equal(O.apkProfile(join(dir, "version.json")), null); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
ok("V1.71 phone CLI: release.sh's check passes for this channel and stops (exit 1) for a G Squad build", () => {
  const dir = mkdtempSync(join(tmpdir(), "own-phone-"));
  const run = (...a: string[]) => spawnSync("node", [join(here, "scripts/own-channel.mjs"), ...a], { encoding: "utf8" });
  try {
    writeFileSync(join(dir, "profile.json"), JSON.stringify(prof(good)));
    stagePhone(join(dir, "gos-release"));
    const yes = run("phone", join(dir, "gos-release"), "V1.71", join(dir, "profile.json"));
    assert.equal(yes.status, 0, yes.stderr); assert.match(yes.stdout, /made for red's own channel/);
    const later = run("phone", join(dir, "gos-release"), "V1.72", join(dir, "profile.json"));
    assert.equal(later.status, 1); assert.match(later.stderr, /own-channel: the staged phone build is V1\.71, not V1\.72/);
    stagePhone(join(dir, "gos-release"), { channel: "gsquad" });
    const no = run("phone", join(dir, "gos-release"), "V1.71", join(dir, "profile.json"));
    assert.equal(no.status, 1); assert.match(no.stderr, /own-channel: /);
    const none = run("phone", join(dir, "empty"), "V1.71", join(dir, "profile.json"));
    assert.equal(none.status, 1); assert.match(none.stderr, /no phone build is staged/);
    const noProfile = run("phone", join(dir, "gos-release"), "V1.71", join(dir, "none.json"));
    assert.equal(noProfile.status, 1); assert.match(noProfile.stderr, /no layer profile/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
ok("V1.71 phone: postbuild puts the phone's note and APK in the own folder, and still fills /client/gos/", () => {
  const dir = mkdtempSync(join(tmpdir(), "own-post-"));
  const post = (cwd: string) => spawnSync("node", [join(here, "scripts/postbuild.mjs")], { cwd, encoding: "utf8" });
  try {
    mkdirSync(join(dir, "dist"), { recursive: true }); mkdirSync(join(dir, "ps-layer"));
    writeFileSync(join(dir, "ps-layer/profile.json"), JSON.stringify(prof(good)));
    const note = stagePhone(join(dir, "gos-release"));
    const r = post(dir);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const own = join(dir, "dist/client/ps/own-0123456789abcdef");
    assert.deepEqual(JSON.parse(readFileSync(join(own, "gos-version.json"), "utf8")), note);
    assert.equal(sha(readFileSync(join(own, "ps-gos-1.71.apk"))), note.sha256);
    assert.ok(existsSync(join(dir, "dist/client/gos/version.json")) && existsSync(join(dir, "dist/client/gos/ps-gos-1.71.apk")), "/client/gos/ as before");
    // A build for the G Squad channel (no layer profile in its APK) never lands in the own folder; the site still builds.
    rmSync(join(dir, "dist"), { recursive: true, force: true }); mkdirSync(join(dir, "dist"));
    stagePhone(join(dir, "gos-release"), { channel: "gsquad" });
    const g = post(dir);
    assert.equal(g.status, 0, g.stderr + g.stdout);
    assert.match(g.stdout, /not copied to red's own channel/);
    assert.ok(!existsSync(join(own, "gos-version.json")) && !existsSync(join(own, "ps-gos-1.71.apk")));
    assert.ok(existsSync(join(dir, "dist/client/gos/version.json")));
    // No layer profile (core, a friend's tree): no own folder at all.
    rmSync(join(dir, "dist"), { recursive: true, force: true }); mkdirSync(join(dir, "dist")); rmSync(join(dir, "ps-layer"), { recursive: true });
    stagePhone(join(dir, "gos-release"));
    assert.equal(post(dir).status, 0);
    assert.ok(!existsSync(join(dir, "dist/client/ps/own-0123456789abcdef")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
ok("V1.71 phone: the release builds the phone for the own channel and stops before publishing a build that is not", () => {
  const rel = readFileSync(join(here, "scripts/release.sh"), "utf8");
  assert.match(rel, /gos_build\(\) \{ PS_UPDATE_CHANNEL="\$\{OWN_NAME:-gsquad\}" bash \.\.\/ps-gos\/scripts\/release\.sh /);
  const check = rel.indexOf('run node scripts/own-channel.mjs phone gos-release "$GOSV"');
  assert.ok(check > 0, "the phone check is there");
  assert.ok(check > rel.lastIndexOf("step phone gos_build") && check > rel.indexOf("par phone gos_build"), "after every phone build");
  assert.ok(check < rel.indexOf("step stage ") && check < rel.indexOf("step deploy "), "before anything is staged or deployed");
  assert.match(rel.slice(check, check + 400), /exit 1/);
  // In a dry run (a tree with a layer profile only): printed after the builds, before the channel is staged.
  if (!existsSync(join(here, "ps-layer/profile.json"))) return;
  const times = mkdtempSync(join(tmpdir(), "own-ch-times-"));
  for (const args of [["--app", "--wait", "--dry-run"], ["--app", "--wait", "--fast", "--dry-run"]]) {
    const r = spawnSync("bash", ["scripts/release.sh", ...args], { cwd: here, encoding: "utf8", env: { ...process.env, PS_RELEASE_TIMES: join(times, "times.tsv"), PS_DRY_LIVE_VERSION: "0.0", PS_DRY_GOS: "1", PS_DRY_INSTALLED: "/", PS_DRY_MEMORY: "ok" } });
    const out = (r.stdout || "") + (r.stderr || "");
    assert.equal(r.status, 0, out);
    const at = out.search(/DRY {2}node scripts\/own-channel\.mjs phone gos-release V[0-9.]+\n/);
    assert.ok(at > 0, out);
    assert.ok(at > out.search(/\[phone\]/) && at > out.search(/DRY {2}\[mac\]|\[mac\] DRY/) && at < out.indexOf("DRY  [stage]"), out);
  }
  rmSync(times, { recursive: true, force: true });
});
ok("V1.71 phone: Jan's watcher keeps the phone's files when it swaps the own folder (it builds no phone)", () => {
  assert.match(jp, /const PHONE_FILE = \/\^\(gos-version\\\.json\|ps-gos-/);
  assert.ok(!/from "\.\/own-channel\.mjs"/.test(jp), "the watcher runs alone, so it imports nothing of the repo");
});

ok("no long dashes in the new files", () => {
  for (const f of ["scripts/own-channel.mjs", "tests/own-channel.test.ts"]) assert.ok(!/[\u2013\u2014]/.test(readFileSync(join(here, f), "utf8")), f);
});

console.log(`\n${n} passed`);
