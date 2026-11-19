#!/usr/bin/env node
// Core + one layer -> one build tree (PS V1.58, layers/README.md).
//
//   node tools/assemble.mjs [--layer <layer.json>] [--profile <profile.json>] [--out <dir>]
//                           [--root web=<dir>] [--root mac=<dir>] [--root phone=<dir>] [--repin] [--quiet]
//
// No --layer: the G Squad tree (core alone, profile profiles/gsquad.json). With --layer: core, then the layer's
// files on top: "replace" (a plug point of core), "add" (a file core does not have), "remove" (a core file the
// layer takes out) and "pinned" (a core file the layer changes, three way merged when core moved on).
// Default out: <core>/.build/<name>. Only copies (no symlinked source files), so vite, tsc, the tests, swiftc and
// Gradle all see one ordinary tree. web/node_modules is linked to core's (or the layer's) node_modules.
// Writes <out>/ps-build.json (and a copy in web/): flavour, core commit, layer commits, the full profile, the features.
// Exits 1 with "STOP: ..." on anything unexpected; nothing is ever taken silently from one side.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PARTS = ["web", "mac", "phone"];
const SKIP_DIRS = new Set([".git", "node_modules", ".build", "build", ".gradle", "dist", "dist-ps", ".kotlin"]);

const stop = (msg) => { console.error(`assemble: STOP, ${msg}`); process.exit(1); };
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { maxBuffer: 1 << 30 }).toString();
const gitOk = (dir, ...a) => spawnSync("git", ["-C", dir, ...a], { maxBuffer: 1 << 30 });
export const blobOf = (file) => execFileSync("git", ["hash-object", "--no-filters", file]).toString().trim();

/** The files of a tree: git's tracked files when it is a repo (the working copy of each), else a walk. */
export function filesOf(dir) {
  const r = gitOk(dir, "ls-files", "-z", "--cached");
  if (r.status === 0 && existsSync(join(dir, ".git"))) {
    return r.stdout.toString().split("\0").filter((f) => f && existsSync(join(dir, f)) && !f.startsWith(".build/"));
  }
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (SKIP_DIRS.has(n)) continue;
      const p = join(d, n), st = lstatSync(p);
      if (st.isDirectory()) walk(p); else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out;
}

/** A layer list entry may be a glob (* within a name, ** for any folders), resolved in the layer's root. */
function expand(root, pattern) {
  if (!/[*?]/.test(pattern)) return [pattern];
  const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\u0001").replace(/\*\*/g, "\u0002")
    .replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0001/g, "(?:.*/)?").replace(/\u0002/g, ".*") + "$");
  const segs = pattern.split("/"), base = segs.slice(0, segs.findIndex((s) => /[*?]/.test(s))).join("/");
  if (!existsSync(join(root, base))) return [];
  return filesOf(join(root, base)).map((f) => (base ? base + "/" : "") + f).filter((f) => re.test(f)).sort();
}

/**
 * PS 1.71 (three releases never blended): what is wrong with a person's own build's update channel (null: nothing).
 * A layer build must follow a channel of its own, named in its profile: "local" (it never updates by itself; they
 * install each build), "url" (their own https folder) or "folder" (a folder in their own ~/Library/Application Support/,
 * where tools/follow.mjs stages each new version). With none, or "gsquad", the Mac app follows the G Squad channel and
 * the next G Squad release replaces it (their private features gone, macOS dropping its permissions).
 */
export function channelProblem(profile) {
  const ch = profile && typeof profile === "object" ? profile.channel : null;
  const kind = ch && typeof ch === "object" ? ch.kind : undefined;
  if (kind === "local") return null;
  if (kind === "url") {
    let u = null; try { u = new URL(ch.url); } catch { /* not an address */ }
    return u && u.protocol === "https:" && u.host && String(ch.url).endsWith("/") ? null : 'its channel "url" must be an https address ending in /';
  }
  if (kind === "folder") {
    const p = typeof ch.path === "string" ? ch.path : "";
    const inside = /^~\/Library\/Application Support\/[^/]/.test(p) || /^\/Users\/[^/]+\/Library\/Application Support\/[^/]/.test(p);
    return inside && p.endsWith("/") && !p.split("/").some((x) => x === "." || x === "..") ? null
      : 'its channel "folder" must be a folder in your own ~/Library/Application Support/, ending in /';
  }
  if (kind === "gsquad") return 'its channel is "gsquad"';
  return "it names no update channel";
}

