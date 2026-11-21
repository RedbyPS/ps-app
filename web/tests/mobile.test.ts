// Run: node --experimental-strip-types tests/mobile.test.ts
// G Squad, the mobile web app at cincee.com/todolist-mobile (src/mobile/): the project a phone links (its own Supabase
// project, never a secret key), which phone and browser the Add to Home Screen guide sees, the build and deploy
// wiring (one build with the website, its own manifest, service worker and security policy), and the load order
// that keeps the vault from starting before it knows it is the mobile app. Project refs and keys here are made up.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { RED_PROJECT_URL, authStorageKey, chooseProject, isMobilePath, localDbName } from "../src/core/project.ts";
import { LINK_KEY, forgetLinked, isSecretKey, parseConnect, projectHost, readLinked, saveLinked, tidyProjectUrl } from "../src/mobile/link.ts";
import { appBase, detectPlatform, isInstallPath } from "../src/mobile/platform.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const FRIEND = "https://abcdefghijklmnopqrst.supabase.co";
const PUB = "sb_publishable_madeUpTestKey0123456789";
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${b64({ iss: "supabase", role })}.c2lnbmF0dXJlLW1hZGUtdXA`;
const RED_KEY = jwt("anon");

ok("the mobile app takes the phone's linked project; nothing else does", () => {
  const p = chooseProject("production", { url: FRIEND, key: PUB }, RED_PROJECT_URL, RED_KEY, true);
  assert.equal(p.url, FRIEND); assert.equal(p.key, PUB); assert.equal(p.red, false); assert.equal(p.custom, true);
  assert.equal(p.setupCode, null, "never a setup code on the phone");
  assert.equal(chooseProject("production", { url: FRIEND, key: PUB, setupCode: "A".repeat(24) }, RED_PROJECT_URL, RED_KEY, true).setupCode, null);
  assert.equal(chooseProject("production", { url: FRIEND, key: PUB }, RED_PROJECT_URL, RED_KEY).url, RED_PROJECT_URL, "the website: the developer's, whatever is set");
  assert.equal(chooseProject("gos", { url: FRIEND, key: PUB }, RED_PROJECT_URL, RED_KEY, true).url, RED_PROJECT_URL, "PS GOS never");
  assert.equal(chooseProject("production", { url: "https://evil.example.com", key: PUB }, RED_PROJECT_URL, RED_KEY, true).url, RED_PROJECT_URL, "a bad link: the build's own");
  assert.equal(chooseProject("production", { url: FRIEND, key: PUB, schema: "ps" }, RED_PROJECT_URL, RED_KEY, true).schema, "ps");
});

ok("the flag only counts on the mobile app's own address", () => {
  for (const p of ["/todolist-mobile/", "/todolist-mobile", "/todolist-mobile/install", "/client/todolist-mobile/"]) assert.equal(isMobilePath(p), true, p);
  for (const p of ["/client/", "/", "/campaigns", "/todolist-mobilex/", "/client/ps/todolist-mobile/"]) assert.equal(isMobilePath(p), false, p);
  const v = read("src/core/vault.ts");
  assert.match(v, /\(globalThis as \{ __psMobile\?: unknown \}\)\.__psMobile === true && typeof location !== "undefined" && isMobilePath\(location\.pathname\)\);/);
});

ok("a friend's project keeps its own sign in and offline copy (never the website's)", () => {
  const red = chooseProject("production", undefined, RED_PROJECT_URL, RED_KEY);
  const friend = chooseProject("production", { url: FRIEND, key: PUB }, RED_PROJECT_URL, RED_KEY, true);
  assert.equal(authStorageKey(red), "cincee-vault-auth", "the website's key is unchanged");
  assert.equal(authStorageKey(friend), "cincee-vault-auth-abcdefghijklmnopqrst");
  assert.equal(localDbName(friend), "cincee-vault-abcdefghijklmnopqrst");
  assert.match(read("src/core/vault.ts"), /storageKey: authStorageKey\(PROJECT\)/);
});

ok("Connect: the address in any form people copy it", () => {
  for (const u of ["abcdefghijklmnopqrst", "abcdefghijklmnopqrst.supabase.co", FRIEND, `${FRIEND}/`, `${FRIEND}/rest/v1/`, " https://ABCDEFGHIJKLMNOPQRST.supabase.co ", "http://abcdefghijklmnopqrst.supabase.co"])
    assert.equal(tidyProjectUrl(u), FRIEND, u);
  const r = parseConnect("abcdefghijklmnopqrst.supabase.co", ` ${PUB} `);
  assert.ok("ok" in r && r.ok.url === FRIEND && r.ok.key === PUB && r.ok.schema === "public");
  assert.ok("ok" in parseConnect(FRIEND, jwt("anon")), "an older anon key works");
});

ok("Connect: a secret key is refused outright, with words that say why", () => {
  assert.equal(isSecretKey("sb_secret_abcdefghijklmnop"), true);
  assert.equal(isSecretKey(jwt("service_role")), true);
  assert.equal(isSecretKey(jwt("anon")), false);
  assert.equal(isSecretKey(PUB), false);
  for (const k of ["sb_secret_abcdefghijklmnop", jwt("service_role")]) {
    const r = parseConnect(FRIEND, k);
    assert.ok("error" in r && /secret key/i.test(r.error), k);
  }
});

ok("Connect: plain words for every other mistake", () => {
  const err = (u: string, k: string) => { const r = parseConnect(u, k); assert.ok("error" in r, `${u} ${k}`); return (r as { error: string }).error; };
  assert.match(err("", PUB), /Project URL/);
  assert.match(err(FRIEND, ""), /publishable key/);
  assert.match(err("https://example.com", PUB), /does not look like a Supabase Project URL/);
  assert.match(err("http://127.0.0.1:54321", PUB), /does not look like a Supabase Project URL/, "no local servers on a phone");
  assert.match(err(FRIEND, "hello"), /does not look like a publishable key/);
  for (const e of [err("", PUB), err(FRIEND, "hello"), err(FRIEND, "sb_secret_abcdefghijklmnop")]) assert.ok(!/[\u2013\u2014]/.test(e), "no long dashes");
});

ok("the linked project is checked again on every read; tampering reads as none", () => {
  const m = new Map<string, string>();
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
  assert.equal(readLinked(store), null);
  saveLinked({ url: FRIEND, key: PUB, schema: "public" }, store);
  assert.deepEqual(readLinked(store), { url: FRIEND, key: PUB, schema: "public" });
  for (const bad of ["{", "null", JSON.stringify({ url: "https://evil.example.com", key: PUB }), JSON.stringify({ url: "http://127.0.0.1:54321", key: PUB }), JSON.stringify({ url: FRIEND, key: "x" })]) {
    m.set(LINK_KEY, bad);
    assert.equal(readLinked(store), null, bad);
  }
  saveLinked({ url: FRIEND, key: PUB, schema: "public" }, store);
  forgetLinked(store);
  assert.equal(readLinked(store), null);
  assert.equal(projectHost(FRIEND), "abcdefghijklmnopqrst.supabase.co");
});

ok("the guide knows the phone and browser", () => {
  const ua = {
    iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
    iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0 Mobile/15E148 Safari/604.1",
    iphoneFirefox: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15",
    ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
    android: "Mozilla/5.0 (Linux; Android 16; Pixel 10a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36",
    mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
  };
  assert.equal(detectPlatform(ua.iphoneSafari), "ios-safari");
  assert.equal(detectPlatform(ua.iphoneChrome), "ios-other");
  assert.equal(detectPlatform(ua.iphoneFirefox), "ios-other");
  assert.equal(detectPlatform(ua.ipad, 5), "ios-safari", "an iPad says Macintosh but has touch");
  assert.equal(detectPlatform(ua.ipad, 0), "desktop");
  assert.equal(detectPlatform(ua.android, 5), "android");
  assert.equal(detectPlatform(ua.mac), "desktop");
  assert.equal(appBase("/todolist-mobile/install"), "/todolist-mobile/");
  assert.equal(appBase("/client/todolist-mobile/"), "/client/todolist-mobile/");
  assert.equal(isInstallPath("/todolist-mobile/install"), true);
  assert.equal(isInstallPath("/todolist-mobile/"), false);
});

ok("load order: the page's first import is boot, and nothing it imports up front reaches the vault", () => {
  const main = read("src/mobile/main.tsx");
  const firstImport = main.split("\n").find((l) => l.startsWith("import "));
  assert.equal(firstImport?.startsWith('import "./boot";'), true);
  assert.match(main, /lazy\(\(\) => import\("\.\/app"\)\)/, "the app part loads after boot, by a dynamic import");
  // Walk the static imports from main.tsx (dynamic import() is fine: it runs later).
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = read(file);
    for (const m of text.matchAll(/^import\s+(?:[^'"]*?from\s+)?["']([^"']+)["']/gm)) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;
      const base = new URL(spec, new URL(`../${file}`, import.meta.url)).pathname.replace(/^.*?\/src\//, "src/");
      const hit = [base, `${base}.ts`, `${base}.tsx`].find((p) => /\.(ts|tsx)$/.test(p) && existsSync(new URL(`../${p}`, import.meta.url)));
      if (hit) walk(hit);
    }
  };
  walk("src/mobile/main.tsx");
  const bad = [...seen].filter((f) => f === "src/core/vault.ts" || f.startsWith("src/gos/") || f === "src/App.tsx" || f === "src/mobile/app.tsx");
  assert.deepEqual(bad, [], "these must load only after boot");
  assert.ok(seen.has("src/mobile/boot.ts") && seen.has("src/mobile/link.ts"));
});

ok("one build with the website: the mobile page is an input of the website build only", () => {
  const vc = read("vite.config.ts");
  // V1.44: the Mac and phone builds keep one file (inlineDynamicImports); the website splits its own pages (src/pages.ts).
  assert.match(vc, /mode === "ps" \|\| mode === "gos" \? \{ rollupOptions: \{ output: \{ inlineDynamicImports: true \} \} \} : \{ rollupOptions: \{ input: \{ main: "index\.html", mobile: "todolist-mobile\/index\.html" \} \} \}/);
  const html = read("todolist-mobile/index.html");
  assert.match(html, /<script type="module" src="\/src\/mobile\/main\.tsx"><\/script>/);
  assert.match(html, /viewport-fit=cover/, "draws under the notch and Dynamic Island, then pads by the safe areas");
  assert.match(html, /apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /apple-mobile-web-app-status-bar-style" content="black-translucent"/);
  assert.ok(!/(src|href)="https?:\/\//.test(html), "nothing from other sites");
});

ok("postbuild: /todolist-mobile/ gets its page, manifest, icons, service worker and its own policy", () => {
  const pb = read("scripts/postbuild.mjs");
  assert.match(pb, /writeFileSync\("dist\/todolist-mobile\/index\.html", html\)/);
  assert.match(pb, /rmSync\("dist\/client\/todolist-mobile"/, "not left under /client/ too");
  assert.match(pb, /\/todolist-mobile\/sw\.js\n  Cache-Control: no-store, max-age=0\n  Service-Worker-Allowed: \/todolist-mobile\//);
  assert.match(pb, /\/todolist-mobile\/\*  \/todolist-mobile\/index\.html  200/);
  // Every rule that sets a policy is its own path: no path gets two (the stricter one would block the phone's project).
  const headers = pb.slice(pb.indexOf('writeFileSync("dist/_headers"'), pb.indexOf("/client/assets/*"));
  const blocks = headers.split(/\n\n/).filter((b) => b.includes("Content-Security-Policy"));
  const paths = blocks.map((b) => b.trim().split("\n")[0].replace(/^writeFileSync\("dist\/_headers", `/, ""));
  assert.deepEqual(paths, ["/", "/client/*", "/campaigns", "/campaigns/*", "/todolist-mobile", "/todolist-mobile/*"]);
  assert.ok(!/^\/\*\n  Content-Security-Policy/m.test(headers), "no catch-all policy that would stack on the mobile one");
});

