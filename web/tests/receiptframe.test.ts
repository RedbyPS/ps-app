// Run: node --experimental-strip-types tests/receiptframe.test.ts
// Receipt scan framing (core/receiptframe.ts): the picture read is what the camera preview showed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const F = await import("../src/core/receiptframe.ts");

let n = 0;
const ok = async (name: string, fn: () => unknown) => { await fn(); n++; console.log("ok -", name); };
const near = (a: number, b: number, d = 0.002) => Math.abs(a - b) <= d;

await ok("a portrait phone showing a portrait stream: only the sides are cut", () => {
  const f = F.coverCrop(1080, 1920, 412, 915);
  assert.ok(near(f.h, 1) && near(f.y, 0));
  assert.ok(near(f.w, (412 / 915) / (1080 / 1920)), `w ${f.w}`);
  assert.ok(near(f.x, (1 - f.w) / 2));
});

await ok("a portrait phone showing a lying 16:9 stream: only a narrow middle strip is on screen", () => {
  const f = F.coverCrop(1920, 1080, 412, 915);
  assert.ok(near(f.h, 1));
  assert.ok(f.w < 0.26 && f.w > 0.24, `w ${f.w}`);
});

await ok("a bad size never crops", () => {
  assert.deepEqual(F.coverCrop(0, 0, 400, 800), { x: 0, y: 0, w: 1, h: 1 });
});

await ok("a 4:3 still behind a 16:9 stream: cut to the stream's shape, then to what the screen showed", () => {
  const f = F.coverCrop(1080, 1920, 412, 915);
  const r = F.stillRect(3024, 4032, 1080, 1920, f);
  // the stream is the middle 9:16 of the 3:4 sensor: 3024 wide, 5376 would be needed, so the height is the limit
  const bw = 4032 * (1080 / 1920);
  assert.ok(Math.abs(r.h - 4032) <= 1);
  assert.ok(Math.abs(r.w - bw * f.w) <= 1, `w ${r.w}`);
  assert.ok(Math.abs(r.x - ((3024 - bw) / 2 + f.x * bw)) <= 1);
  assert.ok(r.x + r.w <= 3024 && r.y + r.h <= 4032);
});

await ok("a still of the same shape: the same fractions", () => {
  const r = F.stillRect(2000, 4000, 500, 1000, { x: 0.1, y: 0.2, w: 0.5, h: 0.5 });
  assert.deepEqual(r, { x: 200, y: 800, w: 1000, h: 2000 });
});

await ok("orientation and likeness", () => {
  assert.equal(F.sameTurn(1080, 1920, 3024, 4032), true);
  assert.equal(F.sameTurn(1080, 1920, 4032, 3024), false);
  const a = Array.from({ length: 64 }, (_, i) => (i * 37) % 255);
  assert.ok(F.likeness(a, a.map((v) => v * 0.5 + 40)) > 0.99, "the same picture, darker");
  assert.ok(F.likeness(a, a.map((v) => 255 - v)) < 0);
  assert.equal(F.likeness([1, 1, 1, 1], [1, 2, 3, 4]), 0);
});

await ok("sizes are only made smaller", () => {
  assert.deepEqual(F.fitSize(3000, 4000, 3200), { w: 2400, h: 3200 });
  assert.deepEqual(F.fitSize(800, 1200, 3200), { w: 800, h: 1200 });
});

await ok("no dashes in the framing code or its test", () => {
  for (const f of ["../src/core/receiptframe.ts", "./receiptframe.test.ts"]) assert.ok(!/[\u2013\u2014]/.test(readFileSync(new URL(f, import.meta.url), "utf8")), f);
});

console.log(`receiptframe: ${n} passed`);
