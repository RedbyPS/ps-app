// Run: node --experimental-strip-types tests/gsquad-single.test.ts
// V1.47 G Squad, the developer 10 Nov 2026: one squad ("only one squad and it's already created, called The G Squad. Get rid of
// any features to add new squads ... Anyone that downloads the PS app can automatically see the squad and click Ask to
// join"), a full screen messenger screen with simpler Squad settings and Appearance options, and the phone entry point.
// The rules in src/squad/single.ts and src/squad/looks.ts, and the source checks that matter.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const S = await import("../src/squad/single.ts");
const L = await import("../src/squad/looks.ts");

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

ok("the one squad is The G Squad", () => { assert.equal(S.THE_SQUAD, "The G Squad"); });
ok("V1.49 not in yet: one stage at a time, joining unless something says otherwise", () => {
  assert.equal(S.notInStage({ in: true, auto: null }), null);
  assert.equal(S.notInStage({ in: false, auto: null }), "joining");
  for (const st of ["joining", "left", "removed", "full", "error"] as const) assert.equal(S.notInStage({ in: false, auto: { stage: st } }), st);
});
ok("Squad settings: six simple pages in a fixed order (V1.62 adds Link my AI)", () => {
  assert.deepEqual(S.SETTINGS_PAGES.map((p) => p.id), ["share", "name", "notify", "looks", "ai"]);
  assert.equal(S.isSettingsPage("looks"), true);
  assert.equal(S.isSettingsPage("create"), false);
});

