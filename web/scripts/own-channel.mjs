// A person's own update channel for their private Mac build (V1.69; the developer, 18 Nov 2026, after the G Squad's V1.68
// reached his Mac and macOS dropped Accessibility and Input Monitoring: "The developer's Mac must get only the developer's own releases").
// The channel is in the person's layer profile (the developer's: ps-layer/profile.json, never exported): {"kind": "url", "url":
// "https://<host>/client/ps/<unlisted folder>/"}. From it:
//  - ps-mac build.sh writes PS.app/Contents/Resources/channel.json (the channel ALONE; Sources/UpdateCore.swift,
//    UpdateRoute.resolve), so the app follows that channel and trusts only its maker's key and certificate;
//  - scripts/release.sh stages the release there (ps-own-release/, signed for this channel only) instead of the G Squad
//    channel on GitHub and the public download folder;
//  - scripts/postbuild.mjs copies ps-own-release/ to that folder of the website.
// A tree without a layer profile (core, a friend's checkout) has no own channel and every step works as before.
// V1.71, the phone (the developer, 19 Nov 2026: his phone never got this channel, kept asking the G Squad channel on GitHub and
// refused every G Squad APK there): ps-gos scripts/release.sh gives the private APK the whole layer profile
// (assets/profile.json), so it asks the SAME folder for PHONE_NOTE and the APK the note names, and makes the note for
// this channel. scripts/postbuild.mjs copies gos-release/ there (phoneNote below says whether it may); release.sh stops
// when the staged phone build is not made for this channel.
//   node scripts/own-channel.mjs url [profile]               the channel's address ("" when there is no layer profile)
//   node scripts/own-channel.mjs name [profile]              the channel's name (the profile name, "red")
//   node scripts/own-channel.mjs app-file <profile> <out>    writes the app's channel.json
//   node scripts/own-channel.mjs installed <PS.app>          the own channel an installed app follows ("" for none)
//   node scripts/own-channel.mjs note-version                the version ("1.69") of a signed note read on stdin, or ""
//   node scripts/own-channel.mjs phone <dir> [V1.71] [profile]   the staged phone build in <dir> is made for this channel
// Exit 1 (and why, on stderr) when a layer profile is there but its channel cannot be used.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_PROFILE = "ps-layer/profile.json";
const NAME = /^[a-z][a-z0-9-]{0,30}$/;
/** Where on the website the folder may be: an unlisted folder right under /client/ps/ (noindex, no cache there). */
const FOLDER = /^\/client\/ps\/[a-z0-9][a-z0-9-]{7,62}\/$/;

/** The own channel a profile object names: { name, url, folder }. Throws with the reason when it cannot be used. */
export function ownChannel(p) {
  if (!p || typeof p !== "object") throw new Error("the layer profile is not a JSON object");
  if (typeof p.name !== "string" || !NAME.test(p.name) || p.name === "gsquad") throw new Error("the layer profile has no own name");
  const ch = p.channel;
  if (!ch || ch.kind !== "url") throw new Error(`the layer profile's channel is not an own channel ("kind": "url")`);
  let u;
  try { u = new URL(String(ch.url || "")); } catch { throw new Error("the layer profile's channel has no address"); }
  if (u.protocol !== "https:" || !u.host || u.search || u.hash || u.username || u.password) throw new Error("the own channel must be a plain https address");
  if (!FOLDER.test(u.pathname)) throw new Error("the own channel must be an unlisted folder under /client/ps/, ending in /");
  if (u.href !== ch.url) throw new Error("the own channel address is not written in its plain form");
  return { name: p.name, url: u.href, folder: u.pathname };
}

/** The own channel of the layer profile at `file`, or null when there is no such file. Throws when it is unusable. */
export function ownChannelOf(file = DEFAULT_PROFILE) {
  if (!existsSync(file)) return null;
  let p;
  try { p = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error(`${file} is not JSON`); }
  return ownChannel(p);
}

/** The app's channel.json: the channel part alone, in the profile's shape (UpdateRoute.from reads it). */
export function appFile(c) {
  return JSON.stringify({ name: c.name, channel: { kind: "url", url: c.url } }, null, 2) + "\n";
}

/** The own channel address an installed app follows, or "" (no channel.json, or not an own channel). */
export function installedUrl(app) {
  try { return ownChannel(JSON.parse(readFileSync(join(app, "Contents/Resources/channel.json"), "utf8"))).url; } catch { return ""; }
}

/** The version a signed update note names ("V1.69" -> "1.69"), or "" when it is not a note. */
export function noteVersion(raw) {
  try {
    const p = JSON.parse(Buffer.from(JSON.parse(raw).signed, "base64").toString("utf8"));
    const m = /^V(\d{1,3}\.\d{1,3})$/.exec(String(p.name || ""));
    return m ? m[1] : "";
  } catch { return ""; }
}

