#!/usr/bin/env node
// Builds one flavour of PS (V1.58, layers/README.md): core alone ("gsquad") or core + a person's layer.
//
//   node tools/build.mjs <gsquad | path/to/layer.json> [web|mac|phone|all] [--check] [--tests]
//                        [--out <dir>] [--root web=<dir>] [--allow-fail a,b] [--repin]
//
// First tools/assemble.mjs makes the tree (default .build/<name>), then each part builds inside it:
//   web    tsc, then vite build --mode ps (dist-ps, what the Mac and the phone bundle)
//   mac    mac/build.sh with NO_INSTALL=1 (build/PS.app; signing as build.sh finds it, ad hoc otherwise)
//   phone  ./gradlew assembleRelease (signing as the phone's build.gradle.kts finds it)
// --check builds nothing: web tsc (+ the web unit tests with --tests), mac swiftc -typecheck, phone compileDebugKotlin.
// --allow-fail names web tests (file name without .test.ts) that may fail (ones that already fail on main).
// Nothing is installed, signed with anyone else's key, published or pushed here.
// PS 1.71: a layer build (not --check) whose profile has no channel of its own stops before anything is built.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assemble, channelProblem, PARTS, readLayer } from "./assemble.mjs";

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stop = (msg) => { console.error(`build: STOP, ${msg}`); process.exit(1); };

const a = process.argv.slice(2);
if (!a.length || a[0].startsWith("--")) stop("say which build: gsquad, or the path to a layer.json");
const which = a.shift();
let part = "all";
const opt = { core: CORE, rootOverrides: {} };
let check = false, tests = false, allow = new Set();
for (let i = 0; i < a.length; i++) {
  const k = a[i];
  if (k === "--check") check = true;
  else if (k === "--tests") tests = true;
  else if (k === "--out") opt.out = a[++i];
  else if (k === "--repin") opt.repin = true;
  else if (k === "--root") { const [p, d] = a[++i].split("="); if (!PARTS.includes(p) || !d) stop("--root takes web=<dir>, mac=<dir> or phone=<dir>"); opt.rootOverrides[p] = resolve(d); }
  else if (k === "--allow-fail") allow = new Set(a[++i].split(",").filter(Boolean));
  else if (["web", "mac", "phone", "all"].includes(k)) part = k;
  else stop(`unknown option ${k}`);
}
if (which !== "gsquad") opt.layerPath = which;

const { out, name, build } = assemble(opt);
// PS 1.71: a person's own Mac or phone build follows a channel of its own (tools/assemble.mjs channelProblem), never
// the G Squad one: the next G Squad release would replace it. A check (--check) builds nothing and is not stopped.
if (opt.layerPath && !check && (part === "all" || part === "mac" || part === "phone")) {
  const why = channelProblem(build.profile);
  if (why) stop(`this is your own build, but ${why} in your profile.json, so it would follow the G Squad channel and the next G Squad release would replace it. Give it a channel of its own: {"kind": "local"}, {"kind": "url", ...} or {"kind": "folder", ...} (see the skill, layers-and-versions.md). Nothing was built.`);
}
// The layer's own Mac folder (its signing keys and, next to it, its middle-click helper), never copied into .build/.
const layerMacRoot = opt.layerPath ? (opt.rootOverrides.mac || readLayer(resolve(opt.layerPath)).roots.mac) : null;
const parts = part === "all" ? PARTS : [part];
const results = [];
const sh = (label, cmd, args, cwd, env = {}) => {
  console.log(`build: [${name} ${label}] ${cmd} ${args.join(" ")}`);
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
  results.push({ label, ok: r.status === 0, s: Math.round((Date.now() - t0) / 1000) });
  return r.status === 0;
};

/** Every web unit test (tests/*.test.ts), a few at a time; resolves to the names that failed. */
function webTests(dir) {
  const names = readdirSync(join(dir, "tests")).filter((n) => n.endsWith(".test.ts")).sort();
  const failed = [];
  let next = 0;
  const lane = () => new Promise((done) => {
    const go = () => {
      if (next >= names.length) return done();
      const n = names[next++];
      const c = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join("tests", n)], { cwd: dir, stdio: "ignore" });
      const t = setTimeout(() => c.kill("SIGKILL"), 180_000);
      c.on("exit", (code) => { clearTimeout(t); if (code !== 0) failed.push(n.replace(/\.test\.ts$/, "")); go(); });
    };
    go();
  });
  return Promise.all(Array.from({ length: Math.max(2, Math.min(6, cpus().length - 2)) }, lane)).then(() => ({ total: names.length, failed: failed.sort() }));
}

for (const p of parts) {
  const dir = join(out, p);
  if (p === "web") {
    const bin = (b) => join(dir, "node_modules/.bin", b);
    if (!existsSync(join(dir, "node_modules"))) stop("no node_modules for the web part (run npm ci in core's web/)");
    if (!sh("web tsc", bin("tsc"), ["--noEmit", "-p", "."], dir)) continue;
    if (check && tests) {
      const r = await webTests(dir);
      const bad = r.failed.filter((f) => !allow.has(f));
      console.log(`build: [${name} web tests] ${r.total - r.failed.length}/${r.total} pass${r.failed.length ? `; failed: ${r.failed.join(", ")}` : ""}${bad.length !== r.failed.length ? ` (allowed: ${r.failed.filter((f) => allow.has(f)).join(", ")})` : ""}`);
      results.push({ label: "web tests", ok: bad.length === 0, s: 0, failed: bad });
    }
    if (!check) sh("web build", bin("vite"), ["build", "--mode", "ps"], dir);
  } else if (p === "mac") {
    if (check) {
      const srcs = readdirSync(join(dir, "Sources")).filter((n) => n.endsWith(".swift")).map((n) => join("Sources", n));
      sh("mac typecheck", "swiftc", ["-typecheck", "-target", "arm64-apple-macos13", ...srcs, "Helper/RebootXPC.swift"], dir);
    } else {
      // build.sh finds the web part next to it (PS_WEB_DIR, the assembled web/, whose dist-ps the web step above made)
      // and the signing keychain in the LAYER's own mac/signing/ (PS_SIGNING_DIR): keys are never copied into .build/.
      // With no keychain there (G Squad, a friend without keys) build.sh signs ad hoc.
      const env = { NO_INSTALL: "1", PS_WEB_DIR: join(out, "web") };
      const keys = layerMacRoot && join(layerMacRoot, "signing");
      if (keys && existsSync(join(keys, "ps-signing.keychain-db"))) env.PS_SIGNING_DIR = keys;
      if (layerMacRoot && existsSync(join(layerMacRoot, "../middle-click"))) env.PS_MIDDLECLICK_DIR = resolve(layerMacRoot, "../middle-click");
      sh("mac build", "bash", ["build.sh"], dir, env);
    }
  } else if (p === "phone") {
    sh(check ? "phone compile" : "phone build", "./gradlew", ["--no-daemon", "-q", check ? ":app:compileDebugKotlin" : "assembleRelease"], dir);
  }
}

console.log(`build: ${name} done: ${results.map((r) => `${r.label} ${r.ok ? "ok" : "FAILED"}${r.s ? ` ${r.s}s` : ""}`).join(", ")}  (${out})`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
