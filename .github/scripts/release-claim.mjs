#!/usr/bin/env node
// Is this tag a shared release the G Squad build should make? (PS V1.58, the design, sections 4 and 5)
//
//   node release-claim.mjs <git checkout of main, with tags> <tag> [<commit the tag must point at>]
//
// Yes only when ALL hold:
//   the tag is v<major>.<minor> and annotated (tools/claim-version.mjs makes it so);
//   its message is JSON { "by": "<name>", "kind": "shared", "at": "<ISO time>" };
//   it points at a commit that is on main (so the commit came through a pull request and passed every check);
//   when a commit is given (the tag push that started the run), the tag still points at exactly that commit.
// A "private" tag is a fine claim that simply has no G Squad build: it prints build=false and exits 0.
// Anything else stops the release (exit 1). Prints key=value lines for $GITHUB_OUTPUT.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const [dir, tag, want] = process.argv.slice(2);
if (!dir || !tag) { console.error("usage: node release-claim.mjs <checkout> <tag> [<commit>]"); process.exit(2); }
const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
const stop = (why) => { console.log(`STOP: ${why}`); process.exit(1); };
const out = (kv) => {
  const text = Object.entries(kv).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  process.stdout.write(text);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
};

const m = /^v(\d{1,3})\.(\d{2,3})$/.exec(tag);
if (!m) stop(`"${tag}" is not a version tag (v1.59)`);
let type;
try { type = git("cat-file", "-t", `refs/tags/${tag}`); } catch { stop(`the tag ${tag} is not in the repo`); }
if (type !== "tag") stop(`${tag} is a plain tag; a version is claimed with an annotated tag (tools/claim-version.mjs)`);
const commit = git("rev-parse", `refs/tags/${tag}^{commit}`);
if (want && want !== commit) stop(`${tag} points at ${commit}, not at ${want} (the tag moved; tags are never moved)`);

// The message: the annotated tag's text after its header.
const raw = git("cat-file", "tag", `refs/tags/${tag}`);
const body = raw.slice(raw.indexOf("\n\n") + 2).replace(/-----BEGIN [A-Z ]*SIGNATURE-----[\s\S]*$/, "").trim();
let msg;
try { msg = JSON.parse(body); } catch { stop(`${tag}: the tag message is not the JSON claim-version.mjs writes`); }
if (!msg || typeof msg !== "object") stop(`${tag}: the tag message is not an object`);
if (!/^[a-z][a-z0-9-]{0,30}$/.test(String(msg.by || ""))) stop(`${tag}: "by" must be a profile name (a lowercase word)`);
if (msg.kind !== "shared" && msg.kind !== "private") stop(`${tag}: "kind" must be "shared" or "private"`);
if (msg.kind === "private") {
  console.log(`${tag} is a private release by ${msg.by}: nothing to build here (it is built on their own Mac).`);
  out({ build: "false", tag, by: msg.by });
  process.exit(0);
}

// On main: the tagged commit is main itself or one of its ancestors.
const main = git("rev-parse", "refs/remotes/origin/main");
try { execFileSync("git", ["-C", dir, "merge-base", "--is-ancestor", commit, main]); }
catch { stop(`${tag} points at ${commit}, which is not on main: only merged code is released`); }

const version = `${Number(m[1])}.${m[2]}`;
console.log(`${tag}: a shared release by ${msg.by} of ${commit} (on main)`);
out({ build: "true", tag, sha: commit, version, by: msg.by });
