#!/usr/bin/env node
// Your own copy of every new version (PS 1.71). A plain watcher on a developer's own Mac (a LaunchAgent, no AI) for a
// person with their own build (a layer, layers/README.md) whose profile names a folder channel:
//   {"name": "jan", "channel": {"kind": "folder", "path": "~/Library/Application Support/PS Own Channel/",
//                               "key": "<your update public key>", "certRoot": "<your certificate's root, 40 hex>"}}
// When a newer shared version is claimed on core main (anyone's: the owner's, the G Squad's, yours), it makes YOUR build
// of that version and puts it in your folder. Your PS shows Update available and waits for your click.
//   1. look     fetch core's main and version tags (fetch only, never a push), read your folder's note
//   2. copy     core at that version's tag in a worktree of its own (your working branch is never touched)
//   3. build    tools/build.mjs <your layer> web, then mac under /tmp/ps-build.lock (signed as your layer signs)
//   4. sign     the app is com.cincee.ps, signed with your certificate (certRoot), and follows your folder alone
//   5. stage    mac/release/publish.sh: the signed note for your channel, with that version's approved What's new lines
//   6. folder   the files first, the note last: PS sees the version only when everything is there
// Any step that fails STOPS: nothing goes in your folder, your PS stays as it is, one line in the log, and it is not
// tried again by itself (run it by hand once the cause is fixed). It never touches the G Squad channel, never claims a
// version, never pushes, never publishes anywhere, never installs anything.
//
//   node tools/follow.mjs install --layer <layer.json> --key <your update private key file>   (installed OFF)
//   node tools/follow.mjs check                       what it would do now (reads only)
//   node tools/follow.mjs run --version 1.72 [--dry-run]   make your copy of that version now (--dry-run: say each step)
//   node tools/follow.mjs on | off | status           the LaunchAgent (every 15 minutes while on)
//   node tools/follow.mjs watch                       what the LaunchAgent runs
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOME = process.env.PS_FOLLOW_HOME || homedir();
const HERE = dirname(fileURLToPath(import.meta.url));
export const LABEL = "com.cincee.ps.follow";
const REMOTE = process.env.PS_FOLLOW_REMOTE || "origin";
const STATE = process.env.PS_FOLLOW_STATE || join(HOME, "Library/Application Support/PS Follow");
/** Your core clone: this file's own (tools/..), or for the LaunchAgent's copy in STATE/app the one install wrote down. */
const CORE = process.env.PS_FOLLOW_CORE || (resolve(HERE) === resolve(STATE, "app")
  ? (() => { try { return JSON.parse(readFileSync(join(STATE, "config.json"), "utf8")).core; } catch { return ""; } })()
  : resolve(HERE, ".."));
const LOG = process.env.PS_FOLLOW_LOG || join(HOME, "Library/Logs/PS/follow.log");
const PLIST = join(HOME, "Library/LaunchAgents", `${LABEL}.plist`);
const BUILD_LOCK = "/tmp/ps-build.lock";

// ---------- small pure helpers (web/tests/follow.test.ts) ----------

