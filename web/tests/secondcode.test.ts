// Run: node --experimental-strip-types tests/secondcode.test.ts
// Second Computer code jobs (PS 1.65, src/core/secondcode.ts): off by default, the sealed body's checks (repo, base,
// minutes, tool, secrets), the window's rows for a code job (second/view.ts), the Copy for AI text, and
// scripts/second.ts code / result against a FAKE PS (a temp folder standing in for PS's command line folder) and a
// throwaway git project. Nothing touches PS, the vault, the network or a real project. FICTIONAL data only.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const C = await import("../src/core/secondcode.ts");
const { looksSecret } = await import("../src/core/second.ts");
const { EMPTY_LOCAL, secondView } = await import("../src/second/view.ts");

let n = 0;
const ok = async (name: string, fn: () => unknown) => { await fn(); n++; console.log("ok -", name); };
const SHA = "a".repeat(40);
const good = { repo: "demo", base: SHA, prompt: "Make the tests pass", tool: "claude" as const };

await ok("code jobs are off until switched on (true only)", () => {
  assert.equal(C.codeJobsOn(undefined), false);
  assert.equal(C.codeJobsOn({}), false);
  assert.equal(C.codeJobsOn({ secondCodeJobs: "yes" }), false);
  assert.equal(C.codeJobsOn({ secondCodeJobs: 1 }), false);
  assert.equal(C.codeJobsOn({ secondCodeJobs: true }), true);
});

await ok("the sealed body: kind code, the known keys only, defaults", () => {
  const { body } = C.codeBody(good, looksSecret);
  assert.deepEqual(body, { kind: "code", prompt: "Make the tests pass", repo: "demo", base: SHA, tool: "claude", minutes: 30 });
  const b2 = C.codeBody({ ...good, title: "Mail tests", model: "sonnet", minutes: 240, shots: true }, looksSecret).body!;
  assert.equal(b2.title, "Mail tests"); assert.equal(b2.model, "sonnet"); assert.equal(b2.minutes, 240); assert.equal(b2.shots, true);
  assert.deepEqual(Object.keys(b2).sort(), ["base", "kind", "minutes", "model", "prompt", "repo", "shots", "title", "tool"]);
});

await ok("refused: empty or huge instructions, bad repo or base, minutes out of range, model with Codex", () => {
  const why = (o: Partial<typeof good> & Record<string, unknown>) => C.codeBody({ ...good, ...o } as never, looksSecret).why;
  assert.match(why({ prompt: "  " })!, /what it should do/);
  assert.match(why({ prompt: "x".repeat(20_001) })!, /over 20000/);
  for (const r of ["https://u:p@example.com/a.git", "https://x@example.com/a.git", "file:///tmp/x", "ext::sh -c id", "/etc", "../x", "a b", "-oX", ".hidden", "http://example.com/a.git"]) assert.ok(why({ repo: r }), r);
  for (const r of ["demo", "my-app.v2", "https://example.com/team/app.git", "git@example.com:team/app.git", "ssh://git@example.com/team/app.git"]) assert.equal(why({ repo: r }), undefined, r);
  for (const b of ["--upload-pack=x", "a..b", "/x", "x/", "x.lock", ""]) assert.ok(why({ base: b }), b);
  assert.equal(why({ base: "feature/x-1" }), undefined);
  assert.ok(why({ minutes: 4 } as never)); assert.ok(why({ minutes: 241 } as never)); assert.ok(why({ minutes: 7.5 } as never));
  assert.match(why({ tool: "codex", model: "opus" } as never)!, /only picked for Claude Code/);
  assert.match(why({ title: "x".repeat(81) } as never)!, /80 characters/);
});

await ok("refused: a key or password anywhere in it", () => {
  assert.match(C.codeBody({ ...good, prompt: "use ghp_abcdefghijklmnopqrstuvwxyz0123456789 to push" }, looksSecret).why!, /Nothing secret/);
  assert.match(C.codeBody({ ...good, title: "password: hunter2hunter2" } as never, looksSecret).why!, /Nothing secret/);
});

