#!/usr/bin/env node
// Checks on a core tree that read files and never run them (PS V1.58, the multiple developers design, section 7).
// The pull request safety workflow runs this from main's copy against the pull request's files, so a pull request
// can not change the checks that judge it.
//
//   node tree-check.mjs terms      <tree>   words and paths from the private list (PS_PRIVATE_TERMS_FILE) must not appear
//   node tree-check.mjs paths      <tree>   no personal paths (/Users/<name>/...), no key or env files, no layer files
//                                           (example names such as /Users/you/ or one letter, /Users/x/, are fine)
//   node tree-check.mjs dashes     <tree>   no long dashes (U+2013, U+2014) in any text file outside the tests
//   node tree-check.mjs plugpoints <tree>   every plug point in layers/plugpoints.json is still a placeholder
//   node tree-check.mjs registry   <tree>   features.json is sound and matches the feature ids the code asks for
//
// <tree> is a plain folder (git archive of the commit), not a checkout: .git is never read.
// Exit 0 clean, 1 with findings, 2 on wrong use. A term is never printed (the logs of a public repo are public):
// a hit says the file, the line and the term's line number in the secret.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const [check, tree, ...flags] = process.argv.slice(2);
if (!check || !tree || !existsSync(tree)) {
  console.error("usage: node tree-check.mjs terms|paths|dashes|plugpoints|registry <tree>");
  process.exit(2);
}

/** Every file under the tree (relative paths with "/"), symlinks reported as themselves. */
function files(root) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isDirectory()) { if (n !== ".git") walk(p); } else out.push(relative(root, p).split(sep).join("/"));
    }
  };
  walk(root);
  return out;
}
const read = (f) => readFileSync(join(tree, f));
const isText = (buf) => !buf.subarray(0, 8192).includes(0);
const lineOf = (s, i) => s.slice(0, i).split("\n").length;
/** A simple glob: * within a name, ** for any folders, ? one character. */
const globRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\u0001").replace(/\*\*/g, "\u0002")
  .replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0001/g, "(?:.*/)?").replace(/\u0002/g, ".*") + "$", "i");

const findings = [];
const hit = (msg) => { findings.push(msg); };
const done = (what) => {
  if (findings.length) {
    for (const f of findings.slice(0, 200)) console.log(`BLOCK ${f}`);
    if (findings.length > 200) console.log(`... and ${findings.length - 200} more`);
    console.log(`${what}: ${findings.length} finding${findings.length === 1 ? "" : "s"}`);
    process.exit(1);
  }
  console.log(`${what}: clean`);
  process.exit(0);
};

/** Many words at once over one text (Aho-Corasick): every word's first position, in one pass. Words are lowercase;
 *  the text is lowercased latin1, so any byte sequence works. */
function matcher(words) {
  const next = [new Map()], fail = [0], out = [[]];
  words.forEach((w, wi) => {
    let st = 0;
    for (const ch of w) {
      let n = next[st].get(ch);
      if (n === undefined) { n = next.length; next.push(new Map()); fail.push(0); out.push([]); next[st].set(ch, n); }
      st = n;
    }
    out[st].push(wi);
  });
  const queue = [];
  for (const n of next[0].values()) queue.push(n);
  for (let qi = 0; qi < queue.length; qi++) {
    const st = queue[qi];
    for (const [ch, n] of next[st]) {
      let f = fail[st];
      while (f && !next[f].has(ch)) f = fail[f];
      const g = next[f].get(ch);
      fail[n] = g !== undefined && g !== n ? g : 0;
      if (out[fail[n]].length) out[n] = out[n].concat(out[fail[n]]);
      queue.push(n);
    }
  }
  return (text) => {
    const found = new Map();
    let st = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      while (st && !next[st].has(ch)) st = fail[st];
      st = next[st].get(ch) ?? 0;
      for (const wi of out[st]) if (!found.has(wi)) found.set(wi, i - words[wi].length + 1);
    }
    return found;
  };
}

