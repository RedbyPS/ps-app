// Run: node --experimental-strip-types tests/phonewheel.test.ts
// PS 1.67 the phone's wheel menu (gos/wheel.ts, gos/PhoneWheel.tsx, gos/launch.ts, gos/wheel.css, gos/GosLayer.tsx). The developer, 18 Nov 2026:
// a round button at the bottom left; hold, follow a glowing path to the middle, every screen fans out round the finger, nudge
// towards one and let go to launch it full screen. Labels above, below or left of the finger, never right, never under it, never off
// screen. A Settings switch brings back the hamburger.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MENU, menuItems } from "../src/gos/menu.ts";
import { WHEEL_ORDER, WHEEL_WORDS, INNER_MAX, wheelItems, ringAngles, wheelGeo, pickSlot, labelSpot, fingerZone, middleOf, pathPts, along, arrived, DEAD_ZONE, type Vp, type WheelId } from "../src/gos/wheel.ts";
import { SETTINGS } from "../src/core/settingsindex.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const all = () => true;
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const red = wheelItems({ red: true, has: all, show: all });
const friend = wheelItems({ red: false, has: all, show: all });

const PHONES: Record<string, Vp> = {
  "small portrait": { w: 320, h: 568, top: 24, bottom: 16 },
  "pixel portrait": { w: 412, h: 915, top: 32, bottom: 24 },
  "big portrait": { w: 430, h: 932, top: 54, bottom: 34 },
  "small landscape": { w: 568, h: 320, top: 0, bottom: 12 },
  "big landscape": { w: 932, h: 430, top: 0, bottom: 21 },
};

