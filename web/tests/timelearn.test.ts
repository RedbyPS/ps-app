// Run: node --experimental-strip-types tests/timelearn.test.ts
// PS 1.77 (the developer, 23 Nov 2026): PS learns a task's expected time from how long it really took (src/core/timeest.ts learnFrom,
// learnedFor, relearn, estOwner): at least 5 clean finishes; under 2 minutes is a quick tick and left out; a time more than 3 times
// the middle (or under a third of it) is far from the rest and left out; the newest 20 clean finishes; their middle, rounded. A time
// he picks or types (or No time set picked) always wins; the learned time counts as the task's expected time (it drives the island's
// timer, core/islandprogress.ts timerMin). No vault, no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as T from "../src/core/timeest.ts";
import { timerMin, progressIsland, progressPrefs, timerShows } from "../src/core/islandprogress.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok - " + name); };
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const D0 = Date.UTC(2026, 10, 1);
/** Finishes of one task name, newest first (the list allDone gives). */
const fin = (mins: number[], title = "Write the weekly report", id = "t1") => mins.map((m, i) => ({ id, n: title, m, e: 0, at: D0 - i * 86_400_000 }));

// ---------- the rules ----------
ok("the numbers: 5 needed, the newest 20, under 2 minutes is quick, 3 times the middle is far", () => {
  assert.deepEqual({ ...T.LEARN }, { need: 5, keep: 20, look: 60, quickMin: 2, far: 3 });
});
ok("fewer than 5 finishes: no learned time at all", () => {
  for (const k of [0, 1, 2, 3, 4]) assert.equal(T.learnFrom([40, 35, 45, 30].slice(0, k)).min, null, `${k} finishes`);
  assert.equal(T.learnFrom([40, 35, 45, 30, 40]).min, 40, "5: learned");
});
ok("a tick under 2 minutes is left out, and does not count towards the 5", () => {
  const l = T.learnFrom([40, 1, 35, 45, 30]);
  assert.equal(l.min, null, "4 real finishes only");
  assert.deepEqual(l.out, [{ m: 1, why: "quick" }]);
  assert.equal(T.learnFrom([40, 1, 35, 45, 30, 40]).min, 40);
});
ok("the 5 hour day of a 30 to 45 minute task is left out", () => {
  const l = T.learnFrom([30, 45, 300, 40, 35, 40]);
  assert.deepEqual(l.out, [{ m: 300, why: "far" }]);
  assert.deepEqual(l.used, [30, 45, 40, 35, 40]);
  assert.equal(l.min, 40);
  assert.equal(T.usualMin([30, 45, 300, 40, 35, 40]), 40, "the plain middle would not move much, but the 5 h day never counts now");
});
ok("a 10 minute rush of a 40 minute task is left out too (under a third of the middle)", () => {
  assert.deepEqual(T.learnFrom([40, 10, 45, 35, 40, 50]).out, [{ m: 10, why: "far" }]);
});
ok("normal spread is kept: 30 to 45 minutes, sometimes an hour", () => {
  const l = T.learnFrom([30, 45, 60, 40, 35, 50, 30]);
  assert.deepEqual(l.out, []);
  assert.equal(l.min, 40);
});
ok("the newest 20 clean finishes only (old habits fade)", () => {
  const l = T.learnFrom([...Array(20).fill(30), ...Array(20).fill(60)]);
  assert.equal(l.used.length, 20); assert.equal(l.min, 30);
});
ok("the expected time is the middle of the clean finishes, rounded as before", () => {
  assert.equal(T.learnFrom([31, 33, 34, 36, 38]).min, 35);
  assert.equal(T.learnFrom([130, 125, 140, 150, 135]).min, 140, "over 2 hours: to 10 minutes");
});
ok("only quick ticks: nothing learned, all left out as quick", () => {
  assert.deepEqual(T.learnFrom([1, 1.5, 1]), { min: null, used: [], out: [{ m: 1, why: "quick" }, { m: 1.5, why: "quick" }, { m: 1, why: "quick" }] });
});

// ---------- which finishes count ----------
ok("the same name counts (and the task's own earlier rounds), and more than 6 of them now", () => {
  const done = [...fin([40, 35, 45, 30, 40, 38, 42, 44]), ...fin([90, 90, 90, 90, 90], "Renew the domain", "t9")];
  const l = T.learnedFor(done, "Write the weekly report");
  assert.equal(l.used.length, 8); assert.equal(l.min, 40);
  assert.equal(T.learnedFor(done, "Renew the domain").min, 90);
});

