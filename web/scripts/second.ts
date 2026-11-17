// Second Computer CLI, for Claude sessions on the developer's main Mac (the primary). It hands a job to the running PS
// app, which signs it, seals it into the vault with the code it needs and waits for the M1 (the secondary)
// to run it. No keys, no network and no vault access here: PS does all of that (protocol.md section 11).
//
//   node scripts/second.ts status
//   node scripts/second.ts selftest [--only <area>]
//   node scripts/second.ts build [--send]
//   node scripts/second.ts test <project folder or name> [--preset auto|node-tests|npm-test|swift-test|pytest|make-test]
//   node scripts/second.ts claude <project folder or name> "<what to do>" [--model opus|sonnet] [--minutes 5..60]
//   node scripts/second.ts cancel <job id>
//   node scripts/second.ts outsource [--model opus|sonnet] [--minutes 5..30] [--json tasks.json] "<task 1>" "<task 2>" ...
//   node scripts/second.ts code <repo> "<what to do>" [--base <commit>] [--tool claude|codex] [--model opus|sonnet] [--minutes 5..240] [--shots] [--title "<title>"]
//   node scripts/second.ts wait <job> [<job> ...]     (exits when every one has finished; run it in the background)
//   node scripts/second.ts result <job>               (the report)
// Common: --timeout <minutes> (default 45, wait 75), --no-wait (send and exit 0), --no-fallback.
// outsource: each task is its own research job, sealed to the M1 (post-quantum X-Wing where both Macs can) and run
// there up to 3 at once with web search and its own folder only. Reports land in ~/Downloads/From your other Mac.
// code (PS 1.65, only while Code jobs is switched on in Second Computer, Outsource): a code job, sealed the same way, run
// on the second Mac in its own copy of <repo> (a folder name it has, or a git link; a folder here gives its name and its
// current commit as --base), one at a time, never pushing. A git bundle comes back next to the report; `result` prints
// the fetch line. Nothing merges by itself.
//
// Exit codes: 0 done and passed, 1 failed, refused or timed out, 2 bad usage, 3 the second Mac cannot take it
// (PS not running or locked, nothing paired, the M1 offline, no answer in 30 s): run it locally as before.
// For `test` the fallback runs the same preset here unless --no-fallback; for the others it only says so.
// Code travels as a git bundle of HEAD (or `git stash create` when there are uncommitted changes, which never
// touches the working tree). Untracked and ignored files never travel; secret looking files stop the send.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { codeBody, folderName, repoOk, type CodeTool } from "../src/core/secondcode.ts";
import { FILE_MAX, looksSecret, OJOB_MAX_MINUTES, outsourceTitle, secretPath, suiteWords, TEST_PRESETS, isDone, type JobStatusBody } from "../src/core/second.ts";

const DIR = process.env.PS_SECOND_DIR || join(homedir(), "Library/Application Support/PS/Second/cli");   // tests point these elsewhere
const PROJECTS = process.env.PS_SECOND_PROJECTS || join(homedir(), "Projects");
const say = (s: string) => process.stdout.write(s + "\n");
const fail = (s: string, code = 2): never => { process.stderr.write(s + "\n"); process.exit(code); };

const argv = process.argv.slice(2);
const flags = new Map<string, string | true>();
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=", 2);
    if (v !== undefined) flags.set(k, v);
    else if (["only", "preset", "model", "minutes", "timeout", "json", "base", "tool", "title"].includes(k)) flags.set(k, argv[++i] ?? "");
    else flags.set(k, true);
  } else pos.push(a);
}
const cmd = pos.shift();
const flag = (k: string) => flags.get(k);

type State = { ps?: boolean; unlocked?: boolean; role?: string; at?: number;
  secondary?: { device: string; name: string; online: boolean; lastSeen: number | null; have?: Record<string, string>; busy?: string | null; outsource?: boolean; suite?: string } | null };