/** "1.71" -> [1, 71]; null when it is not a version. */
export function ver(s) { const m = /^v?(\d{1,3})\.(\d{1,3})$/.exec(String(s ?? "").trim()); return m ? [Number(m[1]), Number(m[2])] : null; }
export function cmp(a, b) { const x = ver(a), y = ver(b); if (!x || !y) return !x && !y ? 0 : !x ? -1 : 1; return Math.sign(x[0] - y[0] || x[1] - y[1]); }
const plain = (s) => { const v = ver(s); return v ? `${v[0]}.${String(v[1]).padStart(2, "0")}` : ""; };
/** A claim tag's message ({by, kind, at, name}, as the claim tool writes it); null for anything else. */
export function tagInfo(body) {
  try {
    const o = JSON.parse(String(body).trim());
    return o && typeof o.by === "string" && /^[a-z][a-z0-9-]{0,30}$/.test(o.by) && (o.kind === "shared" || o.kind === "private") ? { by: o.by, kind: o.kind, name: typeof o.name === "string" ? o.name : "" } : null;
  } catch { return null; }
}
/** The shared versions claimed on core main, newest first. tags: { "1.72": { by, kind, name, onMain } }. */
export function shared(tags) {
  return Object.keys(tags).filter((v) => ver(v) && tags[v].kind === "shared" && tags[v].onMain).sort((a, b) => cmp(b, a));
}
/** The signed note's version, maker and channel ("" when unreadable). */
export function noteInfo(raw) {
  try {
    const p = JSON.parse(Buffer.from(JSON.parse(raw).signed, "base64").toString("utf8"));
    const m = /^V(\d{1,3}\.\d{1,3})$/.exec(String(p.name || ""));
    return { version: m ? m[1] : "", by: typeof p.by === "string" ? p.by : "", channel: typeof p.channel === "string" ? p.channel : "",
      files: [p.app?.file, p.web?.file].filter((f) => typeof f === "string" && /^updates\/[A-Za-z0-9._-]{1,80}$/.test(f)) };
  } catch { return { version: "", by: "", channel: "", files: [] }; }
}
/** Your folder channel from your profile: { name, dir, certRoot }; throws with the reason when there is none. */
export function folderOf(profile, home = HOME) {
  const ch = profile?.channel;
  if (!profile || typeof profile.name !== "string" || !/^[a-z][a-z0-9-]{0,30}$/.test(profile.name) || profile.name === "gsquad") throw new Error("your profile.json has no name of your own");
  if (ch?.kind !== "folder" || typeof ch.path !== "string") throw new Error('your profile.json has no folder channel ({"kind": "folder", "path": "~/Library/Application Support/<a folder>/"})');
  const p = ch.path.startsWith("~/") ? home + ch.path.slice(1) : ch.path;
  const root = `${home}/Library/Application Support/`;
  if (!p.endsWith("/") || !p.startsWith(root) || p.length <= root.length || p.split("/").some((x) => x === "." || x === "..")) throw new Error("your folder channel must be a folder in your own ~/Library/Application Support/, ending in /");
  const certRoot = typeof ch.certRoot === "string" && /^[0-9a-f]{40}$/.test(ch.certRoot) ? ch.certRoot : "";
  return { name: profile.name, dir: p, certRoot };
}
/** What to do now: { act: "make", version, by } | { act: "none" | "wait", why }. history: this watcher's own record. */
export function decide({ tags = {}, own = "", history = {} }) {
  const list = shared(tags);
  if (!list.length) return { act: "none", why: "no shared version is claimed on core main" };
  const v = list[0];
  if (own && cmp(v, own) <= 0) return { act: "none", why: `your folder already has V${own}` };
  const h = history[v];
  if (h?.state === "done") return { act: "none", why: `your copy of V${v} was already made` };
  if (h?.state === "failed") return { act: "none", why: `your copy of V${v} stopped before (${h.step || "?"}); run it again by hand: node tools/follow.mjs run --version ${v}` };
  if (h?.state === "running") return { act: "wait", why: `your copy of V${v} is being made` };
  return { act: "make", version: v, by: tags[v].by };
}
export function plistText(node, script, home = HOME) {
  const x = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${x(node)}</string><string>${x(script)}</string><string>watch</string></array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>Nice</key><integer>5</integer>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StandardOutPath</key><string>${x(join(home, "Library/Logs/PS/follow.out.log"))}</string>
  <key>StandardErrorPath</key><string>${x(join(home, "Library/Logs/PS/follow.out.log"))}</string>
</dict>
</plist>
`;
}

// ---------- running things ----------

let DRY = false;
function say(s) {
  console.log(s);
  try { mkdirSync(dirname(LOG), { recursive: true }); appendFileSync(LOG, `${new Date().toISOString().slice(0, 19)}Z ${s}\n`); } catch { /* the log is a help only */ }
}
function run(cmd, args, { cwd, env } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ")}`);
  return r.stdout;
}
const git = (dir, ...a) => run("git", ["-C", dir, ...a]);
const gitOk = (dir, ...a) => spawnSync("git", ["-C", dir, ...a], { stdio: "ignore" }).status === 0;
function withBuildLock(fn) {
  const t0 = Date.now();
  while (spawnSync("mkdir", [BUILD_LOCK]).status !== 0) {
    if (Date.now() - t0 > 3 * 3600e3) throw new Error("waited 3 hours for the build lock");
    spawnSync("sleep", ["20"]);
  }
  try { return fn(); } finally { spawnSync("rmdir", [BUILD_LOCK]); }
}
const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };
const config = () => readJson(join(STATE, "config.json"), {});
const readState = () => readJson(join(STATE, "state.json"), { versions: {} });
function mark(v, patch) {
  if (DRY) return;
  const s = readState();
  s.versions[v] = { ...(s.versions[v] || {}), ...patch, at: new Date().toISOString() };
  mkdirSync(STATE, { recursive: true }); writeFileSync(join(STATE, "state.json"), JSON.stringify(s, null, 2) + "\n");
}
class Stop extends Error { constructor(step, why) { super(why); this.step = step; } }