await ok("the window's row for a code job (second/view.ts)", () => {
  const now = Date.parse("2026-11-17T10:00:00Z");
  const local = { ...EMPTY_LOCAL, ojobs: [
    { job: "00000000-0000-4000-8000-000000000001", title: "Mail tests", state: "done" as const, suite: "xwing", at: now - 60_000, mine: true, report: "# Mail tests", kind: "code",
      code: { tool: "codex", repo: "demo", commits: 2, files: ["a.txt | 2 +-"] }, bundle: "Downloads/From your other Mac/x/result.bundle", fetch: "git fetch '/x/result.bundle' outsource/a:review/a" },
    { job: "00000000-0000-4000-8000-000000000002", title: "Note apps", state: "running" as const, suite: "p256", at: now - 30_000, mine: true },
  ] };
  const v = secondView([], local, now);
  const code = v.jobs.find((j) => j.id.endsWith("1"))!, research = v.jobs.find((j) => j.id.endsWith("2"))!;
  assert.equal(code.sealed?.kind, "code"); assert.equal(code.sealed?.code?.commits, 2); assert.match(code.sealed?.fetch ?? "", /^git fetch /);
  assert.equal(research.sealed?.kind, undefined, "research keeps its own row");
  assert.equal(C.codeLine(code.sealed?.code), "Codex · demo · 2 commits");
  assert.equal(C.codeLine({ tool: "claude", repo: "demo", commits: 1 }), "Claude Code · demo · 1 commit");
});

await ok("Copy for AI: how to send, wait and fetch, and never to merge or push", () => {
  const g = C.aiGuide("Home Mac");
  assert.match(g, /node scripts\/second\.ts code <repo>/); assert.match(g, /wait <job>/); assert.match(g, /result <job>/);
  assert.match(g, /Never merge or push/); assert.match(g, /Home Mac/);
  assert.ok(!/[–—]/.test(g + JSON.stringify(C.CODE_WORDS)), "no long dashes in any word");
});

// ---------- scripts/second.ts code, against a fake PS ----------
const root = mkdtempSync(join(tmpdir(), "ps-secondcode-cli-"));
const DIR = join(root, "cli"), PROJ = join(root, "Projects");
mkdirSync(DIR, { recursive: true }); mkdirSync(PROJ, { recursive: true });
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const repo = join(PROJ, "demo");
mkdirSync(repo);
git(repo, "init", "-q"); git(repo, "config", "user.email", "t@example.invalid"); git(repo, "config", "user.name", "T");
writeFileSync(join(repo, "a.txt"), "one\n"); git(repo, "add", "."); git(repo, "commit", "-qm", "one");
const head = git(repo, "rev-parse", "HEAD");
const state = (o: object = {}) => writeFileSync(join(DIR, "state.json"), JSON.stringify({ ps: true, unlocked: true, role: "primary", at: Date.now(),
  secondary: { device: "m1", name: "Home Mac", online: true, lastSeen: Date.now(), outsource: true, suite: "p256" }, ...o }));