function readState(): State | null {
  try { return JSON.parse(readFileSync(join(DIR, "state.json"), "utf8")) as State; } catch { return null; }
}
/** Why the second Mac cannot take a job right now (null when it can). */
function unavailable(st: State | null): string | null {
  if (!st || !st.at || Date.now() - st.at > 2 * 60_000) return "PS is not running on this Mac (or it is an older PS without Second Computer)";
  if (!st.unlocked) return "PS is locked";
  if (st.role !== "primary") return "this Mac is not set as the primary";
  if (!st.secondary) return "no second Mac is paired";
  if (!st.secondary.online) return `${st.secondary.name} is offline`;
  return null;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
}
function projectDir(p: string): { name: string; dir: string } {
  const dir = existsSync(p) ? resolve(p) : join(PROJECTS, p);
  if (!existsSync(join(dir, ".git"))) fail(`Not a git project: ${p}`);
  const name = basename(dir).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(name)) fail(`Project folder names must be plain (letters, digits, dot, dash): ${name}`);
  return { name, dir };
}

/** A bundle of this project's current code for the secondary, incremental from what it already has. */
function bundle(p: { name: string; dir: string }, have: string | undefined, id: string) {
  const dirty = git(p.dir, ["status", "--porcelain", "--untracked-files=no"]) !== "";
  const head = (dirty ? git(p.dir, ["stash", "create", "ps-second"]) : "") || git(p.dir, ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(head)) fail(`${p.name}: no commit to send`);
  const files = git(p.dir, ["ls-tree", "-r", "--name-only", head]).split("\n").filter(Boolean);
  const bad = files.filter(secretPath);
  if (bad.length) fail(`${p.name}: not sent, it has secret looking files tracked: ${bad.slice(0, 5).join(", ")}`, 1);
  let base: string | undefined;
  if (have && /^[0-9a-f]{40}$/.test(have)) {
    try { git(p.dir, ["merge-base", "--is-ancestor", have, head]); base = have; } catch { base = undefined; }
  }
  if (base === head) {   // it already has this commit: send just the last one again (a bundle may not be empty)
    try { base = git(p.dir, ["rev-parse", `${head}^`]); } catch { base = undefined; }
  }
  const path = join(DIR, `b-${id}-${p.name}.bundle`);
  const ref = `refs/ps-second/cli-${id}`;
  git(p.dir, ["update-ref", ref, head]);
  try {
    git(p.dir, ["bundle", "create", path, ref, ...(base ? [`^${base}`] : [])]);
  } catch {
    git(p.dir, ["bundle", "create", path, ref]);   // the incremental one was empty or refused: send it whole
    base = undefined;
  } finally { git(p.dir, ["update-ref", "-d", ref]); }
  const size = statSync(path).size;
  if (size > FILE_MAX) { rmSync(path, { force: true }); fail(`${p.name}: the code bundle is ${Math.round(size / 1048576)} MB, over the 25 MB limit`, 1); }
  return { project: p.name, path, head, ...(base ? { base } : {}), dirty, size };
}

function writeReq(req: object, id: string) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  chmodSync(DIR, 0o700);
  const tmp = join(DIR, `req-${id}.json.tmp`);
  writeFileSync(tmp, JSON.stringify(req), { mode: 0o600 });
  renameSync(tmp, join(DIR, `req-${id}.json`));
}

