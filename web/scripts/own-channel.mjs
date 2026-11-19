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
//   node scripts/own-channel.mjs url [profile]               the channel's address ("" when there is no layer profile)
//   node scripts/own-channel.mjs name [profile]              the channel's name (the profile name, "red")
//   node scripts/own-channel.mjs app-file <profile> <out>    writes the app's channel.json
//   node scripts/own-channel.mjs installed <PS.app>          the own channel an installed app follows ("" for none)
//   node scripts/own-channel.mjs note-version                the version ("1.69") of a signed note read on stdin, or ""
// Exit 1 (and why, on stderr) when a layer profile is there but its channel cannot be used.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

if (import.meta.url === `file://${process.argv[1]}`) {
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
    } else {
      console.error("usage: own-channel.mjs url|name [profile] | app-file <profile> <out> | installed <PS.app> | note-version < note");
      process.exit(2);
    }
  } catch (e) {
    console.error(`own-channel: ${e.message}`);
    process.exit(1);
  }
}
