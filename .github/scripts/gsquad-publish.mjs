#!/usr/bin/env node
// Publishes a signed G Squad build to the G Squad channel (PS V1.58, release.yml, job "publish").
// The channel is the update repo every G Squad build asks (the design, section 5): a GitHub release named after the
// version, marked latest, holding exactly the files the update notes name. Every file is checked against the size and
// SHA-256 its note gives before anything goes up. Signs nothing: PS checks the signatures on the Mac and the phone.
//
//   node gsquad-publish.mjs <signed folder> <tag> [--dry-run]
//     <signed folder> holds ps-release/ (from gsquad-sign-mac.sh) and gos-release/ (from gsquad-sign-phone.sh)
// Env: PS_CHANNEL_REPO (owner/name of the update repo), GH_TOKEN (the bot's token for that repo only).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const [dir, tag, ...rest] = process.argv.slice(2);
const dry = rest.includes("--dry-run");
const REPO = process.env.PS_CHANNEL_REPO || "";
const stop = (why) => { console.error(`STOP (G Squad channel): ${why}`); process.exit(1); };
if (!dir || !/^v\d{1,3}\.\d{2,3}$/.test(tag || "")) stop("usage: node gsquad-publish.mjs <signed folder> <tag v1.59> [--dry-run]");
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(REPO)) stop("PS_CHANNEL_REPO is not set (owner/name)");

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const sha256 = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
function named(base, file, size, sha, what) {
  if (typeof file !== "string" || !file) stop(`${what}: the note names no file`);
  const name = basename(file);
  if (!NAME.test(name)) stop(`${what}: strange file name ${JSON.stringify(file)}`);
  const from = join(base, file);
  if (!existsSync(from)) stop(`${what}: ${from} is missing`);
  if (statSync(from).size !== size) stop(`${what}: ${from} is not the size the note says`);
  if (sha256(from) !== String(sha).toLowerCase()) stop(`${what}: ${from} does not match the note's SHA-256`);
  return { from, name };
}

// The Mac: the signed note and the two zips it names.
const pub = join(dir, "ps-release"), gos = join(dir, "gos-release");
const noteFile = join(pub, "ps-update.json");
if (!existsSync(noteFile)) stop(`${noteFile} is missing`);
const signed = JSON.parse(Buffer.from(String(readJson(noteFile).signed || ""), "base64").toString("utf8"));
if (signed.format !== 1 || !signed.web || !signed.app) stop("ps-update.json is not a PS app update note");
if (signed.name && signed.name !== `V${tag.slice(1)}`) stop(`ps-update.json is for ${signed.name}, the tag is ${tag}`);
const assets = [
  { from: noteFile, name: "ps-update.json" },
  named(pub, signed.app.file, signed.app.size, signed.app.sha256, "Mac app"),
  named(pub, signed.web.file, signed.web.size, signed.web.sha256, "Mac web files"),
];
if (existsSync(join(pub, "PS.dmg"))) assets.push({ from: join(pub, "PS.dmg"), name: "PS.dmg" });

// The phone: its note (as gos-version.json) and the APK it names.
const gv = join(gos, "version.json");
if (!existsSync(gv)) stop(`${gv} is missing`);
const g = readJson(gv);
if (!Number.isInteger(g.versionCode) || g.versionName !== `V${tag.slice(1)}`) stop(`gos-release/version.json is not the phone note for ${tag}`);
if (!/^[A-Za-z0-9._-]+\.apk$/.test(String(g.apk || ""))) stop("gos-release/version.json names a strange APK");
assets.push({ from: gv, name: "gos-version.json" });
assets.push(named(gos, g.apk, g.size, g.sha256, "phone APK"));

const names = assets.map((a) => a.name);
if (new Set(names).size !== names.length) stop(`two files would have the same name: ${names.join(", ")}`);
const title = `PS ${g.versionName}${g.keyword ? ` · ${g.keyword}` : ""}`;
// The release text: only the approved notes the build carried (no new words are written here).
const notes = Array.isArray(signed.notes) ? signed.notes.join("\n") : "";

const run = dry
  ? (args) => { console.log(`DRY  gh ${args.join(" ")}`); if (args[1] === "view") throw new Error("dry"); return ""; }
  : (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const tmp = mkdtempSync(join(tmpdir(), "gsquad-channel-"));
try {
  const files = assets.map((a) => { const to = join(tmp, a.name); copyFileSync(a.from, to); return to; });
  const notesFile = join(tmp, "notes.txt"); writeFileSync(notesFile, notes);
  let exists = true;
  try { run(["release", "view", tag, "--repo", REPO, "--json", "tagName"]); } catch { exists = false; }
  if (exists) {
    // A run again after a failed upload: the same files replaced, the release marked latest.
    run(["release", "upload", tag, ...files, "--repo", REPO, "--clobber"]);
    run(["release", "edit", tag, "--repo", REPO, "--latest", "--title", title, "--notes-file", notesFile]);
  } else {
    run(["release", "create", tag, ...files, "--repo", REPO, "--latest", "--title", title, "--notes-file", notesFile]);
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
for (const a of assets) console.log(`  ${a.name}`);

// GitHub's "latest" note must now be this one, byte for byte (it can answer 404 for a few seconds).
if (!dry) {
  const want = readFileSync(noteFile);
  let status = 0, ok = false;
  for (let i = 0; i < 12 && !ok; i++) {
    if (i) await new Promise((r) => setTimeout(r, 10_000));
    const r = await fetch(`https://github.com/${REPO}/releases/latest/download/ps-update.json`, { cache: "no-store" });
    status = r.status;
    ok = r.ok && Buffer.from(await r.arrayBuffer()).equals(want);
  }
  if (!ok) stop(`GitHub's latest ps-update.json is not the one just published (HTTP ${status})`);
}
console.log(`G Squad channel: ${tag} "${title}" ${dry ? "would be" : "is"} the latest release of ${REPO}.`);