const cli = (args: string[], cwd = process.cwd()) => new Promise<{ code: number; out: string }>((resolve) => {
  const p = spawn(process.execPath, ["--experimental-strip-types", join(process.cwd(), "scripts/second.ts"), ...args],
    { cwd, env: { ...process.env, PS_SECOND_DIR: DIR, PS_SECOND_PROJECTS: PROJ }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
  p.on("close", (code) => resolve({ code: code ?? -1, out }));
});
/** The fake PS: takes each request, keeps it for the checks and answers "sent" (or "refused" when told to). */
const seen: Record<string, unknown>[] = [];
let answer: "sent" | "refused" | "none" = "sent";
const fakePs = setInterval(() => {
  for (const f of readdirSync(DIR)) {
    if (!/^req-.*\.json$/.test(f)) continue;
    const r = JSON.parse(readFileSync(join(DIR, f), "utf8")) as { id: string; type: string; args: Record<string, unknown> };
    if (answer === "none") continue;
    rmSync(join(DIR, f)); seen.push(r);
    const res = answer === "sent" ? { id: r.id, kind: "outsource", job: "00000000-0000-4000-8000-0000000000aa", title: String(r.args.title ?? "Make it"), state: "sent", suite: "p256", at: Date.now() }
      : { id: r.id, kind: "outsource", state: "refused", reason: "Code jobs are off on this Mac. Switch them on in Second Computer, Outsource.", at: Date.now() };
    writeFileSync(join(DIR, `res-${r.id}.json.tmp`), JSON.stringify(res)); renameSync(join(DIR, `res-${r.id}.json.tmp`), join(DIR, `res-${r.id}.json`));
  }
}, 100);

await ok("code: a folder in Projects goes by its name with its current commit as the base, sealed by PS as kind code", async () => {
  state();
  const r = await cli(["code", "demo", "Make the tests pass", "--tool", "codex", "--minutes", "60", "--shots"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /sent 00000000-0000-4000-8000-0000000000aa/);
  const req = seen.at(-1)!;
  assert.equal(req.type, "ocode");
  assert.deepEqual(req.args, { kind: "code", prompt: "Make the tests pass", repo: "demo", base: head, tool: "codex", minutes: 60, shots: true });
});

await ok("code: a git link needs --base; a path gives its folder name", async () => {
  const a = await cli(["code", "https://example.com/team/app.git", "Fix it"]);
  assert.equal(a.code, 2); assert.match(a.out, /--base/);
  const b = await cli(["code", "https://example.com/team/app.git", "Fix it", "--base", "main"]);
  assert.equal(b.code, 0, b.out);
  assert.equal((seen.at(-1)!.args as { repo: string }).repo, "https://example.com/team/app.git");
  const c = await cli(["code", repo, "Fix it"]);
  assert.equal(c.code, 0, c.out);
  assert.deepEqual([(seen.at(-1)!.args as { repo: string }).repo, (seen.at(-1)!.args as { base: string }).base], ["demo", head]);
});

await ok("code: refused before PS sees it (a secret, a link with a password, bad flags)", async () => {
  const before = seen.length;
  const s = await cli(["code", "demo", "use sk-abcdefghijklmnopqrstuvwxyz to call"]);
  assert.equal(s.code, 1); assert.match(s.out, /Nothing secret/);
  const p = await cli(["code", "https://u:p@example.com/a.git", "x", "--base", "main"]);
  assert.notEqual(p.code, 0);
  assert.equal((await cli(["code", "demo", "x", "--tool", "bash"])).code, 2);
  assert.equal((await cli(["code", "demo", "x", "--minutes", "999"])).code, 1);
  assert.equal((await cli(["code"])).code, 2);
  assert.equal(seen.length, before, "nothing reached PS");
});

await ok("code: the other Mac's no (Code jobs off there) comes back in plain words, exit 1", async () => {
  answer = "refused";
  const r = await cli(["code", "demo", "Make it"]);
  answer = "sent";
  assert.equal(r.code, 1); assert.match(r.out, /Code jobs are off/);
});

await ok("code: PS away or not answering, exit 3 (run it here instead)", async () => {
  state({ at: Date.now() - 10 * 60_000 });
  assert.equal((await cli(["code", "demo", "x"])).code, 3);
  state();
  answer = "none";
  const t0 = Date.now();
  const r = await cli(["code", "demo", "x"]);
  answer = "sent";
  assert.equal(r.code, 3); assert.ok(Date.now() - t0 < 40_000);
  for (const f of readdirSync(DIR)) if (f.startsWith("req-")) rmSync(join(DIR, f));
});

await ok("result: the report, the bundle and the fetch line (nothing merges)", async () => {
  const report = join(root, "report.md");
  writeFileSync(report, "# Mail tests\n\n- Commits: 1\n");
  writeFileSync(join(DIR, "res-codeone.json"), JSON.stringify({ id: "codeone", kind: "outsource", job: "00000000-0000-4000-8000-0000000000bb", title: "Mail tests", state: "done", report,
    bundle: "Downloads/From your other Mac/x/result.bundle", fetch: "git fetch '/x/result.bundle' outsource/b:review/b", at: Date.now() }));
  const r = await cli(["result", "00000000-0000-4000-8000-0000000000bb"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Commits: 1/); assert.match(r.out, /review it in your own copy: git fetch/); assert.match(r.out, /nothing is merged/);
});

clearInterval(fakePs);
rmSync(root, { recursive: true, force: true });
console.log(`secondcode: ${n} passed`);
