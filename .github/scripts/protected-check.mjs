#!/usr/bin/env node
// The "protected files" check (PS V1.58). Pull requests merge by themselves once every check passes, so the checks
// and the release machinery must not be changeable by those same pull requests. A pull request that touches one of
// the files below passes only when it comes from a branch of this repo whose name starts with the owner's prefix
// ("red/"), and a ruleset lets only the developer push such branches. Everything else in core stays open to everyone.
//
//   node protected-check.mjs <pr checkout> <base sha> <head sha> <head ref> <head repo> <base repo> <owner prefix>
//
// Reads git only; runs nothing from the pull request.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROTECTED = [
  ".github/**",              // the workflows and these scripts
  ".gitleaks.toml",          // what gitleaks lets through
  "mac/release/audit.py",    // the BLOCK list
  "mac/release/publish.sh",  // runs next to the update signing key in the release
  "mac/release/dmg/**",      // runs next to the update signing key in the release
  "mac/tools/pstool.swift",  // signs the update note in the release
  "mac/ps.entitlements",     // what the signed app may do (hardened runtime exceptions)
  "layers/plugpoints.json",  // which core files must stay placeholders
];

const globRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0002")
  .replace(/\*/g, "[^/]*").replace(/\u0002/g, ".*") + "$");
const RES = PROTECTED.map((g) => ({ g, re: globRe(g) }));
export const protectedHits = (paths) => paths.flatMap((p) => RES.filter((r) => r.re.test(p)).map((r) => ({ path: p, rule: r.g })));

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [dir, base, head, headRef, headRepo, baseRepo, prefix] = process.argv.slice(2);
  if (!dir || !base || !head || !headRef || !headRepo || !baseRepo || !prefix) {
    console.error("usage: node protected-check.mjs <pr checkout> <base sha> <head sha> <head ref> <head repo> <base repo> <owner prefix>");
    process.exit(2);
  }
  // Every path the pull request adds, changes, removes or renames (both names of a rename).
  const out = execFileSync("git", ["-C", dir, "diff", "--name-status", "-z", "--no-renames", `${base}...${head}`]).toString();
  const parts = out.split("\0").filter(Boolean);
  const paths = [];
  for (let i = 0; i < parts.length; i += 2) paths.push(parts[i + 1]);
  const hits = protectedHits(paths);
  if (!hits.length) { console.log(`protected files: none touched (${paths.length} files changed)`); process.exit(0); }
  const owner = headRepo === baseRepo && headRef.startsWith(prefix);
  for (const h of hits) console.log(`${owner ? "OK   " : "BLOCK"} ${h.path} (protected: ${h.rule})`);
  if (owner) { console.log(`protected files: changed from ${headRef}, an owner branch`); process.exit(0); }
  console.log(`protected files: these change the checks or the release, so they only come from a "${prefix}" branch of ${baseRepo}.`);
  console.log("Take them out of this pull request (git checkout origin/main -- <file>) or ask the developer to make the change.");
  process.exit(1);
}