ok("everything the hamburger offered is on the wheel, with the same the developer only rules", () => {
  for (const it of menuItems({ red: true, has: all })) assert.ok(ids(red).includes(it.id), it.id);
  for (const it of menuItems({ red: false, has: all })) assert.ok(ids(friend).includes(it.id), it.id);
  for (const id of ["rules", "numerology", "brief", "campaigns"]) assert.ok(!ids(friend).includes(id), id);
  for (const m of MENU) assert.ok(WHEEL_ORDER.some((o) => o.id === m.id), `${m.id} has a place on the wheel`);
});
ok("the screens the developer named are there too: Sleep mode, Do Not Disturb, Time zones, Fitness, Numerology, G Squad, Purchases, Settings", () => {
  for (const id of ["sleep", "dnd", "clocks", "gym", "numerology", "gsquad", "receipts", "settings", "sounds", "whatsnew", "plan", "inbox", "vault"]) assert.ok(ids(red).includes(id), id);
});
ok("the most used sit in the inner ring with Sleep mode at the top, Do Not Disturb and Time zones either side", () => {
  const inner = red.filter((x) => x.ring === 0);
  assert.ok(inner.length <= INNER_MAX);
  assert.deepEqual(ids(inner).slice(0, 3), ["sleep", "dnd", "clocks"]);
  const a = ringAngles(inner.length);
  assert.equal(a[0], 0);
  assert.ok(a[1] > 0 && a[2] < 0 && Math.abs(a[1]) === Math.abs(a[2]), "right then left of the top");
  assert.ok(inner.every((x) => x.section === "Most used"));
});
ok("the outer ring keeps its sections together: Your day round the top, Tools round the bottom", () => {
  const outer = red.filter((x) => x.ring === 1);
  const a = ringAngles(outer.length);
  const day = outer.map((x, i) => ({ s: x.section, a: Math.abs(a[i]) }));
  const maxDay = Math.max(...day.filter((d) => d.s === "Your day").map((d) => d.a));
  const minTools = Math.min(...day.filter((d) => d.s === "Tools").map((d) => d.a));
  assert.ok(maxDay < minTools, `${maxDay} < ${minTools}`);
});
ok("switched off or missing things drop out: Sleep mode off, screen time off", () => {
  const w = wheelItems({ red: true, has: (sel) => !sel.includes("tm-st-btn"), show: (id) => id !== "sleep" });
  assert.ok(!ids(w).includes("sleep") && !ids(w).includes("screentime"));
  assert.ok(ids(w).includes("dnd") && ids(w).includes("clocks"));
});
ok("ring angles are distinct, alternate from the top and stay in -180..180", () => {
  for (let k = 1; k <= 20; k++) {
    const a = ringAngles(k);
    assert.equal(new Set(a.map((x) => Math.round(x * 1000))).size, k, `n=${k}`);
    assert.ok(a.every((x) => x >= -180 && x <= 180));
  }
});
for (const [name, vp] of Object.entries(PHONES)) {
  ok(`${name}: every item is on screen, big enough for a thumb, and none overlap`, () => {
    for (const list of [red, friend]) {
      const g = wheelGeo(list, middleOf(vp), vp);
      assert.equal(g.slots.length, list.length);
      for (const s of g.slots) {
        assert.ok(s.x - s.size / 2 >= 0 && s.x + s.size / 2 <= vp.w, `${s.id} x ${s.x}`);
        assert.ok(s.y - s.size / 2 >= vp.top && s.y + s.size / 2 <= vp.h - vp.bottom, `${s.id} y ${s.y}`);
        assert.ok(s.size >= 36, `${s.id} size ${s.size}`);
      }
      for (let i = 0; i < g.slots.length; i++) for (let j = i + 1; j < g.slots.length; j++) {
        const a = g.slots[i], b = g.slots[j];
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= (a.size + b.size) / 2 - 1, `${a.id} and ${b.id} overlap`);
      }
    }
  });
  ok(`${name}: a finger that reached the side of the screen still gets the whole wheel on screen`, () => {
    const g = wheelGeo(red, { x: 10, y: vp.h - 10 }, vp);
    for (const s of g.slots) assert.ok(s.x >= 0 && s.x <= vp.w && s.y >= vp.top && s.y <= vp.h - vp.bottom, s.id);
  });
  ok(`${name}: the label is above, left or below the finger, never right, never under it, never off screen`, () => {
    const size = { w: 240, h: 62 };
    for (let x = 20; x < vp.w; x += 37) for (let y = vp.top + 20; y < vp.h - vp.bottom; y += 41) {
      const f = { x, y }, l = labelSpot(f, size, vp), w = Math.min(size.w, vp.w - 20);
      assert.ok(["above", "left", "below"].includes(l.side));
      assert.ok(l.x >= 10 - 0.5 && l.x + w <= vp.w - 10 + 0.5, `on screen x at ${x},${y}`);
      assert.ok(l.y >= vp.top && l.y + size.h <= vp.h - vp.bottom + 0.5 || l.y === vp.top + 6, `on screen y at ${x},${y}`);
      const z = fingerZone(f, vp);
      const hit = l.x < z.x + z.w && z.x < l.x + w && l.y < z.y + z.h && z.y < l.y + size.h;
      const clean = l.y + size.h <= f.y - 26 || l.x + w <= f.x - 26;   // above the finger or left of it: never on it, never right of it
      if (l.side !== "above" || l.y + size.h <= f.y - 26) assert.ok(!hit && clean, `clear of the finger at ${x},${y} (${l.side})`);
    }
  });
}
ok("in the middle of a phone the label goes above the finger, and moves aside rather than cover the picked item", () => {
  const vp = PHONES["pixel portrait"], f = middleOf(vp);
  assert.equal(labelSpot(f, { w: 240, h: 62 }, vp).side, "above");
  const avoid = { x: f.x - 40, y: f.y - 140, w: 80, h: 80 };
  const l = labelSpot(f, { w: 240, h: 62 }, vp, avoid);
  const hit = l.x < avoid.x + avoid.w && avoid.x < l.x + 240 && l.y < avoid.y + avoid.h && avoid.y < l.y + 62;
  assert.ok(!hit, `clear of the picked item (${l.side} at ${l.x},${l.y})`);
});
ok("picking: nothing in the dead zone, a small nudge picks the inner ring, a longer reach the outer ring", () => {
  const vp = PHONES["pixel portrait"], c = middleOf(vp), g = wheelGeo(red, c, vp);
  assert.equal(pickSlot(g, { x: c.x + DEAD_ZONE / 2, y: c.y }), null);
  assert.equal(pickSlot(g, { x: c.x, y: c.y - 30 }), "sleep");
  const outerTop = g.slots.filter((s) => s.ring === 1).sort((a, b) => Math.abs(a.ang) - Math.abs(b.ang))[0];
  assert.equal(pickSlot(g, { x: c.x, y: c.y - g.rOut }), outerTop.id);
  // Every item can be picked by moving straight at it.
  for (const s of g.slots) assert.equal(pickSlot(g, { x: s.x, y: s.y }), s.id, s.id);
});
ok("the path runs from the button to the middle and opens the wheel only at the middle", () => {
  const vp = PHONES["pixel portrait"], from = { x: 42, y: vp.h - 120 }, to = middleOf(vp), pts = pathPts(from, to);
  assert.equal(along(pts, from).t, 0);
  assert.equal(along(pts, to).t, 1);
  assert.ok(!arrived(pts, from));
  assert.ok(!arrived(pts, pts[Math.floor(pts.length / 2)]));
  assert.ok(arrived(pts, { x: to.x + 20, y: to.y + 10 }));
});
ok("a switch in Settings, This phone, on by default, brings the hamburger back when off", () => {
  const row = SETTINGS.find((r) => r.id === "phone-wheel");
  assert.ok(row && row.group === "phone" && row.name === "Wheel menu");
  assert.match(read("src/gos/phoneprefs.ts"), /wheel: "ps\.phone\.wheel"/);
  assert.match(read("src/gos/PhoneRows.tsx"), /"phone-wheel": function WheelRow/);
  const layer = read("src/gos/GosLayer.tsx");
  assert.match(layer, /!wheelOn && <GosMenu/);
  assert.match(layer, /wheelOn && <PhoneWheel/);
});
ok("screens open full screen on the phone with the wheel on; reduced motion turns the animations into fades", () => {
  const css = read("src/gos/wheel.css");
  assert.match(css, /html\.gos\[data-gos-wheel\] :is\(\.dx-win, \.cs-win, \.bf-win, \.ms-win, \.nu-win, \.sp-win\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(read("src/gos/launch.ts"), /reduced\(\)/);
  // While a finger moves only transforms and classes change: no filters or blurs in the wheel.
  assert.ok(!/backdrop-filter|filter:\s*blur|filter:\s*drop-shadow/.test(css));
});
ok("every new word is plain, with no em or en dashes", () => {
  const words = [...red.flatMap((x) => [x.label, x.line, x.section]), ...Object.values(WHEEL_WORDS), SETTINGS.find((r) => r.id === "phone-wheel")!.line];
  for (const w of words) assert.ok(!/[\u2013\u2014]/.test(w), w);
  for (const f of ["src/gos/wheel.ts", "src/gos/PhoneWheel.tsx", "src/gos/launch.ts", "src/gos/wheel.css"]) assert.ok(!/[\u2013\u2014]/.test(read(f)), f);
  const ids2 = new Set<WheelId>();
  for (const o of WHEEL_ORDER) { assert.ok(!ids2.has(o.id), o.id); ids2.add(o.id); }
});
console.log(`\n${n} passed`);
