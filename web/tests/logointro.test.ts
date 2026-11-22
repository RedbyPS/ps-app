// Run: node --experimental-strip-types tests/logointro.test.ts
// V1.62 (the developer, 15 Nov 2026): "about a minute later when you download 1.62, the dynamic island expands out with the new app logo and
// shows 'New app logo'. Don't show this to people that have just downloaded the PS app for the first time, only to people that are
// updating from a previous version. Then you can click 'Ok' on it."
// One new entry in the feature intro list (core/featureintro.ts INTROS), drawn by views/FeatureIntro.tsx like every other intro.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const file = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const I = await import("../src/core/featureintro.ts");
const { ACTIVE_NEEDED_MS, INTROS, LOGO_MOMENT, addActive, answer, emptyState, logoChime, markShown, nextIntro, retire, updaterAnswer, cleanDone } = I;
type Facts = Parameters<typeof nextIntro>[1];

const LOGO = INTROS.find((d) => d.id === "new-logo-162")!;
const T0 = 1_800_000_000_000;
const calm = (now: number, over: Partial<Facts> = {}): Facts =>
  ({ now, notForThem: [], islandBusy: false, sleep: false, sentry: false, dnd: false, sharing: false, fullScreen: false, off: false, ...over });
const used = () => ({ ...emptyState(), ver: "V1.62", activeMs: ACTIVE_NEEDED_MS });
const pick = (s: ReturnType<typeof emptyState>, f: Facts) => nextIntro(s, f);
const showsLogo = (s: ReturnType<typeof emptyState>, f: Facts) => { const p = pick(s, f); return !!p && "show" in p && p.show.id === LOGO.id; };
const base = { id: LOGO.id, unlocked: true, docs: 40, done: [] as string[], accountOlder: false, seenAtStart: null as string | null, version: "1.62" };

ok("the entry: 'New app logo', one button 'Ok', the logo, no question, no Later, no guide; first in the list", () => {
  assert.ok(LOGO);
  assert.equal(INTROS[0].id, LOGO.id, "first, so it comes after the first minute even when an older intro still waits");
  assert.equal(LOGO.headline, "New app logo");
  assert.equal(LOGO.show, "Ok");
  assert.equal(LOGO.ask, undefined);
  assert.equal(LOGO.later, undefined);
  assert.equal(LOGO.guide, undefined);
  assert.equal(LOGO.steps, undefined);
  assert.equal(LOGO.mark, "logo");
  assert.equal(LOGO.ack, true);
  assert.equal(LOGO.updatersOnly, true);
  // PS 1.74: the only app icon is the Cake icon (mac/icon/hatch-1024.png); the old white PS icon is gone from the code.
  assert.ok(existsSync(new URL("../src/assets/cake-icon.png", import.meta.url)), "the app logo (the 1.72 Cake icon) is bundled");
  assert.ok(!existsSync(new URL("../src/assets/ps-icon.png", import.meta.url)), "the old white PS icon is not bundled any more");
  assert.ok(!/[–—]/.test(JSON.stringify(LOGO)));
});

ok("who: an updater is open, a first install is done (retired, never shown), and any doubt waits", () => {
  assert.equal(updaterAnswer({ ...base, accountOlder: true }), "open", "the account holds data older than this build");
  assert.equal(updaterAnswer({ ...base, seenAtStart: "1.61" }), "open", "this device had handled 1.61");
  assert.equal(updaterAnswer({ ...base, seenAtStart: "1.9" }), "open", "versions compare by number");
  assert.equal(updaterAnswer(base), "done", "a first install: nothing older, nothing seen");
  assert.equal(updaterAnswer({ ...base, seenAtStart: "1.62" }), "done", "only this version seen and no older data: a first install");
  assert.equal(updaterAnswer({ ...base, seenAtStart: "nonsense" }), "done");
  assert.equal(updaterAnswer({ ...base, unlocked: false, accountOlder: true }), "unknown", "locked: wait");
  assert.equal(updaterAnswer({ ...base, docs: 0, accountOlder: true }), "unknown", "nothing loaded yet: wait, never guess");
  assert.equal(updaterAnswer({ ...base, accountOlder: true, done: [LOGO.id] }), "done", "Ok on another device");
});