export function readLayer(layerPath, rootOverrides = {}) {
  const file = resolve(layerPath);
  const L = JSON.parse(readFileSync(file, "utf8"));
  if (L.schema !== 1) stop(`${file}: unknown layer schema ${L.schema}`);
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(L.name || "")) stop(`${file}: the layer name must be a lowercase word`);
  if (L.name === "gsquad") stop(`${file}: "gsquad" is the shared build, not a layer name`);
  const roots = {};
  for (const p of PARTS) {
    const r = rootOverrides[p] || (L.roots && L.roots[p]) || p;
    roots[p] = isAbsolute(r) ? r : resolve(dirname(file), r);
  }
  const list = (k) => Object.fromEntries(PARTS.map((p) => [p, ((L[k] || {})[p] || []).flatMap((x) => expand(roots[p], x))]));
  return { file, dir: dirname(file), name: L.name, owner: L.owner || "", roots, replace: list("replace"), add: list("add"), remove: list("remove"),
    local: Object.fromEntries(PARTS.map((p) => [p, (L.local || {})[p] || []])), pinned: L.pinned || {}, audit: L.audit || null, raw: L };
}

function copy(from, to) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }

export function assemble({ core, layerPath, profilePath, out, rootOverrides = {}, repin = false, quiet = false }) {
  core = resolve(core);
  const say = quiet ? () => {} : (m) => console.log(`assemble: ${m}`);
  const L = layerPath ? readLayer(layerPath, rootOverrides) : null;
  const name = L ? L.name : "gsquad";
  out = resolve(out || join(core, ".build", name));
  if (out === core || !relative(out, core).startsWith("..")) stop("the out folder cannot be core or hold core");
  for (const p of PARTS) if (!existsSync(join(core, p))) stop(`core has no ${p}/ (${core})`);

  // Fresh tree each time, keeping only build caches the parts make themselves.
  if (existsSync(out)) for (const n of readdirSync(out)) rmSync(join(out, n), { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const coreFiles = filesOf(core).filter((f) => !f.startsWith(".build/"));
  for (const f of coreFiles) copy(join(core, f), join(out, f));
  const coreSet = new Set(coreFiles);
  let counts = { replace: 0, add: 0, remove: 0, pinned: 0, merged: 0, local: 0 };

  if (L) {
    for (const p of PARTS) {
      const root = L.roots[p];
      const need = L.replace[p].length + L.add[p].length + Object.keys(L.pinned).filter((k) => k.startsWith(p + "/")).length;
      if (need && !existsSync(root)) stop(`the layer's ${p} root is missing: ${root}`);
      for (const f of L.replace[p]) {
        if (!coreSet.has(`${p}/${f}`)) stop(`plug point gone: core has no ${p}/${f} for the layer to replace (update ${L.file})`);
        if (!existsSync(join(root, f))) stop(`the layer has no ${p}/${f} (${join(root, f)})`);
        copy(join(root, f), join(out, p, f)); counts.replace++;
      }
      for (const f of L.add[p]) {
        if (coreSet.has(`${p}/${f}`)) stop(`core now has ${p}/${f}, which the layer adds: decide (make it a plug point, a pinned override, or drop it from the layer)`);
        if (!existsSync(join(root, f))) stop(`the layer has no ${p}/${f} (${join(root, f)})`);
        copy(join(root, f), join(out, p, f)); counts.add++;
      }
      for (const f of L.remove[p]) {
        if (!coreSet.has(`${p}/${f}`)) stop(`the layer removes ${p}/${f}, which core no longer has (update ${L.file})`);
        rmSync(join(out, p, f)); counts.remove++;
      }
      // Local files (never committed anywhere): the layer's .env and the like, copied when they exist.
      for (const f of L.local[p]) if (existsSync(join(root, f))) { copy(join(root, f), join(out, p, f)); counts.local++; }
    }
    // Pinned overrides: the layer's own version of a core file, made against a known core blob.
    const pinsOut = { ...L.pinned };
    for (const [path, pin] of Object.entries(L.pinned)) {
      const p = path.split("/")[0], rel = path.slice(p.length + 1);
      if (!PARTS.includes(p)) stop(`pinned path must start with web/, mac/ or phone/: ${path}`);
      if (!coreSet.has(path)) stop(`core has no ${path} any more (pinned in ${L.file})`);
      const mine = join(L.roots[p], rel);
      if (!existsSync(mine)) stop(`the layer has no ${path} (${mine})`);
      const now = blobOf(join(core, path));
      if (now === pin) { copy(mine, join(out, path)); counts.pinned++; continue; }
      // Core moved on: three way merge (base: core at the pin, ours: the layer, theirs: core now).
      const base = gitOk(core, "cat-file", "blob", pin);
      if (base.status !== 0) stop(`${path} changed in core and its pinned base ${pin.slice(0, 10)} is not in core's history: merge it by hand, then pin ${now}`);
      const tmp = join(out, ".pin-base"); writeFileSync(tmp, base.stdout);
      const m = spawnSync("git", ["merge-file", "-p", "-L", "layer", "-L", "core at pin", "-L", "core now", mine, tmp, join(core, path)], { maxBuffer: 1 << 30 });
      rmSync(tmp);
      if (m.status !== 0) stop(`${path} changed in core and clashes with the layer's version (${m.status < 0 ? "merge failed" : m.status + " clash(es)"}): merge it by hand in ${mine}, then pin ${now}`);
      writeFileSync(join(out, path), m.stdout); counts.merged++;
      if (repin) { writeFileSync(mine, m.stdout); pinsOut[path] = now; say(`re-pinned ${path} (merged with core's change)`); }
      else say(`${path} changed in core and merged cleanly with the layer's version: run with --repin to keep the merge`);
    }
    if (repin && JSON.stringify(pinsOut) !== JSON.stringify(L.pinned)) {
      writeFileSync(L.file, JSON.stringify({ ...L.raw, pinned: pinsOut }, null, 2) + "\n");
    }
  }

  // node_modules for the web part: core's, else the layer's (never copied).
  const nm = [join(core, "web/node_modules"), L && join(L.roots.web, "node_modules")].find((d) => d && existsSync(d));
  if (nm) symlinkSync(nm, join(out, "web/node_modules"), "dir");
  else say("no web/node_modules in core or the layer: run npm ci in core's web/ first to build the web part");
  if (!existsSync(join(out, "web/.env")) && existsSync(join(out, "web/.env.example"))) copyFileSync(join(out, "web/.env.example"), join(out, "web/.env"));

  // The profile: the layer's, else core's G Squad one.
  const profileFile = profilePath ? resolve(profilePath) : L ? join(L.dir, "profile.json") : join(core, "profiles/gsquad.json");
  let profile;
  if (existsSync(profileFile)) profile = JSON.parse(readFileSync(profileFile, "utf8"));
  else { profile = { schema: 1, name }; say(`no profile at ${profileFile}: using { name: "${name}" } only`); }
  if (profile.name !== name) stop(`the profile is "${profile.name}" but this build is "${name}" (${profileFile})`);

  // The feature registry (profiles-158's format, { schema: 1, features: [...] }): core's shared list, then the layer's
  // private one. One merged array, so the built app reads one list and never needs the layer's folder.
  const reg = (f) => { if (!existsSync(f)) return []; const j = JSON.parse(readFileSync(f, "utf8")); return Array.isArray(j) ? j : Array.isArray(j.features) ? j.features : []; };
  const features = [...reg(join(core, "features.json")), ...(L ? reg(join(L.dir, "features.json")) : [])];

  const head = (d) => { const r = gitOk(d, "rev-parse", "HEAD"); return r.status === 0 ? r.stdout.toString().trim() : null; };
  const dirty = (d) => { const r = gitOk(d, "status", "--porcelain"); return r.status === 0 && r.stdout.length > 0; };
  const build = {
    flavour: name,
    core: head(core), coreDirty: dirty(core),
    layer: L ? { name: L.name, owner: L.owner, commits: Object.fromEntries(PARTS.map((p) => [p, head(L.roots[p])])) } : null,
    profile,
    features,
  };
  writeFileSync(join(out, "ps-build.json"), JSON.stringify(build, null, 2) + "\n");
  writeFileSync(join(out, "web/ps-build.json"), JSON.stringify(build, null, 2) + "\n");
  say(`${name}: ${coreFiles.length} core files${L ? `, layer replaced ${counts.replace}, added ${counts.add}, removed ${counts.remove}, pinned ${counts.pinned}${counts.merged ? `, merged ${counts.merged}` : ""}, local ${counts.local}` : ""} -> ${out}`);
  return { out, name, build };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = { core: resolve(dirname(fileURLToPath(import.meta.url)), ".."), rootOverrides: {} };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === "--layer") opt.layerPath = a[++i];
    else if (k === "--profile") opt.profilePath = a[++i];
    else if (k === "--out") opt.out = a[++i];
    else if (k === "--core") opt.core = a[++i];
    else if (k === "--root") { const [p, d] = a[++i].split("="); if (!PARTS.includes(p) || !d) stop(`--root takes web=<dir>, mac=<dir> or phone=<dir>`); opt.rootOverrides[p] = resolve(d); }
    else if (k === "--repin") opt.repin = true;
    else if (k === "--quiet") opt.quiet = true;
    else stop(`unknown option ${k}`);
  }
  assemble(opt);
}