// ---------- the look (reads only, apart from fetching core) ----------

function look() {
  const c = config();
  if (!c.layer || !existsSync(c.layer)) throw new Stop("look", "no layer set: node tools/follow.mjs install --layer <layer.json> --key <key file>");
  const profile = readJson(join(dirname(c.layer), "profile.json"));
  const ch = folderOf(profile);
  if (!CORE || !existsSync(join(CORE, "tools/build.mjs"))) throw new Stop("look", `your core clone is not at ${CORE || "?"}`);
  if (process.env.PS_FOLLOW_FETCH !== "0") git(CORE, "fetch", "--quiet", "--prune", REMOTE, `+refs/heads/main:refs/remotes/${REMOTE}/main`, "+refs/tags/v*:refs/tags/v*");
  const tags = {};
  const raw = git(CORE, "for-each-ref", "refs/tags/v*", "--format=%(refname:short)%00%(objecttype)%00%(contents)%00%00");
  for (const rec of raw.split("\0\0").map((s) => s.replace(/^\n/, "")).filter(Boolean)) {
    const [name, type, body = ""] = rec.split("\0");
    const v = plain(name), info = type === "tag" ? tagInfo(body) : null;
    if (!v || !info) continue;
    const commit = git(CORE, "rev-parse", `${name}^{commit}`).trim();
    tags[v] = { ...info, commit, onMain: gitOk(CORE, "merge-base", "--is-ancestor", commit, `refs/remotes/${REMOTE}/main`) };
  }
  let own = "";
  try { own = noteInfo(readFileSync(join(ch.dir, "ps-update.json"), "utf8")).version; } catch { /* nothing there yet */ }
  return { c, profile, ch, tags, own };
}

// ---------- making your copy ----------