if (check === "terms") {
  // The list: PS_PRIVATE_TERMS_FILE (a file, for the full list) or PS_PRIVATE_TERMS (the text itself). One entry per
  // line: "path:<glob>" blocks a file path; any other line is a word or phrase, matched anywhere in a file's bytes or
  // its path, ignoring case. Blank lines and lines starting with # are skipped.
  const raw = process.env.PS_PRIVATE_TERMS_FILE
    ? (existsSync(process.env.PS_PRIVATE_TERMS_FILE) ? readFileSync(process.env.PS_PRIVATE_TERMS_FILE, "utf8") : "")
    : process.env.PS_PRIVATE_TERMS || "";
  // Each entry keeps its line number in the list, so a hit can be found there without printing the term.
  const lines = raw.split(/\r?\n/).map((s, i) => ({ s: s.trim(), n: i + 1 })).filter((l) => l.s && !l.s.startsWith("#"));
  if (!lines.length && !flags.includes("--allow-empty")) {
    console.log("BLOCK the private word list is empty or not set: nothing could be checked");
    process.exit(1);
  }
  const words = [], globs = [];
  for (const { s: l, n } of lines) {
    if (l.toLowerCase().startsWith("path:")) globs.push({ n, re: globRe(l.slice(5).trim()) });
    else words.push({ n, w: l.toLowerCase() });
  }
  // Text files are read as text (so any language lowercases right); other files byte by byte, where only A to Z is
  // lowercased and each word is looked for as its UTF-8 bytes.
  const findText = matcher(words.map((w) => w.w));
  const findBytes = matcher(words.map((w) => Buffer.from(w.w, "utf8").toString("latin1")));
  const asciiLower = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
  for (const f of files(tree)) {
    for (const g of globs) if (g.re.test(f)) hit(`${f}: a private file path (term on line ${g.n})`);
    for (const wi of findText(f.toLowerCase()).keys()) hit(`${f}: the path holds a private term (term on line ${words[wi].n})`);
    const buf = read(f);
    if (isText(buf)) {
      const text = buf.toString("utf8").toLowerCase();
      for (const [wi, at] of findText(text)) hit(`${f}:${lineOf(text, at)}: a private term (term on line ${words[wi].n})`);
    } else {
      for (const wi of findBytes(asciiLower(buf.toString("latin1"))).keys()) hit(`${f}: a private term in a binary file (term on line ${words[wi].n})`);
    }
  }
  done(`term audit (${words.length} terms, ${globs.length} paths)`);
}

if (check === "paths") {
  // Placeholder user names that docs and tests may use in an example path.
  const OK_USERS = new Set(["you", "me", "runner", "user", "username", "name", "example", "someone", "shared", "yourname", "your-name", "person", "other"]);
  const PERSONAL = /(?:\/Users|\/home)\/([A-Za-z0-9._-]+)(?=\/)|[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)(?=\\)/g;
  // Files that never belong in core: keys, keystores, env files, local settings, any layer's own folder, assembled trees.
  const NEVER = [
    "**/.env", "**/.env.*", "**/*.key", "**/*.pem", "**/*.p12", "**/*.pfx", "**/*.jks", "**/*.keystore",
    "**/*.keychain-db", "**/*.mobileprovision", "**/keystore.properties", "**/local.properties", "**/.keychain-pass",
    "**/ps-layer/**", "**/terms.json", ".build/**", "**/.claude/**", "**/node_modules/**",
  ].map((g) => ({ g, re: globRe(g) }));
  const ENV_OK = /\.env\.example$/i;
  for (const f of files(tree)) {
    for (const n of NEVER) if (n.re.test(f) && !ENV_OK.test(f)) hit(`${f}: this kind of file never goes into core (${n.g})`);
    const buf = read(f);
    if (!isText(buf)) continue;
    const s = buf.toString("utf8");
    for (const m of s.matchAll(PERSONAL)) {
      const who = (m[1] || m[2] || "").toLowerCase();
      if (!OK_USERS.has(who) && who.length > 1) hit(`${f}:${lineOf(s, m.index)}: a personal path (${m[0].replace(/[A-Za-z0-9._-]+$/, "<name>")})`);
    }
  }
  done("personal paths and private files");
}

if (check === "dashes") {
  // Tests may hold long dashes on purpose (they prove the rule), and so may a check written as a character class.
  const TEST = /(^|\/)(tests?|__tests__)\/|\.test\.[a-z]+$/;
  for (const f of files(tree)) {
    if (TEST.test(f)) continue;
    const buf = read(f);
    if (!isText(buf)) continue;
    const s = buf.toString("utf8").replace(/\[[\u2013\u2014]+\]/g, "[]");
    const re = /[\u2013\u2014]/g;
    let m, n = 0;
    while ((m = re.exec(s)) && n < 5) { hit(`${f}:${lineOf(s, m.index)}: a long dash (house rule: no em or en dashes)`); n++; }
  }
  done("no long dashes");
}

