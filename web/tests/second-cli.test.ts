// Run: node --experimental-strip-types tests/second-cli.test.ts
// scripts/second.ts against a fake PS (a temp folder standing in for ~/Library/Application Support/PS/Second/cli)
// and throwaway git projects: falling back when PS is away or the M1 is offline, bundles that a bare mirror can
// fetch (full, then incremental, uncommitted work included), secret files stopping the send, exit codes.
// Nothing here touches PS, the vault, the network or the developer's real projects.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let n = 0;
const ok = async (name: string, fn: () => unknown) => { await fn(); n++; console.log("ok -", name); };
const root = mkdtempSync(join(tmpdir(), "ps-second-cli-"));
const DIR = join(root, "cli"), PROJ = join(root, "Projects"), MIRROR = join(root, "mirror.git");
mkdirSync(DIR, { recursive: true }); mkdirSync(PROJ, { recursive: true });
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const repo = join(PROJ, "demo");
mkdirSync(repo);
git(repo, "init", "-q"); git(repo, "config", "user.email", "t@example.invalid"); git(repo, "config", "user.name", "T");
writeFileSync(join(repo, "a.txt"), "one\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "one");
git(root, "init", "-q", "--bare", MIRROR);

const cli = (args: string[]) => new Promise<{ code: number; out: string }>((resolve) => {
  const p = spawn(process.execPath, ["--experimental-strip-types", "scripts/second.ts", ...args],
    { env: { ...process.env, PS_SECOND_DIR: DIR, PS_SECOND_PROJECTS: PROJ }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
  p.on("close", (code) => resolve({ code: code ?? -1, out }));
});
const state = (o: object) => writeFileSync(join(DIR, "state.json"), JSON.stringify({ ps: true, unlocked: true, role: "primary", at: Date.now(), ...o }));
const m1 = (online: boolean, have: Record<string, string> = {}) => ({ secondary: { device: "m1", name: "Fake M1", online, lastSeen: Date.now(), have } });

/** A fake PS: answers each request like the real one would, and fetches the bundle into the mirror like the M1. */
function fakePs(final: "done" | "failed", seen: object[]) {
  const t = setInterval(() => {
    for (const f of readdirSync(DIR)) {
      if (!/^req-.*\.json$/.test(f)) continue;
      const req = JSON.parse(readFileSync(join(DIR, f), "utf8"));
      rmSync(join(DIR, f));
      seen.push(req);
      for (const b of req.bundles) {
        git(root, "-C", MIRROR, "bundle", "verify", b.path);
        const ref = git(root, "bundle", "list-heads", b.path).split(/\s+/)[1];
        git(root, "-C", MIRROR, "fetch", "-q", b.path, `+${ref}:refs/heads/${b.project}-in`);
      }
      const res = (o: object) => { writeFileSync(join(DIR, `res-${req.id}.json.tmp`), JSON.stringify({ id: req.id, job: "job-1", at: Date.now(), ...o })); renameSync(join(DIR, `res-${req.id}.json.tmp`), join(DIR, `res-${req.id}.json`)); };
      res({ state: "sent" });
      setTimeout(() => res({ state: "running", status: { state: "running", step: "npm test", tail: "" } }), 200);
      setTimeout(() => res({ state: final, status: { state: final, exit: final === "done" ? 0 : 1, tail: "12 passed\n", summary: "12 passed" } }), 500);
    }
  }, 100);
  return () => clearInterval(t);
}

await ok("PS not running: exit 3 and run it locally", async () => {
  const r = await cli(["test", "demo", "--no-fallback"]);
  assert.equal(r.code, 3); assert.match(r.out, /PS is not running/);
});
await ok("PS locked, nothing paired, or the M1 offline: exit 3 with the reason", async () => {
  state({ unlocked: false, ...m1(true) }); assert.match((await cli(["test", "demo", "--no-fallback"])).out, /PS is locked/);
  state({ secondary: null }); assert.match((await cli(["test", "demo", "--no-fallback"])).out, /no second Mac is paired/);
  state(m1(false)); const r = await cli(["test", "demo", "--no-fallback"]);
  assert.equal(r.code, 3); assert.match(r.out, /Fake M1 is offline/);
});
await ok("an old state file (PS quit) counts as not running", async () => {
  writeFileSync(join(DIR, "state.json"), JSON.stringify({ ps: true, unlocked: true, role: "primary", at: Date.now() - 5 * 60_000, ...m1(true) }));
  assert.match((await cli(["test", "demo", "--no-fallback"])).out, /PS is not running/);
});
await ok("the fallback runs the tests here when the M1 cannot", async () => {
  state(m1(false));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('local tests ran')\"" } }));
  const r = await cli(["test", "demo"]);
  assert.equal(r.code, 0); assert.match(r.out, /running it here instead/); assert.match(r.out, /local tests ran/);
  rmSync(join(repo, "package.json"));
});
await ok("online: a full bundle the mirror can fetch, the job sent, the result printed, exit 0", async () => {
  state(m1(true)); const seen: { bundles: { head: string; base?: string }[]; type: string; args: object }[] = [];
  const stop = fakePs("done", seen);
  const r = await cli(["test", "demo"]); stop();
  assert.equal(r.code, 0, r.out); assert.match(r.out, /full copy/); assert.match(r.out, /12 passed/);
  assert.equal(seen[0].type, "tests"); assert.deepEqual(seen[0].args, { preset: "auto" });
  assert.equal(seen[0].bundles[0].head, git(repo, "rev-parse", "HEAD"));
  assert.equal(git(root, "-C", MIRROR, "rev-parse", "demo-in"), git(repo, "rev-parse", "HEAD"));
  assert.equal(readdirSync(DIR).filter((f) => f.endsWith(".bundle")).length, 0, "bundles cleaned up");
});
await ok("next time only what changed travels, and uncommitted work comes along without touching the tree", async () => {
  const had = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "a.txt"), "two\n"); git(repo, "commit", "-qam", "two");
  writeFileSync(join(repo, "a.txt"), "three, not committed\n");
  state(m1(true, { demo: had })); const seen: { bundles: { head: string; base?: string }[] }[] = [];
  const stop = fakePs("done", seen);
  const r = await cli(["test", "demo"]); stop();
  assert.equal(r.code, 0, r.out); assert.match(r.out, /changes since what it has/); assert.match(r.out, /uncommitted changes included/);
  assert.equal(seen[0].bundles[0].base, had);
  const head = seen[0].bundles[0].head;
  assert.notEqual(head, git(repo, "rev-parse", "HEAD"), "a stash commit, not HEAD");
  assert.equal(git(root, "-C", MIRROR, "show", `${head}:a.txt`), "three, not committed");
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "three, not committed\n", "working tree untouched");
  assert.equal(git(repo, "stash", "list"), "", "no stash entry left behind");
  assert.equal(git(repo, "for-each-ref", "refs/ps-second"), "", "no temporary ref left behind");
  git(repo, "checkout", "-q", "a.txt");
});
await ok("it already has this exact commit: a tiny bundle of the last commit still works", async () => {
  state(m1(true, { demo: git(repo, "rev-parse", "HEAD") })); const seen: { bundles: { base?: string }[] }[] = [];
  const stop = fakePs("done", seen);
  const r = await cli(["test", "demo"]); stop();
  assert.equal(r.code, 0, r.out); assert.equal(seen[0].bundles[0].base, git(repo, "rev-parse", "HEAD^"));
});
await ok("a failed job exits 1", async () => {
  state(m1(true)); const stop = fakePs("failed", []);
  const r = await cli(["test", "demo"]); stop();
  assert.equal(r.code, 1); assert.match(r.out, /failed/);
});
await ok("PS never answers: exit 3 after 30 s and the request is taken back", async () => {
  state(m1(true));
  const r = await cli(["test", "demo", "--no-fallback"]);
  assert.equal(r.code, 3); assert.match(r.out, /did not pick it up/);
  assert.equal(readdirSync(DIR).filter((f) => f.startsWith("req-")).length, 0);
});
await ok("a tracked secret looking file stops the send", async () => {
  writeFileSync(join(repo, ".env"), "X=1\n"); git(repo, "add", "-f", ".env"); git(repo, "commit", "-qm", "oops");
  state(m1(true));
  const r = await cli(["test", "demo"]);
  assert.equal(r.code, 1); assert.match(r.out, /secret looking files tracked: \.env/);
  assert.equal(readdirSync(DIR).filter((f) => f.startsWith("req-")).length, 0, "nothing was sent");
});
await ok("bad usage exits 2", async () => {
  assert.equal((await cli(["frob"])).code, 2);
  assert.equal((await cli(["test", "demo", "--preset", "bash"])).code, 2);
  assert.equal((await cli(["claude", "demo"])).code, 2);
  assert.equal((await cli(["selftest", "--only", "dnd;rm"])).code, 2);
});

rmSync(root, { recursive: true, force: true });
console.log(`\n${n} passed`);