ok("an updater sees it once, about a minute after the update, and Ok means never again", () => {
  let s = emptyState();
  s = addActive(s, { version: "V1.62", deltaMs: 10_000, idleMs: 0, listShown: true });
  assert.deepEqual(pick(s, calm(T0)), { wait: "notActive" }, "never right after the update");
  for (let i = 0; i < 6; i++) s = addActive(s, { version: "V1.62", deltaMs: 10_000, idleMs: 0, listShown: true });
  assert.ok(showsLogo(s, calm(T0)), "after a minute of active use");
  s = markShown(s, LOGO.id, T0);
  s = answer(s, LOGO.id, "show");   // Ok (Esc and Back are Ok too for this one)
  assert.equal(s.recs[LOGO.id].closed, true);
  for (const later of [1, 3, 30, 400]) {
    const p = pick({ ...s, lastAt: 0 }, calm(T0 + later * 86_400_000));
    assert.ok(!p || !("show" in p) || p.show.id !== LOGO.id, `not again after ${later} days`);
  }
  assert.ok(!showsLogo(addActive(s, { version: "V1.63", deltaMs: 1, idleMs: 0, listShown: true }), calm(T0 + 9e9)), "nor after the next update");
});

ok("a fresh install never sees it: the probe says done and it is retired for good", () => {
  const s = retire(used(), LOGO.id, T0);
  assert.ok(!showsLogo(s, calm(T0)));
  assert.ok(!showsLogo(s, calm(T0 + 365 * 86_400_000)));
  assert.ok(!showsLogo(used(), calm(T0, { notForThem: [LOGO.id] })), "done or unknown keeps it out of the choice");
});

ok("never over another card, nor in Sleep, Sentry or Do Not Disturb, nor while sharing or full screen", () => {
  const s = used();
  for (const [k, why] of [["islandBusy", "busy"], ["sleep", "sleep"], ["sentry", "sentry"], ["dnd", "dnd"], ["sharing", "sharing"], ["fullScreen", "fullScreen"]] as const) {
    assert.deepEqual(pick(s, calm(T0, { [k]: true })), { wait: why }, k);
  }
  assert.deepEqual(pick(s, calm(T0, { off: true })), { wait: "off" }, "the Did you know? intros switch still rules it");
  assert.ok(showsLogo(s, calm(T0)), "the next free moment it shows");
});