if (check === "plugpoints") {
  // A plug point is a core placeholder a layer may replace. In core it must stay the placeholder: real code there is a
  // layer's private file that slipped in.
  const MARK = "Left out of the public source";
  const list = join(tree, "layers", "plugpoints.json");
  if (!existsSync(list)) { console.log("BLOCK layers/plugpoints.json is missing (the list of plug points)"); process.exit(1); }
  let j;
  try { j = JSON.parse(readFileSync(list, "utf8")); } catch (e) { console.log(`BLOCK layers/plugpoints.json is not JSON (${e.message})`); process.exit(1); }
  // The shape tools/assemble.mjs reads: { "schema": 1, "web": [...], "mac": [...], "phone": [...] }, each path relative
  // to its part's folder.
  const PARTS = ["web", "mac", "phone"];
  if (!j || typeof j !== "object" || Array.isArray(j) || j.schema !== 1) { console.log("BLOCK layers/plugpoints.json: schema 1 with web, mac and phone lists expected"); process.exit(1); }
  const entries = [];
  for (const part of PARTS) {
    if (j[part] === undefined) continue;
    if (!Array.isArray(j[part])) { hit(`layers/plugpoints.json: "${part}" is not a list`); continue; }
    for (const p of j[part]) entries.push({ part, p });
  }
  if (!entries.length) { console.log("BLOCK layers/plugpoints.json lists no plug points"); process.exit(1); }
  for (const { part, p } of entries) {
    if (typeof p !== "string" || !p || p.startsWith("/") || p.split("/").includes("..")) { hit(`layers/plugpoints.json: a strange ${part} entry ${JSON.stringify(p)}`); continue; }
    const f = `${part}/${p}`;
    if (!existsSync(join(tree, f))) { hit(`${f}: the plug point is gone from core`); continue; }
    const head = read(f).subarray(0, 4000).toString("utf8");
    if (!head.includes(MARK)) hit(`${f}: a plug point no longer starts as a placeholder ("${MARK}"); real code here belongs in a layer`);
  }
  done(`plug points (${entries.length})`);
}

if (check === "registry") {
  const reg = join(tree, "features.json");
  if (!existsSync(reg)) { console.log("BLOCK features.json is missing (the shared feature registry)"); process.exit(1); }
  let j;
  try { j = JSON.parse(readFileSync(reg, "utf8")); } catch (e) { console.log(`BLOCK features.json is not JSON (${e.message})`); process.exit(1); }
  if (j.schema !== 1 || !Array.isArray(j.features)) { console.log("BLOCK features.json: schema 1 with a features list expected"); process.exit(1); }
  const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, WHO = /^[a-z][a-z0-9-]{0,30}$/, VER = /^\d+\.\d+$/;
  const seen = new Map();
  const later = (a, b) => { const [x1, y1] = a.split(".").map(Number), [x2, y2] = b.split(".").map(Number); return x1 > x2 || (x1 === x2 && y1 >= y2); };
  for (const f of j.features) {
    const id = f && f.id;
    if (typeof id !== "string" || !ID.test(id)) { hit(`features.json: a bad id ${JSON.stringify(id)} (lowercase words with hyphens)`); continue; }
    if (seen.has(id)) hit(`features.json: the id "${id}" is there twice`);
    seen.set(id, f);
    if (f.scope !== "shared") hit(`features.json: "${id}" has scope ${JSON.stringify(f.scope)}; core lists shared features only (private ones live in a layer)`);
    if (typeof f.owner !== "string" || !WHO.test(f.owner)) hit(`features.json: "${id}" has a bad owner ${JSON.stringify(f.owner)}`);
    if (typeof f.name !== "string" || !f.name.trim()) hit(`features.json: "${id}" has no name`);
    if (f.since !== undefined && !VER.test(String(f.since))) hit(`features.json: "${id}" has a bad since ${JSON.stringify(f.since)}`);
    if (f.default !== undefined && f.default !== "on" && f.default !== "off") hit(`features.json: "${id}" default must be "on" or "off"`);
  }
  // Where the code asks: web feature("id"), Mac Features.on("id"), phone Features.on(ctx, "id"). Tests are left out.
  const ASKS = [
    { dir: "web/src", re: /(?<![\w.$])feature\(\s*["'`]([^"'`]+)["'`]/g },
    { dir: "mac/Sources", re: /\bFeatures\.on\(\s*"([^"]+)"/g },
    { dir: "phone/app/src/main", re: /\bFeatures\.on\(\s*[A-Za-z_][\w.]*\s*,\s*"([^"]+)"/g },
  ];
  const used = new Map();
  for (const f of files(tree)) {
    const a = ASKS.find((x) => f.startsWith(x.dir + "/"));
    if (!a || /(^|\/)(tests?|__tests__)\//.test(f) || /\.test\.[a-z]+$/.test(f)) continue;
    const buf = read(f);
    if (!isText(buf)) continue;
    const s = buf.toString("utf8");
    for (const m of s.matchAll(a.re)) if (!used.has(m[1])) used.set(m[1], `${f}:${lineOf(s, m.index)}`);
  }
  for (const [id, where] of used) if (!seen.has(id)) hit(`${where}: asks for the feature "${id}", which is not in features.json`);
  for (const [id, f] of seen) {
    if (f.owner !== "core" && f.since && later(String(f.since), "1.58") && !used.has(id)) hit(`features.json: "${id}" (since ${f.since}) is not asked for anywhere in the code`);
  }
  done(`feature registry (${seen.size} features, ${used.size} asked for)`);
}

console.error(`unknown check "${check}"`);
process.exit(2);