/** The note's name in the channel folder: what the phone asks for (ps-gos app/build.gradle.kts, updateNote). */
export const PHONE_NOTE = "gos-version.json";
/** A phone APK's file name (ps-gos scripts/release.sh: ps-gos-1.71.apk, a re-spin ps-gos-1.71-b77.apk). */
export const PHONE_APK = /^ps-gos-[0-9]{1,3}\.[0-9]{1,3}(-b[0-9]+)?\.apk$/;

/** The staged phone build in `dir` (ps-gos release.sh leaves version.json and the APK there), checked for the own
 *  channel `c`: { note, apk } (the note's path and the APK's file name), null when nothing is staged. Throws with the
 *  reason when it may not go to that channel: made for another channel, another version than `version` ("V1.71"),
 *  an APK that is missing or is not the file the note describes, or one without this channel's layer profile. */
export function phoneNote(dir, c, version = "") {
  const note = join(dir, "version.json");
  if (!existsSync(note)) return null;
  let g;
  try { g = JSON.parse(readFileSync(note, "utf8")); } catch { throw new Error(`${note} is not JSON`); }
  if (!g || typeof g !== "object" || !Number.isInteger(g.versionCode) || typeof g.versionName !== "string") throw new Error(`${note} is not a phone note`);
  if (g.channel !== c.name) throw new Error(`the phone build ${g.versionName} is made for the ${typeof g.channel === "string" ? g.channel : "G Squad"} channel, not ${c.name}'s own (its APK was made without this layer profile)`);
  if (version && g.versionName !== version) throw new Error(`the staged phone build is ${g.versionName}, not ${version}`);
  if (!PHONE_APK.test(String(g.apk || ""))) throw new Error(`the phone note names a strange APK`);
  if (!/^[0-9a-f]{64}$/.test(String(g.cert || ""))) throw new Error(`the phone note has no signing certificate`);
  const apk = join(dir, g.apk);
  if (!existsSync(apk)) throw new Error(`${g.apk} is not in ${dir}`);
  if (statSync(apk).size !== g.size) throw new Error(`${g.apk} is not the size its note says`);
  if (createHash("sha256").update(readFileSync(apk)).digest("hex") !== g.sha256) throw new Error(`${g.apk} does not match its note's sha256`);
  // The label alone is not enough (an older ps-gos release.sh labels the note but builds without the profile): the APK
  // itself must carry this channel's layer profile, or the phone would still ask the G Squad channel.
  let inside = null;
  try { inside = ownChannel(apkProfile(apk)); } catch {}
  if (!inside || inside.name !== c.name || inside.url !== c.url) throw new Error(`${g.apk} does not carry ${c.name}'s layer profile, so the phone would ask the G Squad channel`);
  return { note, apk: g.apk };
}

/** The layer profile an APK carries (assets/profile.json, parsed), or null when it has none. */
export function apkProfile(apk) {
  try { return JSON.parse(execFileSync("unzip", ["-p", apk, "assets/profile.json"], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 20 }).toString("utf8")); } catch { return null; }
}

// Run as a command? Compare real paths: the release runs this from a temp folder under /var, which macOS links to
// /private/var, so the two spellings of the same file must still count as one (V1.71 release stop, 20 Nov 2026).
const ranDirectly = (() => { try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] || ""); } catch { return false; } })();
if (ranDirectly) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === "url" || cmd === "name") {
      const c = ownChannelOf(a || DEFAULT_PROFILE);
      process.stdout.write(c ? c[cmd] : "");
    } else if (cmd === "app-file" && a && b) {
      const c = ownChannelOf(a);
      if (!c) throw new Error(`${a} is not there`);
      writeFileSync(b, appFile(c));
      console.log(`PS follows its own update channel only (${c.name}): Resources/channel.json`);
    } else if (cmd === "installed" && a) {
      process.stdout.write(installedUrl(a));
    } else if (cmd === "note-version") {
      process.stdout.write(noteVersion(readFileSync(0, "utf8")));
    } else if (cmd === "phone" && a) {
      const c = ownChannelOf(process.argv[5] || DEFAULT_PROFILE);
      if (!c) throw new Error("there is no layer profile, so no own channel for the phone");
      const p = phoneNote(a, c, b || "");
      if (!p) throw new Error(`no phone build is staged in ${a}`);
      console.log(`The phone build ${p.apk} is made for ${c.name}'s own channel.`);
    } else {
      console.error("usage: own-channel.mjs url|name [profile] | app-file <profile> <out> | installed <PS.app> | note-version < note | phone <dir> [V1.71] [profile]");
      process.exit(2);
    }
  } catch (e) {
    console.error(`own-channel: ${e.message}`);
    process.exit(1);
  }
}
