// Writes Netlify routing and security headers at the deploy root (dist/).
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { approved as psDownloadApproved, files as psDownloadFiles } from "./ps-download.mjs";
import { ownChannelOf } from "./own-channel.mjs";

const SB = "https://mxusokxekkecebwqgeru.supabase.co";
// G Squad hub (V1.40): the website reaches only its chat (src/squad/chathub.ts); every call is signed, nothing secret.
const SQUAD_HUB = "https://zxhvchchfrkfqxuyorqo.supabase.co";
// V1.57: the website's "New version" look reads web-version.json from the public PS repo on GitHub, not cincee.com
// (src/core/webupdate.ts WEB_CHANNEL). Only that host, nothing else on GitHub runs or loads.
const GH_RAW = "https://raw.githubusercontent.com";
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  // G Squad GIFs (PS 1.63): pictures only, from GIPHY's media servers (media*.giphy.com, i.giphy.com); no script, no frame, no connection.
  "img-src 'self' data: blob: https://*.giphy.com",
  `connect-src 'self' ${SB} ${SB.replace("https", "wss")} ${SQUAD_HUB} ${GH_RAW}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  // Only the Goals "How it works" video (privacy friendly YouTube host), only once its pop-up opens.
  "frame-src blob: https://www.youtube-nocookie.com",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "upgrade-insecure-requests",
].join("; ");

// G Squad, the mobile web app (cincee.com/todolist-mobile, src/mobile/): the same strict policy, except that it may
// talk to any Supabase project, because each G Squad friend's list lives in their OWN project (linked on the phone,
// src/mobile/link.ts). Only scripts from this site still run. The website's policy above stays locked to the developer's.
const MOBILE_SB = "https://*.supabase.co";
const mobileCsp = csp.replace(`connect-src 'self' ${SB} ${SB.replace("https", "wss")}`, `connect-src 'self' ${MOBILE_SB} ${MOBILE_SB.replace("https", "wss")}`);
if (mobileCsp === csp) throw new Error("postbuild: the mobile CSP did not change connect-src");

// Each path gets exactly one policy (a path that matched two rules would get both, and the stricter would block).
writeFileSync("dist/_headers", `/
  Content-Security-Policy: ${csp}

