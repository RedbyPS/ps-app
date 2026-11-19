// Run: node --experimental-strip-types tests/signinart.test.ts
// PS 1.70, the developer's neon night city picture (the developer, 19 Nov 2026: "implement this as the login screen in the middle of the
// screen... looking very neat, fancy animations etc."): on every sign in screen of PS (Mac, PS GOS, the iPhone web app),
// never on the website's vault sign in, and as the "Neon city" background. Never called Vice City on screen.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { artFits, artStepDown } from "../src/core/signinart.ts";
import { BG_DESIGNS, bgDesign, isImageBg } from "../src/core/prio.ts";
import { bgLayers, NO_STAGE } from "../src/core/lookspreview.ts";

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const strip = (t: string) => t.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const raw = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const src = (f: string) => strip(raw(f));

ok("the picture never pushes the Sign in window past the screen", () => {
  assert.equal(artFits("full", 1000), "full");
  assert.equal(artFits("full", 840), "full");
  assert.equal(artFits("full", 839), "small");
  assert.equal(artFits("small", 1000), "small");
  assert.equal(artFits("full", 719), "none");
  assert.equal(artFits("none", 1400), "none");
  assert.equal(artFits("full", 0), "full", "no screen size known (a test page): as asked");
  // Measured too tall for the screen: it steps down; a page that fits keeps it.
  assert.equal(artStepDown("full", 780, 800), true);
  assert.equal(artStepDown("small", 700, 800), false);
  assert.equal(artStepDown("none", 2000, 800), false);
  assert.equal(artStepDown("full", 2000, 0), false);
  const s = src("views/PsSignIn.tsx");
  assert.match(s, /if \(artStepDown\(artRef\.current, h, avail\)\) \{ setArt\(\(a\) => \(a === "full" \? "small" : "none"\)\); return; \}/);
});
ok("every PS sign in screen on the Mac has it; the long forms take the band", () => {
  const s = src("views/PsSignIn.tsx");
  assert.match(s, /\{art !== "none" && <SignInArt size=\{art\} \/>\}/);
  assert.match(src("views/Lock.tsx"), /art=\{mode === "recover" \? "small" : "full"\}/);
  assert.match(src("views/PsCreate.tsx"), /art="small"/);
  assert.match(src("views/LocalFirst.tsx"), /<PsSignInShell title="Turn on sync" art="small">/);
  assert.doesNotMatch(src("views/PsTouchUnlock.tsx"), /art=/, "the locked screen: the full picture");
});
ok("the phone: PS GOS and the iPhone web app; never the website's vault sign in (clients use it)", () => {
  const l = src("views/Lock.tsx");
  assert.match(l, /\{import\.meta\.env\.MODE === "gos" && <SignInArt size=\{mode === "unlock" \? "full" : "small"\} \/>\}/);
  assert.match(l, /<header className="psm-hero psm-in">\s*<SignInArt \/>/);
  assert.match(l, /<header className="psm-hero psm-in">\s*<SignInArt size=\{mode === "recover" \? "small" : "full"\} \/>/);
  assert.equal((l.match(/<SignInArt\b/g) ?? []).length, 4, "GOS card, GOS form, the iPhone web app's two heroes");
});
ok("it takes no click and no keyboard; the fields stay clear", () => {
  const a = src("views/SignInArt.tsx");
  assert.match(a, /aria-hidden="true"/);
  assert.match(raw("views/signinart.css"), /\.si-art \{[^}]*pointer-events: none;/);
  assert.doesNotMatch(a, /tabIndex|onClick|onKeyDown/);
});
ok("motion: transform and opacity only, eased parallax that stops when it settles, still with reduce motion", () => {
  const c = raw("views/signinart.css");
  for (const k of c.matchAll(/@keyframes ([\w-]+) \{([\s\S]*?\})\s*\}/g)) assert.doesNotMatch(k[2], /\b(top|left|right|bottom|width|height|margin|padding|filter|background)\s*:/, k[1]);
  assert.match(c, /@media \(prefers-reduced-motion: reduce\)/);
  const a = src("views/SignInArt.tsx");
  assert.match(a, /el\.style\.transform = `translate3d\(/);
  assert.match(a, /raf = Math\.abs\(tx - x\) > 0\.05 \|\| Math\.abs\(ty - y\) > 0\.05 \? requestAnimationFrame\(step\) : 0;/, "no frame loop once it has settled");
  assert.match(a, /if \(!el \|\| reduced\(\)\) return;/);
});
ok("the picture files are small and sharp: 800 wide for the sign in, the full 1536 for the background", () => {
  const dir = new URL("../src/assets/", import.meta.url);
  const small = readFileSync(new URL("neon-city-800.webp", dir)), big = readFileSync(new URL("neon-city.webp", dir));
  const size = (b: Buffer) => {   // a WebP's own width and height (VP8 lossy: the frame header)
    assert.equal(b.toString("ascii", 0, 4), "RIFF"); assert.equal(b.toString("ascii", 8, 12), "WEBP");
    const i = b.indexOf("VP8 ");
    assert.ok(i > 0, "lossy VP8");
    return { w: b.readUInt16LE(i + 14) & 0x3fff, h: b.readUInt16LE(i + 16) & 0x3fff };
  };
  assert.deepEqual(size(small), { w: 800, h: 534 });
  assert.deepEqual(size(big), { w: 1536, h: 1024 });
  assert.ok(small.length < 110_000, `${small.length}`);
  assert.ok(big.length < 340_000, `${big.length}`);
  assert.match(src("views/SignInArt.tsx"), /srcSet=\{`\$\{NEON_CITY_SMALL\} 800w, \$\{NEON_CITY\} 1536w`\}/);
});
ok("Neon city, a background anyone can pick: drawn like a video, faded by the glass slider, rows on solid backings", () => {
  const d = BG_DESIGNS.find((x) => x.id === "neon-city")!;
  assert.deepEqual(d, { id: "neon-city", label: "Neon city", image: true });
  assert.equal(bgDesign("neon-city"), "neon-city");
  assert.ok(isImageBg("neon-city") && !isImageBg("spotlight") && !isImageBg("video:abc") && !isImageBg(null));
  const l = bgLayers({ bg: "neon-city", docked: false, hasP1: false, fade: 0.6, sliding: false, rain: false, stage: NO_STAGE });
  assert.ok(l.image && l.drawn && l.calm && !l.video && !l.scene);
  assert.equal(bgLayers({ bg: "neon-city", docked: true, hasP1: false, fade: 1, sliding: false, rain: false, stage: NO_STAGE }).image, false, "the docked To-do board never draws one");
  const t = src("views/TaskMap.tsx");
  assert.match(t, /\{imageBg && bgOn && <img className="tm-bgvideo tm-bgimage" src=\{NEON_CITY\}/);
  assert.match(t, /\{isImageBg\(d\.id\) && <img className="tm-bgvideo-sample tm-bgimage" src=\{NEON_CITY_SMALL\}/);
});
ok("never called Vice City anywhere on screen (nor in the code)", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  for (const f of walk(new URL("../src", import.meta.url).pathname)) if (/\.(tsx?|css|json|html)$/.test(f)) assert.doesNotMatch(readFileSync(f, "utf8"), /vice\s*city/i, f);
});
ok("no em or en dashes in the new files", () => {
  for (const f of ["views/SignInArt.tsx", "views/signinart.css", "views/neoncity.ts", "core/signinart.ts"]) assert.doesNotMatch(raw(f), /[–—]/, f);
});

console.log(`signinart: ${n} passed`);