ok("once per person: Ok is saved with the settings, and the saved list is cleaned", () => {
  assert.deepEqual(cleanDone([LOGO.id, LOGO.id, "Bad Id", 3, null]), [LOGO.id]);
  assert.deepEqual(cleanDone(undefined), []);
  assert.deepEqual(cleanDone("new-logo-162"), []);
  const v = file("src/views/FeatureIntro.tsx");
  assert.match(v, /"new-logo-162": async \(_can, s\) => updaterProbe\("new-logo-162", s\),/);
  assert.match(v, /if \(INTROS\.find\(\(d\) => d\.id === id\)\?\.ack\) \{\n\s+const done = cleanDone\(settingsData\(live\.current\.s\)\.introsDone\);\n\s+if \(!done\.includes\(id\)\) void saveSettings\(\{ introsDone: \[\.\.\.done, id\] \}\)/);
  assert.match(v, /accountOlder: unlocked && accountOlderThan\(BUILT, \[\.\.\.s\.docs\.values\(\)\]\.map\(\(d\) => d\.updatedAt\)\)/, "the same signal What's new uses");
  assert.match(v, /const SEEN_AT_START: string \| null = \(\(\) => \{ try \{ const v = localStorage\.getItem\(WN_SEEN_KEY\);/, "read at load, before What's new records 1.62");
});

ok("Ok, Esc and Back all close it for good; there is no Later button and no guide", () => {
  const v = file("src/views/FeatureIntro.tsx");
  assert.match(v, /if \(def\.ack\) a = "show";/);
  assert.match(v, /if \(a === "show" && !def\.ack && !def\.choice\) \{ setGuide\(true\); setPhase\("guide"\); return; \}/);
  assert.match(v, /\{!def\.ack && def\.later && <button/);
  assert.match(v, /\{def\.ask && <p className="fi-ask">\{def\.ask\}<\/p>\}/);
  assert.match(v, /logo: \(n\) => <img src=\{logoPng\}/);
  assert.match(v, /import logoPng from "\.\.\/assets\/cake-icon\.png";/);
});

ok("where: the Mac (from the island) and the website and the phone (the same card, plain)", () => {
  assert.match(file("src/views/PsApp.tsx"), /<FeatureIntroHost \/>/);
  assert.match(file("src/App.tsx"), /\{WEBSITE_WN && <FeatureIntroHost \/>\}/);
});

// ---------- the fancy part (the developer: "very round and smooth animations ... the logo coming out of the dynamic island, with nice chime sounds") ----------
const css = file("src/views/featureintro.css");
ok("the logo comes out of the island: it starts tiny inside the island and springs out with a soft overshoot, a glow and a shine", () => {
  assert.match(css, /@keyframes fi-emerge \{ from \{ opacity: 0; transform: translateY\(-84px\) scale\(\.14\); \}/);
  assert.match(css, /\.fi-logo \{[^}]*animation: fi-emerge \.9s \.08s var\(--fi-spring\) both;/, "on the island spring (it peaks past 1 and settles)");
  assert.match(css, /\.fi-logo-glow \{[^}]*animation: fi-glow /);
  assert.match(css, /\.fi-logo-shine::after \{[^}]*animation: fi-shine \.85s \.64s /);
  assert.match(css, /\.fi-layer\.isl\.fi-ack \.fi-card \{ border-radius: 0 0 40px 40px; animation: fi-grow \.8s var\(--fi-spring\) both; \}/, "hangs from the island, same black, rounder");
  assert.match(css, /\.fi-ack \.fi-head \{[^}]*animation: fi-text \.5s \.6s ease both;/, "then the words");
  assert.match(css, /\.fi-ack \.fi-btns \{[^}]*animation: fi-text \.45s \.82s ease both;/, "then Ok");
  assert.equal(LOGO_MOMENT.outDelay, 80); assert.equal(LOGO_MOMENT.outDur, 900); assert.equal(LOGO_MOMENT.words, 600); assert.equal(LOGO_MOMENT.ok, 820); assert.equal(LOGO_MOMENT.shine, 640);
  assert.ok(LOGO_MOMENT.land > LOGO_MOMENT.outDelay && LOGO_MOMENT.land < LOGO_MOMENT.outDelay + LOGO_MOMENT.outDur, "the chime lands inside the spring");
});
ok("on Ok: the words go, the logo sinks back into the island, then the card folds back up (the times match the code)", () => {
  assert.match(css, /\.fi-layer\.fi-ack\.out \.fi-logo \{ animation: fi-sink \.3s /);
  assert.match(css, /@keyframes fi-sink \{ to \{ opacity: 0; transform: translateY\(-84px\) scale\(\.14\); \} \}/, "back to where it came from");
  assert.match(css, /\.fi-layer\.isl\.fi-ack\.out \.fi-card \{ animation: fi-back \.3s \.26s /);
  assert.equal(LOGO_MOMENT.backLogo, 300);
  assert.equal(LOGO_MOMENT.backCard, 260 + 300, "the page lets the island go only once the card has folded");
  assert.match(file("src/views/FeatureIntro.tsx"), /window\.setTimeout\(\(\) => onGone\(\), quick \? \(def\.ack \? 220 : 0\) : def\.ack \? LOGO_MOMENT\.backCard : 340\);/);
});
ok("sounds: a soft chime as the logo lands, only with the island's sounds on and never in Do Not Disturb; a light click on Ok", () => {
  assert.equal(logoChime({ islandSounds: true, dnd: false }), true);
  assert.equal(logoChime({ islandSounds: false, dnd: false }), false, "Settings, Island, sounds off");
  assert.equal(logoChime({ islandSounds: true, dnd: true }), false, "Do Not Disturb mutes it");
  const v = file("src/views/FeatureIntro.tsx");
  assert.match(v, /if \(logoChime\(\{ islandSounds: islandPrefs\(st\.island\)\.sounds, dnd: dndActive\(st\.dnd, Date\.now\(\)\) \}\)\) sfx\.island\("done"\);\n\s+\}, calm \? 0 : LOGO_MOMENT\.land\);/);
  assert.match(v, /if \(def\.ack\) return;   \/\/ V1\.62 the logo moment chimes as the logo lands/, "no second chime when the card first draws");
  assert.match(v, /onClick=\{\(\) => \{ sfx\.click\(\); finish\("show"\); \}\}>\{def\.show\}/);
});
ok("reduced motion: a simple fade in and out, no swoop, no glow, no shine", () => {
  const rm = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(rm, /\.fi-ack \.fi-card \{ animation: fi-fade \.25s ease both !important; \}/);
  assert.match(rm, /\.fi-layer\.fi-ack\.out \.fi-card \{ animation: fi-hide \.2s ease both !important; \}/);
  assert.match(rm, /\.fi-ack \.fi-logo, \.fi-ack \.fi-head, \.fi-ack \.fi-btns, \.fi-ack \.fi-logo-shine::after \{ animation: none !important; \}/);
  assert.match(rm, /\.fi-ack \.fi-logo-glow, \.fi-ack \.fi-logo-shine \{ display: none; \}/);
});
ok("the card is placed for its own width under the island, the big logo, the words, one button", () => {
  const v = file("src/views/FeatureIntro.tsx");
  assert.match(v, /attachedLayout\(anchor, window\.innerWidth, def\.ack \? ACK_W : CARD_W\)/);
  assert.match(v, /const ACK_W = 260, LOGO_PX = 92;/);
  assert.match(v, /<span className="fi-logo" aria-hidden="true"><span className="fi-logo-glow" \/>\{MARKS\[def\.mark\]\(LOGO_PX\)\}<span className="fi-logo-shine" \/><\/span>/);
  assert.doesNotMatch(css, /[\u2013\u2014]/);
});

console.log(`${n} ok`);