type Res = { id: string; job?: string; state: string; reason?: string; status?: JobStatusBody; resultPath?: string; at?: number };
async function waitFor(id: string, timeoutMin: number, noWait: boolean): Promise<number> {
  const file = join(DIR, `res-${id}.json`);
  const start = Date.now();
  let last = "", acked = false;
  const fmt = (r: Res) => [r.state, r.status?.step, r.status?.summary].filter(Boolean).join(" · ");
  for (;;) {
    let r: Res | null = null;
    try { r = JSON.parse(readFileSync(file, "utf8")) as Res; } catch { /* not yet */ }
    if (r) {
      acked = true;
      const line = fmt(r);
      if (line !== last) { say(`[second] ${line}${r.job ? `  (job ${r.job})` : ""}`); last = line; }
      if (r.state === "refused" && !r.status) { say(`[second] refused: ${r.reason ?? "no reason given"}`); return 1; }
      if (noWait && r.state === "sent") return 0;
      if (r.status && isDone(r.status.state)) {
        if (r.status.tail) say("\n" + r.status.tail.trimEnd() + "\n");
        if (r.status.files?.length) say(`[second] changed files: ${r.status.files.join(", ")}`);
        if (r.resultPath) say(`[second] result: ${r.resultPath}`);
        else if (r.status.result) say("[second] result file: lands in ~/Downloads/From PS shortly");
        say(`[second] ${r.status.state}${r.status.reason ? `: ${r.status.reason}` : ""}${r.status.exit !== undefined ? ` (exit ${r.status.exit})` : ""}`);
        return r.status.state === "done" && (r.status.exit ?? 0) === 0 ? 0 : 1;
      }
    }
    if (!acked && Date.now() - start > 30_000) return 3;
    if (Date.now() - start > timeoutMin * 60_000) { say(`[second] still not finished after ${timeoutMin} min. It keeps running on the second Mac; see the Second Computer panel.`); return 1; }
    await new Promise((res) => setTimeout(res, 1500));
  }
}

function localTests(dir: string, preset: string): number {
  const has = (f: string) => existsSync(join(dir, f));
  let pick = preset;
  if (pick === "auto") {
    const pkg = has("package.json") ? JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> } : null;
    pick = pkg?.scripts?.test ? "npm-test" : has("tests") ? "node-tests" : has("Package.swift") ? "swift-test" : has("pytest.ini") || has("pyproject.toml") ? "pytest" : has("Makefile") ? "make-test" : "";
    if (!pick) { say("[second] no tests found here"); return 1; }
  }
  const run = (c: string, a: string[]) => spawnSync(c, a, { cwd: dir, stdio: "inherit", shell: false }).status ?? 1;
  switch (pick) {
    case "npm-test": return run("npm", ["test"]);
    case "node-tests": {
      const list = execFileSync("/bin/sh", ["-c", "ls tests/*.test.ts 2>/dev/null || true"], { cwd: dir, encoding: "utf8" }).split("\n").filter(Boolean);
      let code = 0;
      for (const t of list) code = run("node", ["--experimental-strip-types", t]) || code;
      if (has("tsconfig.json")) code = run("npx", ["tsc", "--noEmit", "-p", "."]) || code;
      return code;
    }
    case "swift-test": return run("swift", ["test"]);
    case "pytest": return run("python3", ["-m", "pytest"]);
    case "make-test": return run("make", ["test"]);
    default: return 2;
  }
}

// ---------- outsourcing (v1.3): sealed research jobs, waited for in the background ----------
type ORes = { id: string; kind?: string; job?: string; title?: string; state: string; suite?: string; reason?: string; summary?: string; report?: string; folder?: string; at?: number;
  bundle?: string; fetch?: string; bundleProblem?: string };
