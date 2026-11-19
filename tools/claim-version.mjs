// Claims the next PS version number for everyone (V1.58, multiple developers).
// One number for all builds: V1.59, V1.60, ... The claim is an annotated git tag v<version> on the shared repo
// (RedbyPS/ps-app). A tag that already exists cannot be pushed again (this never uses --force), so two people can
// never get the same number: the one who pushes second is refused, fetches again and takes the next number.
//
//   node tools/claim-version.mjs --by jan --kind private|shared [--remote origin] [--commit HEAD]
//                                [--floor 1.57] [--version 1.69] [--keywords web/scripts/ps-keywords.json] [--dry-run] [--json]
//
//   --by        who makes the release: a profile name (lowercase, "gsquad" for the shared build)
//   --kind      private (only that person's build gets it) or shared (the G Squad build gets it)
//   --remote    the shared repo, a remote name or a URL (default origin)
//   --commit    the core commit the tag points at (default HEAD)
//   --floor     never claim at or below this version (the version in web/ps-version.json, say)
//   --keywords  a keyword list ({"1": ["Beginnings", ...], ...}): the release gets the first name of its number
//               that no earlier tag carried. Names never repeat and are never "Truth".
//   --version   claim exactly this number (1.69) or stop: never the next one. For a release whose number is already
//               fixed elsewhere (the developer's own build carries it), so the G Squad build gets the same number.
//               When the tag is already there as the same maker's claim of the same kind, nothing is pushed again.
//   --dry-run   fetches and prints what it would claim; makes no tag and pushes nothing
//   --json      prints {"version","tag","by","kind","at","name"} instead of the number alone
//
// The tag message is JSON and holds only {"by","kind","at"} and the release name, never any notes: a private
// release shows up on the shared repo as a number, a name, who and when, nothing else.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TAG = /^v(\d{1,3})\.(\d{2})$/;
export const BY = /^[a-z][a-z0-9-]{0,30}$/;
export const KINDS = ["private", "shared"];
/** Release names that may never be used again ("Truth" was given once and taken back). */
export const BANNED = [/^truth\b/i];