// ---------- Appearance ----------
const mem = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
ok("appearance: defaults follow PS, Large text (bigger than before), Round bubbles, Glow", () => {
  assert.deepEqual(L.DEFAULT_LOOKS, { look: "new", theme: "ps", accent: "ps", bubbles: "round", text: "l", bg: "glow" });
  assert.ok(L.textScale("l") > 1.15, "much bigger by default");
  assert.ok(L.textScale("m") < L.textScale("l") && L.textScale("l") < L.textScale("xl") && L.textScale("xl") < L.textScale("xxl"));
});
ok("appearance: anything unknown falls back field by field", () => {
  assert.deepEqual(L.cleanLooks({ theme: "neon", accent: "teal", bubbles: "x", text: "xl", bg: 3 }), { look: "new", theme: "ps", accent: "teal", bubbles: "round", text: "xl", bg: "glow" });
  assert.deepEqual(L.cleanLooks(null), L.DEFAULT_LOOKS);
  assert.deepEqual(L.cleanLooks("light"), L.DEFAULT_LOOKS);
});
ok("appearance: kept on this device; broken storage never breaks it", () => {
  const s = mem();
  assert.deepEqual(L.readLooks(s), L.DEFAULT_LOOKS);
  L.saveLooks({ look: "classic", theme: "light", accent: "blue", bubbles: "square", text: "xxl", bg: "dots" }, s);
  assert.deepEqual(L.readLooks(s), { look: "classic", theme: "light", accent: "blue", bubbles: "square", text: "xxl", bg: "dots" });
  s.setItem(L.LOOKS_KEY, "{not json");
  assert.deepEqual(L.readLooks(s), L.DEFAULT_LOOKS);
  const bad = { getItem: () => { throw new Error("off"); }, setItem: () => { throw new Error("off"); } };
  assert.deepEqual(L.readLooks(bad), L.DEFAULT_LOOKS);
  assert.doesNotThrow(() => L.saveLooks(L.DEFAULT_LOOKS, bad));
  assert.deepEqual(L.readLooks(null), L.DEFAULT_LOOKS);
});
ok("appearance: classes and variables (text size times PS's own; the accent only when chosen)", () => {
  assert.equal(L.looksClass(L.DEFAULT_LOOKS), "lk-new th-ps bb-round bg-glow");
  assert.equal(L.looksClass({ ...L.DEFAULT_LOOKS, theme: "dark", accent: "green", bubbles: "soft", bg: "plain" }), "lk-new th-dark bb-soft bg-plain acc-own");
  assert.deepEqual(L.looksVars(L.DEFAULT_LOOKS, 1), { "--k-fs": "1.22" });
  assert.equal(L.looksVars({ ...L.DEFAULT_LOOKS, text: "m" }, 1.5)["--k-fs"], "1.62");
  assert.equal(L.looksVars(L.DEFAULT_LOOKS, Number.NaN)["--k-fs"], "1.22", "no PS size: 1");
  const v = L.looksVars({ ...L.DEFAULT_LOOKS, accent: "amber" }, 1);
  assert.equal(v["--k-acc"], "#F5A524");
  assert.equal(v["--k-on-acc"], "#2A1700", "dark text on a light colour");
  for (const a of L.ACCENTS.filter((x) => x.id !== "ps")) assert.match(a.c + a.c2 + a.on, /^(#[0-9A-F]{6}){3}$/, a.id);
});
ok("appearance: every option on the Appearance page, each with a plain name", () => {
  const s = src("views/GSquadSettings.tsx");
  for (const k of ["THEMES", "ACCENTS", "BUBBLES", "TEXTS", "BGS"]) assert.match(s, new RegExp(`list=\\{${k}\\}`), k);
  assert.match(s, /setLooks\(\{ theme \}\)/);
  assert.match(s, /className="gss-preview"/, "a live preview");
  for (const l of [...L.THEMES, ...L.ACCENTS, ...L.BUBBLES, ...L.TEXTS, ...L.BGS]) assert.ok(l.label.length > 2 && !/[_-]/.test(l.label), l.label);
});

// ---------- source checks ----------
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
ok("no way to make another squad, and nothing to ask or claim: PS joins The G Squad by itself", () => {
  const g = code(src("views/GSquad.tsx"));
  for (const gone of ["Create a squad", "See available squads", "Available squads", 'op: "create"', "Squad name", "Ask to join", "Claim code", "Have an invite link", 'op: "createListed"']) assert.ok(!g.includes(gone), gone);
  assert.match(g, /Getting you into \{THE_SQUAD\}/);
  assert.match(g, /squadOp\(\{ op: "rejoin" \}\)/, "Join again and Try again");
  const e = src("squad/engine.ts");
  assert.match(e, /case "create": return;/, "an older Tab list asking to create does nothing");
  assert.ok(!/createSquad\(/.test(e), "the engine never makes a squad");
  assert.match(e, /startAuto\(\{/, "the automatic join starts with the engine");
  assert.match(src("views/GSquadLink.tsx"), /PS app puts you in The G Squad by itself/);
});
ok("full screen: no Mac window buttons, no small size; grows from the button; Esc and the phone's back step back", () => {
  const w = src("views/GSquadWindow.tsx");
  for (const gone of ["Minimize", "Maximize", "gsw-lights", "readSize", "saveSize"]) assert.ok(!w.includes(gone), gone);
  assert.match(w, /aria-label="Close"/);
  assert.match(w, /if \(e\.key !== "Escape"\) return; e\.preventDefault\(\); e\.stopImmediatePropagation\(\); step\(\);/);
  assert.match(w, /window\.addEventListener\("gos-back", back, true\)/);
  assert.match(w, /if \(asking\) return;/, "its own question to Fitness's sheets is not taken as a back");
  assert.match(w, /<SquadSettings view=\{v\} page=\{page\} onPage=\{setPage\} \/>/);
  const css = src("views/gswin.css");
  assert.match(css, /\.gsw \{[^}]*position: fixed; inset: 0;/, "fills the screen");
  for (const c of ["th-light", "th-dark", "bg-glow", "bg-dots", "bg-wash", "bg-plain", "bb-soft", "bb-square"]) assert.ok(css.includes(`.gsw.${c}`), c);
  assert.ok(!/isRedAccount|\bred\b/.test(w), "the same in private and public PS");
});
ok("the phone: one host, mounted on the phone's home, starts G Squad there; openGSquad is the menu's entry point", () => {
  const g = src("views/GSquad.tsx");
  assert.match(g, /export function GSquadHost\(\)/);
  assert.match(g, /export function openGSquad\(/);
  assert.match(g, /export function useGSquadBadge\(\)/);
  assert.match(src("views/TaskMap.tsx"), /\{isPhoneBuild\(\) && <GSquadHost \/>\}/);
  const p = src("squad/phonehost.ts");
  assert.match(p, /startSquad\(\);\s+startSquadBoard\(\);\s+startChat\(null\);\s+startGymSquad\(\);/);
  assert.match(p, /if \(started \|\| !isPhoneBuild\(\)\) return;/);
});
ok("no em or en dashes in anything new", () => {
  for (const f of ["squad/autoengine.ts", "squad/autoflows.ts", "core/squadauto.ts", "squad/single.ts", "squad/looks.ts", "squad/phonehost.ts", "views/GSquad.tsx", "views/GSquadWindow.tsx", "views/GSquadSettings.tsx", "views/gswin.css", "views/GSquadLink.tsx", "dev/gsquad-fake.ts", "squad/direngine.ts"]) {
    assert.ok(!/[–—]/.test(src(f)), f);
  }
});
console.log(`${n} passed`);