const FINAL = new Set(["done", "failed", "refused", "cancelled", "timeout", "expired"]);
function oresAll(): ORes[] {
  const out: ORes[] = [];
  let names: string[] = [];
  try { names = readdirSync(DIR); } catch { return out; }
  for (const f of names) {
    if (!/^res-[A-Za-z0-9_-]+\.json$/.test(f)) continue;
    try { const r = JSON.parse(readFileSync(join(DIR, f), "utf8")) as ORes; if (r.kind === "outsource") out.push(r); } catch { /* being written */ }
  }
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}
const oresOf = (key: string) => oresAll().find((r) => r.job === key || r.id === key) ?? null;
/** Why the other Mac cannot take sealed research right now, in plain words (null when it can). */
function outsourceBlock(st: State | null): string | null {
  const why = unavailable(st);
  if (why) return why;
  if (!st!.secondary!.outsource) return `PS on ${st!.secondary!.name} needs the update that takes sealed research (in its Tab list gear: Update available, then Update)`;
  return null;
}
async function sendOutsource(st: State | null): Promise<never> {
  const why = outsourceBlock(st);
  if (why) { say(`[second] not sent: ${why}.`); process.exit(3); }
  type Task = { title?: string; prompt: string; model?: string; minutes?: number };
  let tasks: Task[] = pos.map((p) => ({ prompt: p }));
  const file = flag("json");
  if (typeof file === "string") {
    const j = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(j)) fail("--json takes a list: [\"task\", ...] or [{\"title\", \"prompt\"}, ...]");
    tasks = tasks.concat((j as unknown[]).map((x) => typeof x === "string" ? { prompt: x } : x as Task));
  }
  tasks = tasks.filter((t) => typeof t.prompt === "string" && t.prompt.trim());
  if (!tasks.length) fail("Say what to research: node scripts/second.ts outsource \"<task 1>\" \"<task 2>\"");
  if (tasks.length > 10) fail("Ten tasks at most in one go.");
  const model = flag("model"), minutes = flag("minutes");
  if (model !== undefined && model !== "opus" && model !== "sonnet") fail("--model is opus or sonnet");
  if (minutes !== undefined && !(Number.isInteger(Number(minutes)) && Number(minutes) >= 5 && Number(minutes) <= OJOB_MAX_MINUTES)) fail(`--minutes is 5 to ${OJOB_MAX_MINUTES}`);
  for (const t of tasks) {
    const s = looksSecret(`${t.title ?? ""}\n${t.prompt}`);
    if (s) fail(`Not sent: "${t.prompt.slice(0, 60)}" looks like it holds ${s}. Nothing secret may go to the other Mac.`, 1);
    if (t.prompt.length > 8000) fail("A task is over 8000 characters.");
  }
  let code = 0;
  const sent: string[] = [];
  for (const t of tasks) {
    const id = randomBytes(9).toString("base64url");
    const title = t.title && /^[A-Za-z0-9][A-Za-z0-9 ,'()&+_-]{0,79}$/.test(t.title) ? t.title : outsourceTitle(t.prompt);
    const m = t.model ?? model, min = t.minutes ?? (minutes !== undefined ? Number(minutes) : undefined);
    writeReq({ id, type: "outsource", args: { title, prompt: t.prompt.trim(), ...(m ? { model: m } : {}), ...(min ? { minutes: min } : {}) } }, id);
    const start = Date.now();
    let r: ORes | null = null;
    while (Date.now() - start < 30_000) {
      r = oresOf(id);
      if (r && r.state !== "sending") break;
      await new Promise((res) => setTimeout(res, 300));
    }
    if (!r) { rmSync(join(DIR, `req-${id}.json`), { force: true }); say(`[second] not sent: PS did not pick it up within 30 s ("${title}").`); process.exit(3); }
    if (r.state === "refused" || r.state === "failed") { say(`[second] not sent: "${title}": ${r.reason ?? "refused"}`); code = 1; continue; }
    sent.push(r.job!);
    say(`[second] sent ${r.job}  "${title}"  (sealed with ${suiteWords(r.suite)})`);
  }
  if (sent.length) {
    say(`[second] ${sent.length} running on ${st!.secondary!.name} (3 at a time). Reports land in ~/Downloads/From your other Mac.`);
    say(`[second] to be told when they finish: node scripts/second.ts wait ${sent.join(" ")}`);
  }
  process.exit(code);
}
/** A code job (PS 1.65): sealed by PS as kind "code"; the second Mac says no while Code jobs is off there. */
async function sendCode(st: State | null): Promise<never> {
  const why = outsourceBlock(st);
  if (why) { say(`[second] not sent: ${why}.`); process.exit(3); }
  const usage = 'node scripts/second.ts code <repo> "<what to do>" [--base <commit>] [--tool claude|codex] [--model opus|sonnet] [--minutes 5..240] [--shots] [--title "<title>"]';
  const [repoArg, ...rest] = pos;
  const prompt = rest.join(" ").trim();
  if (!repoArg || !prompt) fail(usage);
  let repo = repoArg, base = flag("base");
  // A folder on this Mac (a path, or a name in the Projects folder): its name goes, and its current commit is the base.
  const link = repoOk(repoArg) && !folderName(repoArg);
  const here = link ? null : folderName(repoArg) && !existsSync(repoArg) ? (existsSync(join(PROJECTS, repoArg, ".git")) ? join(PROJECTS, repoArg) : null)
    : existsSync(repoArg) ? resolve(repoArg) : null;
  if (!link && !here && !folderName(repoArg)) fail(`No such folder: ${repoArg}`);
  if (here) {
    if (!existsSync(join(here, ".git"))) fail(`Not a git project: ${repoArg}`);
    repo = basename(here);
    if (typeof base !== "string") base = git(here, ["rev-parse", "HEAD"]);
  }
  if (typeof base !== "string" || !base) fail("Say which commit: --base <commit or branch> (the other Mac must have it).");
  const tool = flag("tool"), model = flag("model"), minutes = flag("minutes"), title = flag("title");
  if (tool !== undefined && tool !== "claude" && tool !== "codex") fail("--tool is claude or codex");
  if (model !== undefined && model !== "opus" && model !== "sonnet") fail("--model is opus or sonnet");
  const { body, why: no } = codeBody({ repo, base: String(base), prompt, tool: (tool as CodeTool | undefined) ?? "claude", model: model as "opus" | "sonnet" | undefined,
    minutes: minutes === undefined ? undefined : Number(minutes), shots: flag("shots") === true, title: typeof title === "string" ? title : undefined }, looksSecret);
  if (!body) fail(`Not sent: ${no}`, 1);
  const id = randomBytes(9).toString("base64url");
  writeReq({ id, type: "ocode", args: body }, id);
  const start = Date.now();
  let r: ORes | null = null;
  while (Date.now() - start < 30_000) {
    r = oresOf(id);
    if (r && r.state !== "sending") break;
    await new Promise((res) => setTimeout(res, 300));
  }
  if (!r) { rmSync(join(DIR, `req-${id}.json`), { force: true }); say("[second] not sent: PS did not pick it up within 30 s."); process.exit(3); }
  if (r.state === "refused" || r.state === "failed") { say(`[second] not sent: ${r.reason ?? "refused"}`); process.exit(1); }
  say(`[second] sent ${r.job}  "${r.title ?? ""}"  (sealed with ${suiteWords(r.suite)}), base ${String(base).slice(0, 12)}`);
  say(`[second] to be told when it finishes: node scripts/second.ts wait ${r.job}`);
  say(`[second] then: node scripts/second.ts result ${r.job}   (the report and the git fetch line; nothing merges by itself)`);
  process.exit(0);
}
async function waitOutsource(keys: string[]): Promise<never> {
  if (!keys.length) fail("node scripts/second.ts wait <job> [<job> ...]");
  const limit = Math.max(1, Number(flag("timeout")) || 75) * 60_000, start = Date.now();
  const last = new Map<string, string>(), told = new Set<string>();
  let failed = 0;
  for (;;) {
    let open = 0;
    for (const k of keys) {
      const r = oresOf(k);
      if (!r) { if (!told.has(k)) { told.add(k); say(`[second] ${k}: no such outsourced job on this Mac`); failed++; } continue; }
      let state = r.state;
      // Sent and never opened: a sealed task is good for 10 minutes only.
      if (state === "sent" && Date.now() - (r.at ?? start) > 11 * 60_000) state = "expired";
      const line = `${state}${r.reason ? `: ${r.reason}` : ""}`;
      if (last.get(k) !== line) {
        last.set(k, line);
        if (FINAL.has(state)) {
          say(`[second] "${r.title}" ${state === "done" ? "finished" : state}${r.reason ? `: ${r.reason}` : state === "expired" ? ": the other Mac never picked it up (offline or PS closed there)" : ""}`);
          if (r.summary) say(`  ${r.summary}`);
          if (r.report) say(`  report: ${r.report}`);
          if (r.fetch) say(`  bundle: ${r.bundle ?? ""}\n  review it: ${r.fetch}`);
          else if (r.bundleProblem) say(`  ${r.bundleProblem}`);
          if (state !== "done") failed++;
        } else if (state === "running") say(`[second] "${r.title}" running on the other Mac`);
        else if (state === "queued") say(`[second] "${r.title}" waiting for a free slot on the other Mac`);
      }
      if (state === "sent" && Date.now() - start > 90_000 && !told.has(k + ":slow")) { told.add(k + ":slow"); say(`[second] "${r.title}": the other Mac has not opened it yet (offline, asleep or PS closed there?). It is good for 10 minutes.`); }
      if (!FINAL.has(state)) open++;
    }
    if (!open) process.exit(failed ? 1 : 0);
    if (Date.now() - start > limit) { say(`[second] still running after ${Math.round(limit / 60_000)} min; it carries on on the other Mac (wait again, or see the Second Computer window).`); process.exit(1); }
    await new Promise((res) => setTimeout(res, 2000));
  }
}