async function makeCopy(version) {
  const v = plain(version);
  if (!v) throw new Stop("look", `not a version: ${version}`);
  const step = (name, what) => say(`${DRY ? "DRY " : "STEP"} [${name}] ${what}`);
  say(`Your own copy of V${v}: ${DRY ? "DRY RUN (nothing is built, signed, staged or put in your folder)" : "RUN"}`);
  const L = look();
  const t = L.tags[v];
  if (!t || t.kind !== "shared" || !t.onMain) throw new Stop("look", `V${v} is not a shared version claimed on core main`);
  if (L.own && cmp(v, L.own) <= 0) throw new Stop("look", `your folder already has V${L.own}`);
  if (!L.c.key || !existsSync(L.c.key)) throw new Stop("look", "your update key file is not there (install --key <file>)");
  say(`  core v${v}: ${t.commit.slice(0, 12)} by ${t.by}${t.name ? ` (${t.name})` : ""}; your folder: ${L.own ? `V${L.own}` : "empty"} (${L.ch.dir})`);
  const wt = join(STATE, "work", `v${v}`), out = join(wt, ".build", L.profile.name), layer = resolve(L.c.layer);
  const app = join(out, "mac/build/PS.app"), dist = join(out, "web/dist-ps"), stage = join(STATE, `stage-v${v}`);

  step("copy", `core at v${v} in its own worktree ${wt} (your working branch is not touched)`);
  if (!DRY) {
    if (existsSync(wt)) { spawnSync("git", ["-C", CORE, "worktree", "remove", "--force", wt], { stdio: "ignore" }); rmSync(wt, { recursive: true, force: true }); }
    mkdirSync(dirname(wt), { recursive: true });
    git(CORE, "worktree", "add", "--quiet", "--detach", wt, `refs/tags/v${v}`);
    const nm = join(CORE, "web/node_modules"), lockOf = (d) => { try { return readFileSync(join(d, "web/package-lock.json"), "utf8"); } catch { return null; } };
    if (existsSync(nm) && lockOf(CORE) !== null && lockOf(CORE) === lockOf(wt)) symlinkSync(nm, join(wt, "web/node_modules"), "dir");
    else run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: join(wt, "web") });
  }
  step("build", `tools/build.mjs ${layer} web (type check and web files), then mac under ${BUILD_LOCK} (signed as your layer signs, never installed)`);
  if (!DRY) {
    try {
      run("node", [join(wt, "tools/build.mjs"), layer, "web", "--out", out], { cwd: wt });
      writeFileSync(join(dist, "ps-version.json"), run("node", ["scripts/ps-version.mjs"], { cwd: join(out, "web") }).trim() + "\n");
      withBuildLock(() => run("node", [join(wt, "tools/build.mjs"), layer, "mac", "--out", out], { cwd: wt }));
    } catch (e) { throw new Stop("build", e.message); }
  }
  step("sign", `com.cincee.ps, signed with your certificate${L.ch.certRoot ? ` (root ${L.ch.certRoot.slice(0, 8)}...)` : ""}, following your folder alone`);
  if (!DRY) {
    const req = `identifier "com.cincee.ps"${L.ch.certRoot ? ` and certificate root = H"${L.ch.certRoot}"` : ""}`;
    try { run("codesign", ["--verify", "--strict", "--deep", `-R=${req}`, app]); } catch (e) { throw new Stop("sign", `the app is not signed as your profile says (${e.message})`); }
    const p = readJson(join(app, "Contents/Resources/profile.json"));
    if (p?.channel?.kind !== "folder" || p.channel.path !== L.profile.channel.path || p.name !== L.profile.name) throw new Stop("sign", "the app does not follow your folder channel");
  }
  step("stage", `mac/release/publish.sh: the signed note for your channel "${L.ch.name}" with V${v}'s approved What's new lines, into ${stage}`);
  if (!DRY) {
    rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { recursive: true });
    const notes = spawnSync("node", ["scripts/ps-public.mjs", "notes-text"], { cwd: join(out, "web"), encoding: "utf8" }).stdout || "";
    const history = spawnSync("node", ["scripts/ps-public.mjs", "history-json"], { cwd: join(out, "web"), encoding: "utf8" }).stdout || "[]";
    try {
      withBuildLock(() => run("bash", [join(out, "mac/release/publish.sh"), "app", dist, app], { cwd: join(out, "mac"), env: {
        PS_RELEASE_OUT: stage, PS_UPDATE_CHANNEL: L.ch.name, PS_FLAVOUR: L.ch.name, PS_UPDATE_KEY: L.c.key, PS_NOTES: notes, PS_HISTORY: history } }));
    } catch (e) { throw new Stop("stage", e.message); }
    const n = noteInfo(readFileSync(join(stage, "ps-update.json"), "utf8"));
    if (n.version !== v || n.channel !== L.ch.name) throw new Stop("stage", `the note says V${n.version} for ${n.channel || "?"}`);
  }
  step("folder", `the files, then the note, into ${L.ch.dir}: your PS shows Update available and waits for your click`);
  if (!DRY) {
    const n = noteInfo(readFileSync(join(stage, "ps-update.json"), "utf8"));
    mkdirSync(join(L.ch.dir, "updates"), { recursive: true });
    for (const f of n.files) { copyFileSync(join(stage, f), join(L.ch.dir, `${f}.part`)); renameSync(join(L.ch.dir, `${f}.part`), join(L.ch.dir, f)); }
    copyFileSync(join(stage, "ps-update.json"), join(L.ch.dir, ".ps-update.json.part"));
    renameSync(join(L.ch.dir, ".ps-update.json.part"), join(L.ch.dir, "ps-update.json"));
    for (const f of readdirSync(join(L.ch.dir, "updates"))) if (!n.files.includes(`updates/${f}`)) rmSync(join(L.ch.dir, "updates", f), { force: true });   // older versions go
    spawnSync("git", ["-C", CORE, "worktree", "remove", "--force", wt], { stdio: "ignore" });
    rmSync(stage, { recursive: true, force: true });
  }
  say(DRY ? "Dry run finished. Nothing was built, signed, staged or put in your folder." : `Done: your own V${v} is in your folder. Your PS offers it and waits for your click.`);
}

async function runOne(version) {
  const v = plain(version);
  mark(v, { state: "running", pid: process.pid });
  try { await makeCopy(v); mark(v, { state: "done" }); return true; }
  catch (e) {
    const st = e instanceof Stop ? e.step : "error";
    say(`STOPPED at ${st}: ${e.message}. Nothing was put in your folder; your PS stays as it is.`);
    mark(v, { state: "failed", step: st, why: String(e.message).slice(0, 400) });
    process.exitCode = 1;
    return false;
  }
}

// ---------- the switch (LaunchAgent) ----------

