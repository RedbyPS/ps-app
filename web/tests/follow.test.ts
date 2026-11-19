// Run: node --experimental-strip-types tests/follow.test.ts
// PS 1.71 (three releases never blended): a developer's own copy of every new version (core tools/follow.mjs), and
// the build tool's stop for an own build without a channel of its own (core tools/assemble.mjs channelProblem). The
// pure parts, then `check` and a dry run on FICTIONAL repos in a temp folder. Nothing goes online, nothing is built,
// signed or installed, launchctl is never called.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

Object.assign(process.env, { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
const tmp = mkdtempSync(join(tmpdir(), "ps-follow-test-"));
const HOME = join(tmp, "home"), STATE = join(tmp, "state");
Object.assign(process.env, { PS_FOLLOW_HOME: HOME, PS_FOLLOW_STATE: STATE, PS_FOLLOW_LOG: join(tmp, "follow.log") });
const F = await import("../core-root/tools/follow.mjs");
const A = await import("../core-root/tools/assemble.mjs");
const tool = join(import.meta.dirname, "../core-root/tools/follow.mjs");

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const put = (dir: string, files: Record<string, string>) => { for (const [f, t] of Object.entries(files)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), t); } };
const note = (payload: object) => JSON.stringify({ key: "ps-update-1", signed: Buffer.from(JSON.stringify(payload)).toString("base64"), sig: "x" });
const claim = (dir: string, v: string, by: string, kind: string, ref = "HEAD") => git(dir, "tag", "-a", `v${v}`, ref, "-m", JSON.stringify({ by, kind, at: "2026-11-20T00:00:00.000Z", name: `Name ${v}` }));
const folderPath = "~/Library/Application Support/PS Own Channel/";
const profile = { schema: 1, name: "jan", channel: { kind: "folder", path: folderPath, key: "k", certRoot: "b".repeat(40) } };