/client/*
  Content-Security-Policy: ${csp}

/campaigns
  Content-Security-Policy: ${csp}

/campaigns/*
  Content-Security-Policy: ${csp}

/todolist-mobile
  Content-Security-Policy: ${mobileCsp}

/todolist-mobile/*
  Content-Security-Policy: ${mobileCsp}

/todolist-mobile/sw.js
  Cache-Control: no-store, max-age=0
  Service-Worker-Allowed: /todolist-mobile/

/todolist-mobile/manifest.webmanifest
  Content-Type: application/manifest+json

/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()
  Strict-Transport-Security: max-age=63072000; includeSubDomains
  Cross-Origin-Opener-Policy: same-origin
  X-Robots-Tag: noindex, nofollow, noarchive
  Cache-Control: no-cache

/client/assets/*
  Cache-Control: public, max-age=31536000, immutable

/client/sw.js
  Cache-Control: no-store, max-age=0
  Service-Worker-Allowed: /client/

/client/gos/*
  X-Robots-Tag: noindex, nofollow, noarchive, nosnippet
  Cache-Control: no-cache

/client/gos/*.apk
  Content-Type: application/vnd.android.package-archive
  Content-Disposition: attachment

/client/ps/*
  X-Robots-Tag: noindex, nofollow, noarchive, nosnippet
  Cache-Control: no-cache

/client/ps/*.dmg
  Content-Type: application/x-apple-diskimage
  Content-Disposition: attachment; filename="PS.dmg"

/client/ps/updates/*
  Content-Type: application/zip
  Cache-Control: public, max-age=31536000, immutable

/client/ps/install.sh
  Content-Type: text/plain; charset=utf-8

/client/ps/ps-verify.js
  Content-Type: text/plain; charset=utf-8

/client/build/*
  X-Robots-Tag: noindex, nofollow, noarchive, nosnippet
  Cache-Control: no-cache
`);

// PS GOS (the developer's GrapheneOS phone app): its updates sit at an unlisted path, cincee.com/client/gos/,
// linked from nowhere and in no sitemap. ~/Projects/ps/phone/scripts/release.sh leaves the newest APK
// and version.json in gos-release/ (gitignored); the phone checks version.json there.
if (existsSync("gos-release/version.json")) {
  mkdirSync("dist/client/gos", { recursive: true });
  for (const f of readdirSync("gos-release")) if (/^(version\.json|ps-gos-[0-9.]+(-b[0-9]+)?\.apk)$/.test(f)) copyFileSync(`gos-release/${f}`, `dist/client/gos/${f}`);
  console.log("postbuild: PS GOS update files copied to client/gos/");
}

// Public PS for the Mac (27 Oct 2026): PS.dmg, the signed update channel PS reads
// (ps-update.json + updates/*.zip) and release.json for the download pages, all at the unlisted
// cincee.com/client/ps/. ps-mac/release/publish.sh (PS_RELEASE_OUT) and scripts/ps-public.mjs stage
// them in ps-release/ (gitignored), after release/audit.py found nothing of the developer's in them.
if (existsSync("ps-release/ps-update.json")) {
  mkdirSync("dist/client/ps/updates", { recursive: true });
  for (const f of readdirSync("ps-release")) if (/^(ps-update\.json|release\.json|PS\.dmg)$/.test(f)) copyFileSync(`ps-release/${f}`, `dist/client/ps/${f}`);
  if (existsSync("ps-release/updates")) for (const f of readdirSync("ps-release/updates")) if (/^PS-(app|web)-[0-9]+\.zip$/.test(f)) copyFileSync(`ps-release/updates/${f}`, `dist/client/ps/updates/${f}`);
  console.log("postbuild: public PS files copied to client/ps/");
}

// V1.69: the maker's own update channel (the developer's: the unlisted folder in ps-layer/profile.json, scripts/own-channel.mjs).
// release.sh stages his release in ps-own-release/ (gitignored), signed for his channel only; only his own builds ask
// there (their Resources/channel.json). Never the G Squad channel or the public download. No layer profile: nothing.
{
  let own = null;
  try { own = ownChannelOf(); } catch (e) { console.error(`postbuild: STOP, ${e.message}`); process.exit(1); }
  if (own && existsSync("ps-own-release/ps-update.json")) {
    const to = `dist${own.folder}`;
    mkdirSync(`${to}updates`, { recursive: true });
    for (const f of readdirSync("ps-own-release")) if (/^(ps-update\.json|PS\.dmg)$/.test(f)) copyFileSync(`ps-own-release/${f}`, `${to}${f}`);
    if (existsSync("ps-own-release/updates")) for (const f of readdirSync("ps-own-release/updates")) if (/^PS-(app|web)-[0-9]+\.zip$/.test(f)) copyFileSync(`ps-own-release/updates/${f}`, `${to}updates/${f}`);
    console.log(`postbuild: ${own.name}'s own PS update channel copied to its unlisted folder`);
  }
}

// The easy way in (31 Oct 2026): `curl -fsSL https://cincee.com/client/ps/install.sh | bash` (checks the
// signed channel above, no Gatekeeper stop) and the download page cincee.com/client/ps/download/
// (the DMG, the Open Anyway steps). Both live in ps-download/ and are unlisted and noindex like the rest.
// Public copy: deployed ONLY when the developer approved these exact files (scripts/ps-download.mjs); off by default.
if (psDownloadApproved()) {
  mkdirSync("dist/client/ps/download", { recursive: true });
  for (const f of psDownloadFiles()) copyFileSync(`ps-download/${f}`, `dist/client/ps/${f}`);
  console.log("postbuild: PS install script and download page copied to client/ps/ (approved by the developer)");
} else {
  console.log("postbuild: PS download page and install.sh NOT deployed: the developer has not approved these exact words (node scripts/ps-download.mjs show)");
}

// The build prompt page (2 Nov 2026): an encrypted, unlisted page at cincee.com/client/build/<path>/.
// scripts/build-prompt.mjs (run by release.sh) leaves it in build-prompt/<path>/ (gitignored):
// ciphertext and the page only. Not in public/, so it never lands in the Mac app or the phone APK.
if (existsSync("build-prompt")) {
  for (const d of readdirSync("build-prompt")) {
    if (!/^[a-z0-9]{32}$/.test(d)) continue;
    mkdirSync(`dist/client/build/${d}`, { recursive: true });
    for (const f of ["index.html", "page.js", "prompt.enc.json"]) copyFileSync(`build-prompt/${d}/${f}`, `dist/client/build/${d}/${f}`);
    console.log("postbuild: build prompt page copied to client/build/");
  }
}

// G Squad, the mobile web app: built with the website (vite.config.ts input "mobile"), served at /todolist-mobile/
// with its own manifest, icons and service worker (todolist-mobile/static/). Its code is the website's own files in
// /client/assets/, so the website and the phone app always run the same code.
if (existsSync("dist/client/todolist-mobile/index.html")) {
  mkdirSync("dist/todolist-mobile", { recursive: true });
  const head = [
    `<link rel="manifest" href="/todolist-mobile/manifest.webmanifest" />`,
    `<link rel="icon" href="/todolist-mobile/icon-192.png" type="image/png" />`,
    `<link rel="apple-touch-icon" href="/todolist-mobile/apple-touch-icon.png" />`,
  ].join("\n    ");
  const html = readFileSync("dist/client/todolist-mobile/index.html", "utf8").replace(/\s*<!--psm-head:[\s\S]*?-->/, "").replace("</head>", `  ${head}\n  </head>`);
  if (!html.includes('rel="manifest"')) throw new Error("postbuild: the mobile page has no manifest");
  writeFileSync("dist/todolist-mobile/index.html", html);
  rmSync("dist/client/todolist-mobile", { recursive: true, force: true });
  for (const f of readdirSync("todolist-mobile/static")) if (f !== "sw.js") copyFileSync(`todolist-mobile/static/${f}`, `dist/todolist-mobile/${f}`);
  // The service worker keeps this build's files: the page, its icons, and every code and style file of the build
  // (the screens load some of them later, and offline they must already be there). Media over 2 MB is left to load when used.
  const assets = readdirSync("dist/client/assets").filter((f) => /\.(js|css|woff2?|ttf|svg|png|webp)$/.test(f) && statSync(`dist/client/assets/${f}`).size <= 2_000_000);
  const files = ["/todolist-mobile/", ...readdirSync("dist/todolist-mobile").filter((f) => f !== "index.html").map((f) => `/todolist-mobile/${f}`), ...assets.map((f) => `/client/assets/${f}`)];
  const stamp = createHash("sha256").update(html).update(files.join("\n")).digest("hex").slice(0, 12);
  const sw = readFileSync("todolist-mobile/static/sw.js", "utf8").replace("__PSM_CACHE__", `psm-${stamp}`).replace("__PSM_FILES__", JSON.stringify(files));
  writeFileSync("dist/todolist-mobile/sw.js", sw);
  console.log(`postbuild: G Squad mobile web app at /todolist-mobile/ (${files.length} files kept offline)`);
}

writeFileSync("dist/_redirects", `/              /client/              302
/client         /client/              301
/client/*       /client/index.html    200
/campaigns      /client/index.html    200
/campaigns/*    /client/index.html    200
/todolist-mobile    /todolist-mobile/    301
/todolist-mobile/*  /todolist-mobile/index.html  200
`);
writeFileSync("dist/robots.txt", "User-agent: *\nDisallow: /\n");
console.log("postbuild: wrote _headers, _redirects, robots.txt");
