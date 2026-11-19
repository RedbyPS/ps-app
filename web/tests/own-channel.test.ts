// Run: node --experimental-strip-types tests/own-channel.test.ts
// V1.69 (the developer, 18 Nov 2026, after the G Squad's V1.68 reached his Mac): a private tree's own update channel
// (scripts/own-channel.mjs). Its Mac build carries the channel alone (Resources/channel.json, read by ps-mac
// UpdateRoute.resolve), its releases go only there, and a layer profile whose channel cannot be used stops the build.
// FICTIONAL addresses (example.invalid) except the check of the developer's real layer profile; nothing goes online.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
ok("no long dashes in the new files", () => {
  for (const f of ["scripts/own-channel.mjs", "tests/own-channel.test.ts"]) assert.ok(!/[\u2013\u2014]/.test(readFileSync(join(here, f), "utf8")), f);
});

console.log(`\n${n} passed`);