async function main() {
  const st = readState();
  if (cmd === "outsource") await sendOutsource(st);
  if (cmd === "code") await sendCode(st);
  if (cmd === "wait") await waitOutsource(pos);
  if (cmd === "result") {
    const r = oresOf(pos[0] ?? "") ?? fail("node scripts/second.ts result <job>");
    if (!r.report) { say(`[second] "${r.title}" is ${r.state}${r.reason ? `: ${r.reason}` : ""}; no report yet.`); process.exit(r.state === "done" ? 0 : 1); }
    say(readFileSync(r.report, "utf8"));
    if (r.fetch) say(`\n[second] bundle: ${r.bundle ?? ""}\n[second] review it in your own copy: ${r.fetch}\n[second] nothing is merged; decide after review.`);
    else if (r.bundleProblem) say(`\n[second] ${r.bundleProblem}`);
    process.exit(0);
  }
  if (cmd === "cancel" && oresOf(pos[0] ?? "")) {
    const job = oresOf(pos[0])!.job!, id = randomBytes(9).toString("base64url");
    writeReq({ id, type: "ocancel", args: { job } }, id);
    say(`[second] asked the other Mac to stop ${job}`);
    process.exit(0);
  }
  if (!cmd || cmd === "help" || flag("help")) {
    say(readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).slice(0, 30).map((l) => l.slice(3)).join("\n"));
    process.exit(cmd ? 0 : 2);
  }
  if (cmd === "status") {
    const why = unavailable(st);
    if (!st) { say("PS has not written its Second Computer state on this Mac (PS not running, or older than V1.23)."); process.exit(3); }
    const s = st.secondary;
    say(`This Mac: ${st.role ?? "not set"}${st.unlocked ? "" : " (PS locked)"}`);
    say(s ? `Second Mac: ${s.name}, ${s.online ? "online" : "offline"}${s.lastSeen ? `, last seen ${new Date(s.lastSeen).toLocaleString()}` : ""}${s.busy ? `, busy with job ${s.busy}` : ""}` : "Second Mac: none paired");
    if (s?.have) for (const [p, h] of Object.entries(s.have)) say(`  has ${p} at ${h.slice(0, 10)}`);
    say(why ? `Jobs go: locally (${why})` : "Jobs go: to the second Mac");
    if (s) say(s.outsource ? `Outsourcing: sealed with ${suiteWords(s.suite)}` : "Outsourcing: needs PS updated on the second Mac");
    for (const r of oresAll().slice(0, 20)) say(`  ${r.job ?? r.id}  ${r.state.padEnd(9)} ${r.title ?? ""}`);
    process.exit(why ? 3 : 0);
  }

  const id = randomBytes(9).toString("hex");   // PS takes lowercase letters, digits and dashes only (SecondJobs.isId)
  const timeout = Math.max(1, Number(flag("timeout")) || 45);
  const noWait = flag("no-wait") === true;
  const fallback = flag("no-fallback") !== true;
  const why = unavailable(st);
  const have = st?.secondary?.have ?? {};

  let type: string, args: Record<string, unknown> = {}, projects: { name: string; dir: string }[] = [];
  let local: (() => number) | null = null;
  switch (cmd) {
    case "selftest": {
      const only = flag("only");
      if (only !== undefined && (typeof only !== "string" || !/^[a-z0-9]{1,20}$/.test(only))) fail("--only takes one area name, like dnd");
      type = "selftest"; args = only ? { only } : {};
      projects = [projectDir("ps-mac"), projectDir("web")];
      break;
    }
    case "build":
      type = "build"; args = flag("send") === true ? { send: true } : {};
      projects = [projectDir("ps-mac"), projectDir("web")];
      break;
    case "test": {
      const p = projectDir(pos[0] ?? fail("Which project? node scripts/second.ts test <folder>"));
      const preset = String(flag("preset") ?? "auto");
      if (!TEST_PRESETS.includes(preset as never)) fail(`--preset is one of ${TEST_PRESETS.join(", ")}`);
      type = "tests"; args = { preset }; projects = [p];
      local = () => localTests(p.dir, preset);
      break;
    }
    case "claude": {
      const p = projectDir(pos[0] ?? fail("Which project? node scripts/second.ts claude <folder> \"<what to do>\""));
      const prompt = pos.slice(1).join(" ").trim();
      if (!prompt || prompt.length > 8000) fail("Say what Claude should do (up to 8000 characters).");
      const model = flag("model"), minutes = flag("minutes");
      if (model !== undefined && model !== "opus" && model !== "sonnet") fail("--model is opus or sonnet");
      if (minutes !== undefined && !(Number.isInteger(Number(minutes)) && Number(minutes) >= 5 && Number(minutes) <= 60)) fail("--minutes is 5 to 60");
      type = "claude"; args = { prompt, ...(model ? { model } : {}), ...(minutes ? { minutes: Number(minutes) } : {}) }; projects = [p];
      break;
    }
    case "cancel": {
      const job = pos[0] ?? "";
      if (!/^[0-9a-f-]{36}$/.test(job)) fail("node scripts/second.ts cancel <job id>");
      type = "cancel"; args = { job };
      break;
    }
    default: fail(`Unknown command: ${cmd}. Try: status, selftest, build, test, claude, cancel.`);
  }

  if (why) {
    say(`[second] the second Mac cannot take it: ${why}.`);
    if (local && fallback) { say("[second] running it here instead."); process.exit(local()); }
    say("[second] run it locally as before.");
    process.exit(3);
  }
  const bundles = projects.map((p) => bundle(p, have[p.name], id));
  for (const b of bundles) say(`[second] ${b.project}: ${b.base ? "changes since what it has" : "full copy"}, ${Math.max(1, Math.round(b.size / 1024))} KB${b.dirty ? ", uncommitted changes included" : ""}`);
  writeReq({ id, type, args, bundles: bundles.map(({ project, path, head, base }) => ({ project, path, head, ...(base ? { base } : {}) })) }, id);
  const code = await waitFor(id, timeout, noWait);
  for (const b of bundles) rmSync(b.path, { force: true });
  if (code === 3) {
    rmSync(join(DIR, `req-${id}.json`), { force: true });
    say("[second] PS did not pick it up within 30 s.");
    if (local && fallback) { say("[second] running it here instead."); process.exit(local()); }
    say("[second] run it locally as before.");
  }
  process.exit(code);
}
void main();
