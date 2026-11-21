// The goals timeline's shared rules (src/core/goals.ts), PS 1.72 (Jan, 21 Nov 2026): where a click's ghost goes, the To
// an AI's goal gets when only From is sent, which goals count as empty (not kept when closed), and the levels.
// Also checks the Timeline's source for the one-click rule: a click only shows the ghost, "+ New goal" or Enter adds it.
// Run: node --experimental-strip-types tests/goals.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GOAL_COLORS, GOAL_LEVELS, blankGoal, endFor, goalLevel, levelName, nextGoalColor, spanAt } from "../src/core/goals.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const local = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

ok("a click in Micro: the week it falls in, Monday to Sunday", () => {
  assert.deepEqual(spanAt("micro", local(2026, 11, 21)), { start: "2026-11-16", end: "2026-11-22" });   // a Saturday
  assert.deepEqual(spanAt("micro", local(2026, 11, 16)), { start: "2026-11-16", end: "2026-11-22" });   // the Monday itself
  assert.deepEqual(spanAt("micro", local(2026, 11, 22, 23)), { start: "2026-11-16", end: "2026-11-22" }); // late Sunday
  assert.deepEqual(spanAt("micro", local(2026, 12, 31)), { start: "2026-12-28", end: "2027-01-03" });   // across the new year
});
ok("a click in Meso: that month; in Macro: three months from the start of that month", () => {
  assert.deepEqual(spanAt("meso", local(2026, 2, 14)), { start: "2026-02-01", end: "2026-02-28" });
  assert.deepEqual(spanAt("meso", local(2028, 2, 14)), { start: "2028-02-01", end: "2028-02-29" });
  assert.deepEqual(spanAt("macro", local(2026, 11, 21)), { start: "2026-11-01", end: "2027-01-31" });
});
ok("the To an AI's goal gets when only From is sent", () => {
  assert.equal(endFor("micro", "2026-12-28"), "2027-01-03");
  assert.equal(endFor("meso", "2026-12-10"), "2026-12-31");
  assert.equal(endFor("meso", "2026-02-01"), "2026-02-28");
  assert.equal(endFor("macro", "2026-11-12"), "2027-01-31");
  assert.equal(endFor("macro", "2026-03-29"), "2026-05-31", "never moved by a clock change");
});
ok("an empty goal: no name and no notes (spaces count as nothing)", () => {
  assert.equal(blankGoal("", ""), true);
  assert.equal(blankGoal("  ", null), true);
  assert.equal(blankGoal(undefined, undefined), true);
  assert.equal(blankGoal("Launch", ""), false);
  assert.equal(blankGoal("", "what done looks like"), false, "typed notes are never thrown away");
});
ok("levels and colours", () => {
  assert.deepEqual(GOAL_LEVELS.map((l) => l.title), ["Macro", "Meso", "Micro"]);
  assert.equal(goalLevel("Macro"), "macro");
  assert.equal(goalLevel(" MICRO "), "micro");
  assert.equal(goalLevel("big"), null);
  assert.equal(goalLevel(3), null);
  assert.equal(levelName("meso"), "Meso");
  assert.equal(GOAL_COLORS.length, 8);
  assert.equal(nextGoalColor([]), GOAL_COLORS[0]);
  assert.equal(nextGoalColor(new Array(9).fill(null)), GOAL_COLORS[1]);
});
ok("the Timeline: one click only shows the ghost, and only + New goal or Enter adds a goal", () => {
  const src = readFileSync(new URL("../src/views/Goals.tsx", import.meta.url), "utf8");
  const place = src.slice(src.indexOf("const placeAt = "), src.indexOf("const create = "));
  assert.ok(place.includes("setGhost("), "a click sets the ghost");
  assert.ok(!/save\(|onSave\(/.test(place), "a click saves nothing");
  assert.ok(/>\+ New goal<\/button>/.test(src), "the + New goal button");
  assert.ok(/e\.key !== "Enter"/.test(src) && src.includes("createRef.current()"), "Enter adds it");
  assert.ok(src.includes("if (ghostRef.current) { setGhost(null); return true; }"), "Esc puts the ghost away first");
  assert.ok(src.includes("if (!goalsEsc()) onClose();"), "the window closes only when the Timeline has nothing to step back from");
  assert.ok(src.includes("blankGoal(d.title, d.note)"), "an empty goal is not kept when it closes");
  assert.ok(!/[\u2013\u2014]/.test(src + readFileSync(new URL("../src/core/goals.ts", import.meta.url), "utf8")), "no en or em dashes");
});

console.log(`goals: ${n} passed`);