try {
  ok("versions, claim tags and the shared versions on core main", () => {
    assert.equal(F.cmp("1.72", "1.71"), 1); assert.equal(F.cmp("1.100", "1.99"), 1);
    assert.deepEqual(F.tagInfo('{"by":"jan","kind":"shared","name":"Glow"}'), { by: "jan", kind: "shared", name: "Glow" });
    assert.equal(F.tagInfo("a plain tag"), null); assert.equal(F.tagInfo('{"by":"Jan Smith","kind":"shared"}'), null);
    const tags = { "1.71": { by: "red", kind: "shared", onMain: true }, "1.72": { by: "jan", kind: "shared", onMain: true },
      "1.73": { by: "jan", kind: "private", onMain: true }, "1.74": { by: "red", kind: "shared", onMain: false } };
    assert.deepEqual(F.shared(tags), ["1.72", "1.71"], "a private claim and a tag off main are never followed");
  });
  ok("when to make a copy", () => {
    const tags = { "1.72": { by: "red", kind: "shared", onMain: true } };
    assert.deepEqual(F.decide({ tags, own: "1.71" }), { act: "make", version: "1.72", by: "red" });
    assert.equal(F.decide({ tags, own: "" }).act, "make", "an empty folder gets the newest");
    assert.equal(F.decide({ tags, own: "1.72" }).act, "none");
    assert.match(F.decide({ tags, own: "1.71", history: { "1.72": { state: "failed", step: "build" } } }).why, /run it again by hand/, "never tried again by itself");
    assert.equal(F.decide({ tags, own: "1.71", history: { "1.72": { state: "running" } } }).act, "wait");
    assert.equal(F.decide({ tags: {}, own: "1.71" }).act, "none");
  });
  ok("the note: version, channel and the files it names", () => {
    const i = F.noteInfo(note({ name: "V1.72", channel: "jan", by: "red", app: { file: "updates/PS-app-9.zip" }, web: { file: "updates/PS-web-9.zip" } }));
    assert.deepEqual(i, { version: "1.72", by: "red", channel: "jan", files: ["updates/PS-app-9.zip", "updates/PS-web-9.zip"] });
    assert.deepEqual(F.noteInfo(note({ name: "V1.72", web: { file: "../../etc/x" } })).files, [], "a file outside updates/ is never named");
    assert.equal(F.noteInfo("junk").version, "");
  });
  ok("your folder channel: only in your own Library/Application Support", () => {
    assert.deepEqual(F.folderOf(profile, "/Users/you"), { name: "jan", dir: "/Users/you/Library/Application Support/PS Own Channel/", certRoot: "b".repeat(40) });
    for (const path of ["/tmp/ps/", "~/Documents/ps/", "~/Library/Application Support/", "~/Library/Application Support/ps", "~/Library/Application Support/../x/"])
      assert.throws(() => F.folderOf({ ...profile, channel: { kind: "folder", path } }, "/Users/you"), /folder/, path);
    assert.throws(() => F.folderOf({ ...profile, channel: { kind: "local" } }), /no folder channel/);
    assert.throws(() => F.folderOf({ ...profile, name: "gsquad" }), /no name of your own/);
  });
  ok("the LaunchAgent: every 15 minutes, this file's copy, the watch command", () => {
    const p = F.plistText("/usr/local/bin/node", "/x/follow.mjs", "/Users/you");
    assert.match(p, /<string>com\.cincee\.ps\.follow<\/string>/); assert.match(p, /<integer>900<\/integer>/); assert.match(p, /<string>watch<\/string>/);
  });
  ok("the build tool stops an own Mac or phone build that would follow the G Squad channel", () => {
    assert.equal(A.channelProblem(profile), null);
    assert.equal(A.channelProblem({ name: "mia", channel: { kind: "local" } }), null);
    assert.equal(A.channelProblem({ name: "mia", channel: { kind: "url", url: "https://example.invalid/ps/" } }), null);
    assert.match(A.channelProblem({ name: "mia", channel: { kind: "gsquad" } }), /gsquad/);
    assert.match(A.channelProblem({ name: "mia" }), /no update channel/);
    assert.match(A.channelProblem({ name: "mia", channel: { kind: "url", url: "http://example.invalid/ps/" } }), /https/);
    assert.match(A.channelProblem({ name: "mia", channel: { kind: "folder", path: "/tmp/ps/" } }), /Application Support/);
    const b = readFileSync(join(import.meta.dirname, "../core-root/tools/build.mjs"), "utf8");
    assert.match(b, /if \(opt\.layerPath && !check && \(part === "all" \|\| part === "mac" \|\| part === "phone"\)\)/);
    assert.equal(A.channelProblem(JSON.parse(readFileSync(join(import.meta.dirname, "../core-root/layers/example/profile.json"), "utf8"))), null, "the example layer (CI) builds");
  });
  ok("it never pushes, claims, publishes or writes anywhere but your folder and its own", () => {
    const s = readFileSync(tool, "utf8");
    assert.doesNotMatch(s, /"push"|claim-version|gh release|netlify|api\.github\.com/);
    assert.doesNotMatch(s, /[–—]/);
  });

  // ---------- check and a dry run on fictional repos ----------
  const origin = join(tmp, "origin"), core = join(tmp, "core"), layerDir = join(tmp, "ps-jan-layer");
  mkdirSync(origin); git(origin, "init", "--quiet", "--initial-branch=main");
  put(origin, { "tools/build.mjs": "// stub\n", "web/ps-version.json": '{"version":"1.71"}\n' });
  git(origin, "add", "-A"); git(origin, "commit", "--quiet", "-m", "1.71"); claim(origin, "1.71", "red", "shared");
  put(origin, { "web/ps-version.json": '{"version":"1.72"}\n' });
  git(origin, "add", "-A"); git(origin, "commit", "--quiet", "-m", "1.72"); claim(origin, "1.72", "red", "shared");
  git(origin, "checkout", "--quiet", "-b", "side"); put(origin, { "x.txt": "x\n" }); git(origin, "add", "-A"); git(origin, "commit", "--quiet", "-m", "side");
  claim(origin, "1.73", "jan", "shared"); git(origin, "checkout", "--quiet", "main");
  git(tmp, "clone", "--quiet", origin, core);
  put(layerDir, { "layer.json": '{"schema":1,"name":"jan"}\n', "profile.json": JSON.stringify(profile) });
  const folder = join(HOME, "Library/Application Support/PS Own Channel");
  put(folder, { "ps-update.json": note({ name: "V1.71", channel: "jan" }) });
  put(STATE, { "config.json": JSON.stringify({ layer: join(layerDir, "layer.json"), key: join(tmp, "nokey") }) });
  const cli = (...a: string[]) => spawnSync(process.execPath, [tool, ...a], { encoding: "utf8", env: { ...process.env, PS_FOLLOW_CORE: core } });

  ok("check: the newest shared version on core main, against your folder (a tag off main is not followed)", () => {
    const r = cli("check");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /core's newest shared version: V1\.72; your folder: V1\.71/);
    assert.match(r.stdout, /would make your own copy of V1\.72 \(made by red\)/);
  });
  ok("a dry run says every step and stops before anything when the key is missing", () => {
    let r = cli("run", "--version", "1.72", "--dry-run");
    assert.match(r.stdout, /a real run would STOP at look: your update key file is not there/);
    put(tmp, { key: "fictional\n" });
    put(STATE, { "config.json": JSON.stringify({ layer: join(layerDir, "layer.json"), key: join(tmp, "key") }) });
    r = cli("run", "--version", "1.72", "--dry-run");
    assert.equal(r.status, 0, r.stderr);
    for (const s of ["copy", "build", "sign", "stage", "folder"]) assert.match(r.stdout, new RegExp(`DRY  \\[${s}\\]`), s);
    assert.match(r.stdout, /Dry run finished\. Nothing was built, signed, staged or put in your folder\./);
    assert.match(readFileSync(join(folder, "ps-update.json"), "utf8"), /signed/, "the folder is as it was");
    assert.match(cli("run", "--version", "1.73", "--dry-run").stdout, /not a shared version claimed on core main/);
    assert.match(cli("run", "--version", "1.71", "--dry-run").stdout, /already has V1\.71/);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${n} passed`);