/** "1.59" as 159; 0 when it is not a version. */
export function hundredths(v) {
  const m = TAG.exec(`v${String(v).replace(/^v/, "")}`);
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
}
/** 159 as "1.59". */
export function fromHundredths(n) { return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, "0")}`; }

/** The tag message as written by a claim: {by, kind, at, name?}. Anything else (a plain tag, old text) gives null. */
export function parseMessage(text) {
  try {
    const o = JSON.parse(String(text || "").trim());
    if (!o || typeof o !== "object" || typeof o.by !== "string" || !BY.test(o.by) || !KINDS.includes(o.kind)) return null;
    return { by: o.by, kind: o.kind, at: typeof o.at === "string" ? o.at : "", ...(typeof o.name === "string" && o.name ? { name: o.name } : {}) };
  } catch { return null; }
}

/** The next free version: one above the highest tag and above the floor. */
export function nextVersion(taken, floor) {
  const top = Math.max(0, hundredths(floor || "0"), ...taken.map(hundredths));
  return fromHundredths(top + 1);
}

export function banned(name) { return BANNED.some((r) => r.test(String(name || "").trim())); }

/** The keyword number of a version: the part after the dot, reduced unless it is 11, 22 or 33. */
export function numberOf(version) {
  let n = Number(String(version).split(".")[1] || 0);
  while (n > 9 && ![11, 22, 33].includes(n)) n = String(n).split("").reduce((a, d) => a + Number(d), 0);
  return n;
}
/** The first word of the version's number that is not used and not banned; past the list, "Wisdom II", "Wisdom III"... */
export function keywordFor(words, version, used) {
  const list = (words && words[String(numberOf(version))]) || [];
  const taken = new Set([...(used || [])].map((w) => String(w).toLowerCase()));
  for (let round = 1; round < 50; round++) {
    const roman = ["", "", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][round];
    const suffix = round === 1 ? "" : ` ${roman || round}`;
    for (const w of list) {
      const name = w + suffix;
      if (!taken.has(name.toLowerCase()) && !banned(name)) return name;
    }
  }
  return "";
}

/** Runs git in `cwd`; returns its output, throws with git's own words on failure. */
export function gitIn(cwd) {
  return (args) => {
    try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { throw new Error(String(e.stderr || e.message).trim() || `git ${args[0]} failed`); }
  };
}

/** Every v* tag the shared repo has, fetched fresh (stale local ones go), with its parsed message. */
export function readTags(git, remote) {
  git(["fetch", "--quiet", "--no-tags", "--prune", remote, "+refs/tags/v*:refs/tags/v*"]);
  const out = git(["for-each-ref", "--format=%(refname:strip=2)%00%(contents)%00%00", "refs/tags/v*"]);
  return out.split("\0\0").map((s) => s.replace(/^\n/, "")).filter(Boolean).map((rec) => {
    const [tag, msg] = rec.split("\0");
    return { tag: tag.trim(), msg: parseMessage(msg) };
  }).filter((t) => TAG.test(t.tag));
}

/**
 * Claims the next number. `git(args)` runs git in a repository that can reach `remote` and has `commit`.
 * `pickName(version, usedNames)` names the release (optional). Returns {version, tag, by, kind, at, name, tries}.
 * A refused push (someone took the number first) fetches again and tries the next one, up to `tries` times.
 * Any other failure (no network, no rights) stops with git's words: nothing is left behind locally.
 */
export function claim({ git, remote = "origin", commit = "HEAD", by, kind, floor = "", exact = "", pickName, dryRun = false, now = () => new Date(), tries = 20, log = () => {} }) {
  if (typeof by !== "string" || !BY.test(by)) throw new Error(`--by must be a profile name like "jan" (lowercase), not ${JSON.stringify(by)}`);
  if (!KINDS.includes(kind)) throw new Error(`--kind must be private or shared, not ${JSON.stringify(kind)}`);
  if (exact && !hundredths(exact)) throw new Error(`--version must be a version like 1.69, not ${JSON.stringify(exact)}`);
  const sha = git(["rev-parse", "--verify", `${commit}^{commit}`]).trim();
  for (let attempt = 1; attempt <= tries; attempt++) {
    const tags = readTags(git, remote);
    const version = exact ? fromHundredths(hundredths(exact)) : nextVersion(tags.map((t) => t.tag.slice(1)), floor);
    if (exact) {
      // Exactly this number or nothing. Already ours (same maker, same kind): done, nothing pushed again.
      const there = tags.find((t) => t.tag === `v${version}`);
      if (there) {
        if (there.msg && there.msg.by === by && there.msg.kind === kind) {
          log(`v${version} is already claimed by ${by} (${kind}); nothing pushed again`);
          return { version, tag: `v${version}`, by, kind, at: there.msg.at, name: there.msg.name || "", commit: git(["rev-parse", `refs/tags/v${version}^{commit}`]).trim(), tries: attempt, already: true };
        }
        throw new Error(`v${version} is already taken${there.msg ? ` by ${there.msg.by} (${there.msg.kind})` : ""}; it is never claimed twice`);
      }
      if (hundredths(version) <= hundredths(floor || "0")) throw new Error(`v${version} is not above ${floor}`);
    }
    const tag = `v${version}`;
    const used = tags.map((t) => t.msg && t.msg.name).filter(Boolean);
    const name = pickName ? String(pickName(version, used) || "") : "";
    if (name && banned(name)) throw new Error(`the name ${name} may not be used`);
    if (name && used.some((u) => u.toLowerCase() === name.toLowerCase())) throw new Error(`the name ${name} was used before`);
    const at = now().toISOString();
    const message = JSON.stringify({ by, kind, at, ...(name ? { name } : {}) });
    const result = { version, tag, by, kind, at, name, commit: sha, tries: attempt };
    if (dryRun) { log(`dry run: would claim ${tag}${name ? ` (${name})` : ""} on ${sha.slice(0, 12)} for ${by}, ${kind}`); return result; }
    git(["tag", "-a", tag, "-m", message, sha]);
    try {
      git(["push", "--quiet", "--no-verify", remote, `refs/tags/${tag}:refs/tags/${tag}`]);
    } catch (e) {
      try { git(["tag", "-d", tag]); } catch { /* already gone */ }
      // Refused because the number was taken in the meantime: the next fetch sees it, so the loop moves on.
      // Anything else (offline, no rights): stop here with git's own words.
      const again = readTags(git, remote);
      if (!again.some((t) => t.tag === tag)) throw new Error(`could not push ${tag}: ${e.message}`);
      if (exact) throw new Error(`${tag} was just taken by someone else; it is never claimed twice`);
      log(`${tag} was just taken by someone else; trying the next number`);
      continue;
    }
    // The push went through: the shared repo's tag must be ours (an identical object would also "succeed").
    const theirs = git(["ls-remote", remote, `refs/tags/${tag}`]).trim().split(/\s+/)[0];
    const ours = git(["rev-parse", `refs/tags/${tag}`]).trim();
    if (theirs !== ours) throw new Error(`${tag} on the shared repo is not the one just made`);
    return result;
  }
  throw new Error(`no free version number after ${tries} tries`);
}

function args(argv) {
  const o = { remote: "origin", commit: "HEAD", floor: "", exact: "", keywords: "", dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === "--by") o.by = val();
    else if (a === "--kind") o.kind = val();
    else if (a === "--remote") o.remote = val();
    else if (a === "--commit") o.commit = val();
    else if (a === "--floor") o.floor = val();
    else if (a === "--version") o.exact = val();
    else if (a === "--keywords") o.keywords = val();
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--json") o.json = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

const isMain = !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  try {
    const o = args(process.argv.slice(2));
    const words = o.keywords ? JSON.parse(readFileSync(o.keywords, "utf8")) : null;
    const r = claim({ git: gitIn(process.cwd()), remote: o.remote, commit: o.commit, by: o.by, kind: o.kind, floor: o.floor, exact: o.exact,
      pickName: words ? (v, used) => keywordFor(words, v, used) : undefined, dryRun: o.dryRun, log: (s) => console.error(s) });
    process.stdout.write((o.json ? JSON.stringify({ version: r.version, tag: r.tag, by: r.by, kind: r.kind, at: r.at, name: r.name }) : r.version) + "\n");
  } catch (e) {
    console.error(`STOP (claim version): ${e.message}`);
    process.exit(1);
  }
}
