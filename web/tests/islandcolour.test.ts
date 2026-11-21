// Run: node --experimental-strip-types tests/islandcolour.test.ts
// PS 1.72 (Jan, 21 Nov 2026): his island was black, he picked white, it stayed black and its colour could not be changed.
// 1. A colour picked always sticks: through the Tab list's patch, the main window's clean (ps.ts cleanLooks uses
//    core/island.ts islandPrefs), the one settings write (keep unknown carry, settingsWrite) and a merge with an older
//    server copy (cardsync.ts mergeSettings). Black to white, white to black, any colour, and back to none.
// 2. The colour shows: with Around the notch chosen the Mac draws a pill wherever it cannot go round a notch, and that
//    pill now takes the colours picked for Around the notch (core/island.ts pillShown). FICTIONAL settings only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { islandPrefs, islandState, pillShown } from "../src/core/island.ts";
import { PILL_DEFAULT, pillTones } from "../src/core/islandlook.ts";
import { carrySettings } from "../src/core/keepunknown.ts";
import { mergeSettings, settingsWrite } from "../src/core/cardsync.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const DEFAULTS = { ownerName: "Owner", autoLockMin: 15 } as any;
const COLOURS = ["#000000", "#ffffff", "#ff2e3e", "#1d2b53", "#f4f1ea", "#3dff7a", null];

/** One pick in the look editor, saved the whole way (views/IslandSettings.tsx, TaskMap.tsx, ps.ts, actions.ts). */
function pick(stored: any, kind: "pill" | "notch", target: "fill" | "color", c: string | null) {
  const cur = islandPrefs(stored.island);
  const look = { ...cur[kind], [target]: c };
  const fromTab = { island: { ...cur, mode: kind, [kind]: look } };          // TaskMap.tsx: { ...islandPrefs(st.island), ...p }
  const cleaned = { island: islandPrefs(fromTab.island) };                    // ps.ts cleanLooks
  const w = settingsWrite(stored, carrySettings(stored, cleaned as any), DEFAULTS, true);
  return w;
}

ok("every colour picked for either look, Background or Accent, is what the record holds", () => {
  for (const kind of ["pill", "notch"] as const) for (const target of ["fill", "color"] as const) {
    for (const from of COLOURS) for (const to of COLOURS) {
      const stored = { island: islandPrefs({ mode: kind, [kind]: { [target]: from } }) };
      const w = pick(stored, kind, target, to);
      assert.equal((w.data as any).island[kind][target], to, `${kind} ${target} ${from} to ${to}`);
      if (from !== to) assert.ok(w.changed.includes("island"), "the change is counted as one");
    }
  }
});

ok("Jan's case: black, then white, sticks even when the server's copy is still black", () => {
  const black = { island: islandPrefs({ mode: "notch", notch: { style: "drop", fill: "#000000" } }) };
  const w = pick(black, "notch", "fill", "#ffffff");
  // Before it goes up, the server's older copy arrives: only what this device changed comes from it, and that is island.
  const merged = mergeSettings(w.data, black as any, new Set(w.changed));
  assert.equal((merged as any).island.notch.fill, "#ffffff");
  // And again from white back to black.
  const back = pick(merged, "notch", "fill", "#000000");
  assert.equal((back.data as any).island.notch.fill, "#000000");
});

ok("no cleaner turns black or white away (nor 3 digit codes, upper case, or a space)", () => {
  for (const c of ["#000000", "#ffffff", "#FFFFFF", "#fff", " #000 "]) {
    const p = islandPrefs({ pill: { fill: c }, notch: { fill: c } });
    assert.ok(p.pill.fill === "#000000" || p.pill.fill === "#ffffff", c);
    assert.equal(p.notch.fill, p.pill.fill, c);
  }
});

ok("Around the notch: the pill the Mac draws in its place takes the colours picked for it", () => {
  const prefs = islandPrefs({ mode: "notch", pill: { style: "classic" }, notch: { style: "drop", fill: "#ffffff", color: "#3d7bff" } });
  const shown = pillShown(prefs);
  assert.equal(shown.fill, "#ffffff");
  assert.equal(shown.color, "#3d7bff");
  assert.equal(shown.style, "classic", "the Pill look's own style stays");
  const st = islandState({ todos: [], settings: { island: prefs } as any, today: "2026-11-21", mail: 0, leads: 0, event: null });
  const { backs: _b, ...white } = pillTones(shown);
  assert.deepEqual(st.pill, white, "the state the Mac gets paints the white pill");
  assert.equal((st.pill as any).bg, "#ffffff");
});

ok("nothing changes for anyone who picked no colour for Around the notch, or chose the pill", () => {
  const plain = islandPrefs({ mode: "notch", pill: { style: "solid", fill: "#5b1a2e" } });
  assert.deepEqual(pillShown(plain), plain.pill);
  const pill = islandPrefs({ mode: "pill", pill: { style: "classic", fill: "#ffd21f" }, notch: { fill: "#ffffff" } });
  assert.deepEqual(pillShown(pill), pill.pill, "Pill below the notch: the Pill look, as always");
  assert.deepEqual(pillShown(islandPrefs({})), PILL_DEFAULT);
  // Only the colour that was picked: an Accent alone keeps the pill's own Background.
  const accent = pillShown(islandPrefs({ mode: "notch", pill: { fill: "#0f4c3a" }, notch: { color: "#ff3dc8" } }));
  assert.equal(accent.fill, "#0f4c3a");
  assert.equal(accent.color, "#ff3dc8");
});

ok("the Mac keeps no colour of its own: Island.swift only paints the tones in the state (wired)", () => {
  const ps = readFileSync(new URL("../src/ps.ts", import.meta.url), "utf8");
  assert.match(ps, /if \(p\.island && typeof p\.island === "object"\) o\.island = islandPrefs\(p\.island\);/);
  const isl = readFileSync(new URL("../src/core/island.ts", import.meta.url), "utf8");
  assert.match(isl, /pillTones\(pillShown\(prefs\)\)/);
});

console.log(`islandcolour: ${n} ok`);