ok("the service worker never touches other sites (Supabase) and keeps only this build's files", () => {
  const sw = read("todolist-mobile/static/sw.js");
  assert.match(sw, /const CACHE = "__PSM_CACHE__";/);
  assert.match(sw, /const FILES = __PSM_FILES__;/);
  assert.match(sw, /url\.origin !== location\.origin\) return;/);
  assert.match(sw, /k\.startsWith\("psm-"\) && k !== CACHE/, "old G Squad caches go, the website's stay");
  assert.ok(!/supabase/i.test(sw.replace(/\/\/.*$/gm, "")), "no API traffic in the cache");
});

ok("manifest and icons: PS app, standalone, scoped to /todolist-mobile/, real PNGs of the right sizes", () => {
  const m = JSON.parse(read("todolist-mobile/static/manifest.webmanifest"));
  assert.equal(m.name, "PS app"); assert.equal(m.short_name, "PS app"); assert.equal(m.display, "standalone");
  assert.equal(m.start_url, "/todolist-mobile/"); assert.equal(m.scope, "/todolist-mobile/"); assert.equal(m.id, "/todolist-mobile/");
  assert.ok(m.icons.some((i: { purpose: string }) => i.purpose === "maskable"));
  const size = (f: string) => { const b = readFileSync(new URL(`../todolist-mobile/static/${f}`, import.meta.url)); assert.equal(b.toString("latin1", 1, 4), "PNG", f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  for (const i of m.icons as { src: string; sizes: string }[]) assert.deepEqual(size(i.src.replace("/todolist-mobile/", "")).join("x"), i.sizes);
  assert.deepEqual(size("icon-cake-180.png"), [180, 180]);
  // PS 1.72: the Cake icon under new names (no cache keeps the old picture), the old files gone
  for (const old of ["apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png"]) assert.ok(!existsSync(new URL(`../todolist-mobile/static/${old}`, import.meta.url)), old);
  assert.match(read("src/core/appname.ts"), /export const MOBILE_APP_NAME = "PS app";/);
});

ok("the phone home is PS GOS's, with the same Settings and no fingerprint", () => {
  const l = read("src/gos/GosLayer.tsx");
  // V1.47: the gear opens Settings (views/SettingsScreen.tsx) on both phones; the web app's rows are the "mweb" ones.
  assert.match(l, /openSettings\(group \?\? "list", \{ owner: "tab", home: !group \}\)/);
  assert.match(l, /MWEB \? <MobileLockExtras \/> : <FingerprintCard/);
  const b = read("src/gos/bridge.ts");
  assert.match(b, /export const MWEB = !GOS && \(globalThis as \{ __psMobile\?: unknown \}\)\.__psMobile === true;/);
  assert.match(b, /if \(!MWEB\) \{ gosPost\(\{ type: "haptic", kind \}\); return; \}/, "PS GOS haptics unchanged");
});

ok("the Vault tab's header says PS app for everyone but the developer (his account keeps the website's)", () => {
  const app = read("src/App.tsx");
  assert.match(app, /\{MWEB && !red\s*\? <a className="brand psm-brand" href="#\/today"><AppMark size=\{28\} \/> \{MOBILE_APP_NAME\}<\/a>\s*: <a className="brand" href="#\/today"><Logo \/> Cincee <small>VAULT<\/small><\/a>\}/);
  assert.match(app, /const red = isRedAccount\(s\);/);
  assert.ok(!/useEffect|addEventListener/.test(read("src/mobile/mark.tsx")), "the mark has no side effects (the website loads it too)");
});

ok("every switch the mobile app has is a row of its Settings (public features need their controls)", () => {
  const s = read("src/gos/PhoneRows.tsx");
  for (const k of ['"phone-layout"', '"phone-haptics"', '"mweb-install"', '"mweb-alerts"', '"mweb-project"', '"phone-lock"', "<LayoutPicker bare />", "Change", "Lock"]) assert.ok(s.includes(k), k);
  const idx = read("src/core/settingsindex.ts");
  for (const id of ["mweb-install", "mweb-alerts", "mweb-project"]) assert.match(idx, new RegExp(`id: "${id}",[^\\n]*\\.\\.\\.MWEB_ONLY`), id);
  assert.ok(!/id: "(?:phone-layout|phone-haptics|phone-lock|mweb-[a-z]+)",[^\n]*red: true/.test(idx), "nothing for the web app is the developer only");
  assert.match(idx, /id: "new-badge", group: "list"/, "NEW badges: the shared Your list row");
});

ok("the sign in on the phone: unlock and recovery key only (no setup, client links or demo)", () => {
  const lk = read("src/views/Lock.tsx");
  const m = lk.slice(lk.indexOf("if (MWEB) {"), lk.indexOf("if (PS) {"));
  assert.ok(m.length > 200);
  assert.ok(m.includes("onSubmit={submit}"), "the same unlock and recovery as everywhere");
  for (const no of ["Set up", "demo", "clientLink", "/join", "ownerSetup", "PsCreateAccount"]) assert.ok(!m.includes(no), no);
});

console.log(`\n${n} G Squad mobile web app checks passed`);
