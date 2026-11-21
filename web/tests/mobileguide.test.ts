// Run: node --experimental-strip-types tests/mobileguide.test.ts
// The mobile web app opens on the Add to Home Screen guide: when it shows, "Not now" remembered on the phone, never
// inside the Home Screen app, and what the installed icon and name will be.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GUIDE_SKIP_KEY, detectPlatform, showGuide } from "../src/mobile/platform.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

ok("a browser tab shows the guide first, every time, until the phone says Not now", () => {
  assert.equal(showGuide({ standalone: false, skipped: false, installPath: false }), true);
  assert.equal(showGuide({ standalone: false, skipped: true, installPath: false }), false, "Not now is remembered");
});
ok("never inside the Home Screen app, whatever else is true", () => {
  for (const skipped of [false, true]) for (const installPath of [false, true]) assert.equal(showGuide({ standalone: true, skipped, installPath }), false);
});
ok("the install address always shows it in a browser, even after Not now", () => {
  assert.equal(showGuide({ standalone: false, skipped: true, installPath: true }), true);
});
ok("the phone's first screen follows that rule, and Not now is kept in localStorage (this phone, not just this visit)", () => {
  const m = read("src/mobile/main.tsx");
  assert.match(m, /showGuide\(\{ standalone: isStandalone\(\), skipped, installPath: isInstallPath\(location\.pathname\) \}\)/);
  assert.match(m, /localStorage\.setItem\(GUIDE_SKIP_KEY, "1"\)/);
  assert.match(m, /localStorage\.getItem\(GUIDE_SKIP_KEY\) === "1"/);
  assert.ok(!/psm\.browser/.test(m), "the old once per visit memory is gone");
  assert.equal(GUIDE_SKIP_KEY, "psm.guide.skip");
});
ok("iPhone Safari steps: Share, Add to Home Screen, Add, then open the app; three dots if Share is not in sight", () => {
  const i = read("src/mobile/Install.tsx");
  assert.match(i, /Tap the <b>Share<\/b> button/);
  assert.match(i, /three dots/);
  assert.match(i, /Tap <b>Add to Home Screen<\/b>/);
  assert.match(i, /Tap <b>Add<\/b>/);
  assert.match(i, /Then open <b>\{MOBILE_APP_NAME\}<\/b> from your Home Screen\./);
  assert.match(i, /Not now, use it in Safari/);
  for (const a of ["ArtShare", "ArtAddRow", "ArtAddButton", "ArtOpen"]) assert.match(i, new RegExp(`<${a} />`), `${a} picture`);
});
ok("iPhones in Safari or another browser get steps; a laptop gets the address to type", () => {
  const safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  assert.equal(detectPlatform(safari, 5), "ios-safari");
  assert.equal(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15", 0), "desktop");
});
ok("the installed icon and name: PS app, the pink icon, dark theme colour, the manifest and apple touch icon linked", () => {
  const m = JSON.parse(read("todolist-mobile/static/manifest.webmanifest"));
  assert.equal(m.name, "PS app"); assert.equal(m.short_name, "PS app"); assert.equal(m.theme_color, "#0D0A0E"); assert.equal(m.display, "standalone");
  const h = read("todolist-mobile/index.html");
  assert.match(h, /apple-mobile-web-app-title" content="PS app"/); assert.match(h, /<title>PS app<\/title>/);
  assert.match(h, /theme-color" content="#0D0A0E"/); assert.match(h, /apple-mobile-web-app-capable" content="yes"/);
  const pb = read("scripts/postbuild.mjs");
  assert.match(pb, /rel="manifest" href="\/todolist-mobile\/manifest\.webmanifest"/);
  assert.match(pb, /rel="apple-touch-icon" href="\/todolist-mobile\/icon-cake-180\.png"/);
  assert.ok(!/G Squad/.test(JSON.stringify(m) + h), "no old name left on the Home Screen");
});
ok("the pictures stand still for people who turned motion off", () => {
  assert.match(read("src/mobile/mobile.css"), /prefers-reduced-motion: reduce\) \{\n  \.psm-art \* \{ animation: none !important; \}/);
});
console.log(`\n${n} passed`);