const SWITCH = join(STATE, "on");
const APP = join(STATE, "app/follow.mjs");
const uid = () => String(process.getuid());
const lc = (...a) => spawnSync("launchctl", a, { encoding: "utf8" });
const loaded = () => lc("print", `gui/${uid()}/${LABEL}`).status === 0;
function install(layer, key) {
  const c = { ...config() };
  if (layer) c.layer = resolve(layer);
  if (key) c.key = resolve(key);
  if (!c.layer || !existsSync(c.layer)) throw new Error("say where your layer is: --layer <layer.json>");
  folderOf(readJson(join(dirname(c.layer), "profile.json")));   // stops here when the profile has no folder channel
  c.core = CORE;
  mkdirSync(dirname(APP), { recursive: true });
  writeFileSync(join(STATE, "config.json"), JSON.stringify(c, null, 2) + "\n");
  // The LaunchAgent runs a copy of this one file (node built ins only) that knows where your core clone is.
  if (resolve(fileURLToPath(import.meta.url)) !== resolve(APP)) copyFileSync(fileURLToPath(import.meta.url), APP);
  mkdirSync(dirname(PLIST), { recursive: true });
  writeFileSync(PLIST, plistText(process.execPath, APP));
  if (!existsSync(SWITCH)) lc("disable", `gui/${uid()}/${LABEL}`);   // installed OFF
}
function status() {
  const s = readState(), c = config();
  console.log(`Your own copy watcher: ${existsSync(SWITCH) ? "ON" : "OFF"} (${existsSync(PLIST) ? "installed" : "not installed"}${loaded() ? ", loaded" : ""}), every 15 minutes when on.`);
  console.log(`Layer: ${c.layer || "not set"}; core: ${c.core || CORE}; log: ${LOG}`);
  for (const [v, x] of Object.entries(s.versions).sort((a, b) => cmp(b[0], a[0])).slice(0, 5)) console.log(`  V${v}: ${x.state}${x.step ? ` at ${x.step}` : ""} (${x.at})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const [cmd, ...a] = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  DRY = a.includes("--dry-run");
  try {
    if (cmd === "check") {
      DRY = true;
      const L = look();
      const d = decide({ tags: L.tags, own: L.own, history: readState().versions });
      console.log(`core's newest shared version: ${shared(L.tags)[0] ? `V${shared(L.tags)[0]}` : "none"}; your folder: ${L.own ? `V${L.own}` : "empty"} (${L.ch.dir})`);
      console.log(d.act === "make" ? `would make your own copy of V${d.version} (made by ${d.by})` : `${d.act}: ${d.why}`);
    } else if (cmd === "run") {
      const v = opt("--version");
      if (!v) throw new Error("say which version: --version 1.72");
      if (DRY) { try { await makeCopy(v); } catch (e) { say(`a real run would STOP at ${e.step || "error"}: ${e.message}`); } }
      else await runOne(v);
    } else if (cmd === "watch") {
      if (!existsSync(SWITCH)) process.exit(0);
      const lock = join(STATE, "run.lock");
      mkdirSync(STATE, { recursive: true });
      if (spawnSync("mkdir", [lock]).status !== 0) {   // one run at a time; a run the Mac's sleep or restart cut short is over
        const pid = Number(readJson(join(lock, "pid.json"), 0));
        if (pid && spawnSync("kill", ["-0", String(pid)]).status === 0) process.exit(0);
        rmSync(lock, { recursive: true, force: true }); mkdirSync(lock);
        for (const [v, x] of Object.entries(readState().versions)) if (x.state === "running") mark(v, { state: "failed", step: "error", why: "stopped part way (the Mac slept or restarted)" });
      }
      writeFileSync(join(lock, "pid.json"), String(process.pid));
      try {
        const L = look();
        const d = decide({ tags: L.tags, own: L.own, history: readState().versions });
        if (d.act === "make") await runOne(d.version);
      } catch (e) { say(`watch: could not look (${e.message}); trying again in 15 minutes`); }
      finally { rmSync(lock, { recursive: true, force: true }); }
    } else if (cmd === "install") {
      install(opt("--layer"), opt("--key")); status();
    } else if (cmd === "on") {
      install(opt("--layer"), opt("--key"));
      writeFileSync(SWITCH, new Date().toISOString() + "\n");
      lc("enable", `gui/${uid()}/${LABEL}`);
      if (loaded()) lc("bootout", `gui/${uid()}/${LABEL}`);
      const r = lc("bootstrap", `gui/${uid()}`, PLIST);
      if (r.status !== 0) throw new Error(`launchctl bootstrap failed: ${(r.stderr || "").trim()}`);
      status();
    } else if (cmd === "off") {
      rmSync(SWITCH, { force: true });
      if (loaded()) lc("bootout", `gui/${uid()}/${LABEL}`);
      lc("disable", `gui/${uid()}/${LABEL}`);
      status();
    } else if (cmd === "status") {
      status();
    } else {
      console.error("usage: follow.mjs install --layer <layer.json> --key <file> | check | run --version <v> [--dry-run] | on | off | status | watch");
      process.exit(2);
    }
  } catch (e) {
    console.error(`follow: ${e.message}`);
    process.exit(1);
  }
}