// ---------- whose time it is ----------
ok("own, learned or none", () => {
  assert.equal(T.estOwner({ est: 30 }), "own");
  assert.equal(T.estOwner({ est: 30, estBy: null }), "own");
  assert.equal(T.estOwner({ est: 40, estBy: "past" }), "learned");
  assert.equal(T.estOwner({}), "none");
  assert.equal(T.estOwner({ est: null, estBy: "off" }), "own", "No time set picked: his choice, never learned over");
});
ok("relearn: fills a task with no time, updates a learned one, takes off a learned one with too few finishes, never touches his own", () => {
  const done = fin([40, 35, 45, 30, 40, 1, 300]);
  const tasks = [
    { id: "a", data: { title: "Write the weekly report" } },                              // none: gets 40
    { id: "b", data: { title: "Write the weekly report", est: 25, estBy: "past" as const } },  // learned 25: now 40
    { id: "c", data: { title: "Write the weekly report", est: 20 } },                     // his own 20: wins
    { id: "d", data: { title: "Write the weekly report", est: null, estBy: "off" as const } }, // No time set picked: stays none
    { id: "e", data: { title: "Call the bank", est: 15, estBy: "past" as const } },        // learned from one time before 1.77: taken off
    { id: "f", data: { title: "Write the weekly report", done: true } },                  // done: left alone
    { id: "g", data: { title: "Write the weekly report", est: 40, estBy: "past" as const } },  // already right: no write
  ];
  assert.deepEqual(T.relearn(tasks, done), [
    { id: "a", est: 40, estBy: "past" },
    { id: "b", est: 40, estBy: "past" },
    { id: "e", est: null, estBy: null },
  ]);
});

// ---------- it counts as the expected time ----------
ok("a learned time drives the island timer and the time up; No time set picked has none", () => {
  assert.equal(timerMin({ est: 40, estBy: "past" }), 40);
  assert.equal(timerMin({ est: 30, estBy: null }), 30);
  assert.equal(timerMin({ est: null, estBy: "off" }), 0);
  const T0 = Date.UTC(2026, 10, 23, 10);
  const p = progressIsland({ prefs: progressPrefs({ on: true }), featureOn: true, trackOn: true, task: { id: "a", title: "Write the weekly report", dim: false },
    todo: { est: 40, estBy: "past" }, spent: 0, round: T0, now: T0, quiet: false })!;
  assert.equal(p.est, 40); assert.equal(timerShows(p, T0 + 60_000), true);
});

// ---------- the words and the wiring ----------
ok("the words", () => {
  assert.equal(T.TE_WORDS.learned(7, 40), "Learned from your last 7 times: 40 min");
  assert.equal(T.TE_WORDS.learnsAfter(3), "PS learns the expected time after 5 times (3 so far)");
  assert.equal(T.outWords([{ m: 1, why: "quick" }, { m: 300, why: "far" }]), "1 min (too quick), 5 h (far from the rest)");
  assert.ok(!/[–—]/.test(JSON.stringify([T.TE_WORDS.learnIt, T.TE_WORDS.leftOut, T.TE_WORDS.quick, T.TE_WORDS.far, T.TE_WORDS.learnedTip, T.TE_WORDS.past, T.TE_WORDS.learned(5, 40), T.TE_WORDS.learnsAfter(1)])));
});
ok("new tasks, every finish, and the vault opening relearn; his own pick is marked so PS never learns over it", () => {
  const ts = read("../src/core/timesave.ts");
  assert.match(ts, /T\.learnedFor\(T\.allDone\(/, "a new task: 5 clean finishes or none");
  assert.match(ts, /await relearnIn\(vaultStore\.get\(\)\);/, "after a finish");
  assert.match(ts, /RELEARN_EVERY_MS/, "when the vault opens, then every 6 hours at most");
  assert.match(read("../src/views/TaskMap.tsx"), /patch\.estBy = est === null \? "off" : null/);
  assert.match(read("../src/views/TimeEstimate.tsx"), /estBy: m === null \? "off" : null/);
  assert.match(read("../src/ps.ts"), /p\?\.estBy === "off"/);
  assert.match(read("../src/views/TimeEstimate.tsx"), /T\.TE_WORDS\.learned\(past\.length, learned\.min\)/, "Edit shows what was learned");
});
console.log(`\n${n} passed`);
