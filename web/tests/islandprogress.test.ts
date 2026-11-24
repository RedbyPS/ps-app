// Run: node --experimental-strip-types tests/islandprogress.test.ts
// PS 1.77 progress check-ins and task timers on the Dynamic Island (src/core/islandprogress.ts): the setting and its one question,
// the per task interval, which expected times get a timer, what the Mac is sent, when it buzzes and what keeps it from buzzing,
// the timer's time left, the words, and where it is wired in. ps-mac tests/island-progress-test.swift checks the Mac's copy of
// the same rules. No vault, no network, no clock of its own.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as P from "../src/core/islandprogress.ts";
import { islandPrefs } from "../src/core/island.ts";
import { EST_CHOICES, emptyLive, spentMin, spentMs, roundStart, startClock, stopClock, finishClock } from "../src/core/timeest.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok - " + name); };
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 23, 10, 0);
const task = { id: "t1", title: "Write the pitch deck", dim: false };
const base = (o: Partial<P.ProgressInput> = {}): P.ProgressInput => ({
  prefs: P.progressPrefs({ on: true }), featureOn: true, trackOn: true, task, todo: { done: false },
  spent: 0, round: T0, now: T0, quiet: false, ...o,
});
const isl = (o: Partial<P.ProgressInput> = {}) => P.progressIsland(base(o))!;

// ---------- the setting ----------
ok("on by default: never answered is null so the first card has a choice", () => {
  const p = P.progressPrefs(undefined);
  assert.deepEqual(p, { on: null, every: 30, look: "ring" });
  assert.equal(P.progressOn(p), true); assert.equal(P.offerDue(p), true);
  assert.deepEqual(islandPrefs(undefined).progress, p, "kept with the island's other settings");
});
ok("answered: on or off, and the question is never due again", () => {
  assert.equal(P.progressOn(P.progressPrefs({ on: true })), true);
  assert.equal(P.offerDue(P.progressPrefs({ on: true })), false);
  assert.equal(P.progressOn(P.progressPrefs({ on: false })), false);
  assert.equal(P.offerDue(P.progressPrefs({ on: false })), false);
  assert.equal(P.progressPrefs({ on: "yes" }).on, null, "anything odd: not answered");
});
ok("the interval: 30 minutes by default, kept from 5 minutes to 4 hours", () => {
  assert.equal(P.progressPrefs({ every: 45 }).every, 45);
  assert.equal(P.progressPrefs({ every: 1 }).every, 5);
  assert.equal(P.progressPrefs({ every: 999 }).every, 240);
  assert.equal(P.progressPrefs({ every: "20" }).every, 30, "a string from an old copy: the default");
  assert.deepEqual([...P.EVERY_CHOICES], [15, 30, 45, 60, 90]);
});
ok("the four looks, the ring by default", () => {
  assert.deepEqual(P.LOOKS.map((x) => x.k), ["ring", "sand", "text", "line"]);
  for (const k of ["ring", "sand", "text", "line"]) assert.equal(P.progressPrefs({ look: k }).look, k);
  assert.equal(P.progressPrefs({ look: "spiral" }).look, "ring");
});
ok("saving another island setting keeps this one (the Settings page saves the whole island object)", () => {
  const was = islandPrefs({ progress: { on: true, every: 45, look: "sand" } });
  assert.deepEqual(islandPrefs({ ...was, hide: 30 }).progress, { on: true, every: 45, look: "sand" });
});

// ---------- per task ----------
ok("per task: none is the Settings interval, 0 is no check-ins on it, else its own minutes", () => {
  const p = P.progressPrefs({ on: true, every: 30 });
  assert.equal(P.everyFor(p, {}), 30);
  assert.equal(P.everyFor(p, { checkEvery: null }), 30);
  assert.equal(P.everyFor(p, { checkEvery: 0 }), 0);
  assert.equal(P.everyFor(p, { checkEvery: 15 }), 15);
  assert.equal(P.cleanCheckEvery(2), 5); assert.equal(P.cleanCheckEvery(600), 240);
  assert.equal(P.cleanCheckEvery(-3), null); assert.equal(P.cleanCheckEvery("15"), null);
});
ok("a typed interval: 5 minutes to 4 hours", () => {
  assert.equal(P.parseEvery("20"), 20); assert.equal(P.parseEvery("1h"), 60); assert.equal(P.parseEvery("1:30"), 90);
  assert.equal(P.parseEvery("2"), null); assert.equal(P.parseEvery("5h"), null); assert.equal(P.parseEvery("soon"), null);
});
ok("the timer: an expected time he picked or typed, or one PS learned from 5 or more clean finishes (PS 1.77, tests/timelearn.test.ts)", () => {
  assert.equal(P.timerMin({ est: 45 }), 45);
  assert.equal(P.timerMin({ est: 45, estBy: null }), 45);
  assert.equal(P.timerMin({ est: 40, estBy: "past" }), 40, "learned: it counts as the expected time");
  assert.equal(P.timerMin({ est: null, estBy: "off" }), 0, "No time set picked");
  assert.equal(P.timerMin({}), 0); assert.equal(P.timerMin(null), 0);
});
ok("the expected time quick picks are the developer's: 10, 20, 30, 45 min, 1 h, 2 h, 5 h (and a box to type any time)", () => {
  assert.deepEqual([...EST_CHOICES], [10, 20, 30, 45, 60, 120, 300]);
});

// ---------- what the Mac is sent ----------
ok("a task being worked on, its clock running: the Mac gets the start it counts from", () => {
  const p = isl({ spent: 12 * MIN, now: T0 + 20 * MIN, round: T0 });
  assert.equal(p.since, T0 + 8 * MIN, "now minus the time spent (8 minutes of breaks taken off)");
  assert.equal(p.round, T0); assert.equal(p.every, 30); assert.equal(p.est, 0);
  assert.equal(p.on, true); assert.equal(p.ask, false); assert.equal(p.look, "ring"); assert.equal(p.title, task.title);
  assert.deepEqual(p.words, P.PROGRESS_WORDS);
});
ok("the start stays the same from one send to the next (the island never jumps)", () => {
  const a = isl({ spent: 10 * MIN, now: T0 + 10 * MIN }), b = isl({ spent: 11 * MIN, now: T0 + 11 * MIN });
  assert.equal(a.since, b.since);
});
ok("nothing to count: off and answered, the feature off, time spent off, no task, a next up task, stopped, done, nothing set", () => {
  assert.equal(P.progressIsland(base({ prefs: P.progressPrefs({ on: false }) })), null);
  assert.equal(P.progressIsland(base({ featureOn: false })), null);
  assert.equal(P.progressIsland(base({ trackOn: false })), null);
  assert.equal(P.progressIsland(base({ task: null })), null);
  assert.equal(P.progressIsland(base({ task: { ...task, dim: true } })), null, "dimmed: next up, not worked on");
  assert.equal(P.progressIsland(base({ spent: null })), null, "its clock is not running");
  assert.equal(P.progressIsland(base({ todo: { done: true } })), null);
  assert.equal(P.progressIsland(base({ todo: undefined })), null);
  assert.equal(P.progressIsland(base({ todo: { checkEvery: 0 } })), null, "no check-ins on this task and no expected time");
});
ok("no check-ins on a task with an expected time: still its timer", () => {
  const p = isl({ todo: { checkEvery: 0, est: 45 } });
  assert.equal(p.every, 0); assert.equal(p.est, 45);
});
ok("never answered: sent enabled with the first card choice due", () => {
  const p = isl({ prefs: P.progressPrefs(undefined), todo: { est: 20 } });
  assert.equal(p.on, true); assert.equal(p.ask, true);
  assert.equal(P.timerShows(p, T0 + MIN), true);
});
ok("Do Not Disturb is sent as quiet", () => assert.equal(isl({ quiet: true }).quiet, true));

// ---------- when it buzzes ----------
ok("every 30 minutes of work, even with no time set on the task", () => {
  const p = isl();
  assert.equal(P.buzzDue(p, T0 + 29 * MIN), null);
  const b = P.buzzDue(p, T0 + 30 * MIN)!;
  assert.equal(b.kind, "check"); assert.equal(b.minutes, 30); assert.equal(b.leftMs, null);
  assert.deepEqual(b.keys, [P.buzzKey(p, "1")]);
  assert.equal(P.buzzDue(p, T0 + 30 * MIN, new Set(b.keys)), null, "once");
  assert.equal(P.buzzDue(p, T0 + 60 * MIN)!.keys[0], P.buzzKey(p, "2"));
});
ok("the task's own interval wins", () => {
  const p = isl({ todo: { checkEvery: 15 } });
  assert.equal(P.buzzDue(p, T0 + 15 * MIN)?.kind, "check");
});
ok("missed by more than 5 minutes (asleep, a meeting): skipped, never caught up", () => {
  const p = isl();
  assert.ok(P.buzzDue(p, T0 + 34 * MIN), "4 minutes late: still");
  assert.equal(P.buzzDue(p, T0 + 36 * MIN), null, "6 minutes late: skipped");
  assert.equal(P.buzzDue(p, T0 + 61 * MIN)?.keys[0], P.buzzKey(p, "2"), "the next one comes as usual");
});
ok("the time up buzzes once, and a check-in at the same moment is the same buzz", () => {
  const p = isl({ todo: { est: 30 } });
  const b = P.buzzDue(p, T0 + 30 * MIN)!;
  assert.equal(b.kind, "up"); assert.equal(b.keys.length, 2);
  assert.equal(P.buzzDue(p, T0 + 31 * MIN, new Set(b.keys)), null);
  const q = isl({ todo: { est: 20 } });
  assert.equal(P.buzzDue(q, T0 + 20 * MIN)?.kind, "up");
  assert.equal(P.buzzDue(q, T0 + 30 * MIN, new Set([P.buzzKey(q, "up")]))?.kind, "check", "after the time up, the check-ins go on");
});
ok("a new round of the task (ticked and started again) starts from the first check-in again", () => {
  const a = isl({ round: T0 }), b = isl({ round: T0 + 3 * 3_600_000, now: T0 + 3 * 3_600_000 });
  assert.notEqual(P.buzzKey(a, "1"), P.buzzKey(b, "1"));
});
ok("the first card has the actual check-in or Time's up, with the choice", () => {
  const p = isl({ prefs: P.progressPrefs(undefined) });
  assert.equal(P.buzzDue(p, T0 + 30 * MIN)?.kind, "check");
  const q = isl({ prefs: P.progressPrefs(undefined), todo: { est: 10 } });
  const b = P.buzzDue(q, T0 + 10 * MIN)!;
  assert.equal(b.kind, "up");
  assert.deepEqual(P.buzzWords(q, b), { main: "You've been working on this for 10 minutes", sub: "Time's up", ask: "Progress check-ins are on." });
});
ok("off and not due (a copy that still had it): never buzzes", () => {
  assert.equal(P.buzzDue({ ...isl(), on: false, ask: false }, T0 + 30 * MIN), null);
});
ok("before it began, or a clock from the future: nothing", () => {
  assert.equal(P.buzzDue(isl(), T0 - MIN), null);
  assert.equal(P.buzzDue(isl(), T0), null);
});
ok("what keeps it from buzzing now: the island off or away, hidden, a meeting, Do Not Disturb, away from the Mac, a takeover, a card", () => {
  const free: P.BuzzBlock = { islandOff: false, away: false, meeting: false, hidden: false, takeover: false, busy: false, idle: false, quiet: false };
  assert.equal(P.buzzBlocked(free), null);
  for (const k of Object.keys(free) as (keyof P.BuzzBlock)[]) assert.equal(P.buzzBlocked({ ...free, [k]: true }), k);
  assert.equal(P.buzzBlocked({ ...free, meeting: true, busy: true }), "meeting", "the strongest reason first");
});
ok("an unanswered question asks again a day later at the soonest", () => {
  assert.equal(P.offerAgain(null, T0), true);
  assert.equal(P.offerAgain(T0, T0 + 19 * 3_600_000), false);
  assert.equal(P.offerAgain(T0, T0 + 20 * 3_600_000), true);
});

// ---------- the timer ----------
ok("time left counts down from the start and stops at 0; the ring, sand and line go from full to empty", () => {
  const p = isl({ todo: { est: 40 } });
  assert.equal(P.leftMs(p, T0), 40 * MIN);
  assert.equal(P.leftMs(p, T0 + 30 * MIN), 10 * MIN);
  assert.equal(P.leftMs(p, T0 + 50 * MIN), 0);
  assert.equal(P.leftFrac(p, T0), 1); assert.equal(P.leftFrac(p, T0 + 10 * MIN), 0.75); assert.equal(P.leftFrac(p, T0 + 60 * MIN), 0);
  assert.equal(P.leftMs(isl(), T0), null);
});
ok("the timer shows only while switched on with time left (gone when the time is up)", () => {
  const p = isl({ todo: { est: 20 } });
  assert.equal(P.timerShows(p, T0 + MIN), true);
  assert.equal(P.timerShows(p, T0 + 20 * MIN), false);
  assert.equal(P.timerShows(isl(), T0 + MIN), false, "no expected time: no timer");
  assert.equal(P.timerShows(null, T0), false);
});
ok("the Text look: minutes rounded up, like 16m", () => {
  assert.equal(P.leftShort(15.5 * MIN), "16m");
  assert.equal(P.leftShort(30_000), "1m");
  assert.equal(P.leftShort(60 * MIN), "1h");
  assert.equal(P.leftShort(65 * MIN), "1h 5m");
  assert.equal(P.leftShort(0), "0m");
});

// ---------- the clock it counts from (core/timeest.ts) ----------
ok("the time spent in ms is the same clock as the minutes, and the round starts at its first span", () => {
  let l = startClock(emptyLive(), "t1", "Write", T0)!;
  l = stopClock(l, "t1", T0 + 10 * MIN)!;
  l = startClock(l, "t1", "Write", T0 + 20 * MIN)!;
  const away = [[T0 + 22 * MIN, T0 + 25 * MIN]] as [number, number][];
  assert.equal(spentMs(l, "t1", T0 + 30 * MIN, away), 17 * MIN);
  assert.equal(spentMin(l, "t1", T0 + 30 * MIN, away), 17);
  assert.equal(roundStart(l, "t1"), T0);
  const done = finishClock(l, "t1", T0 + 40 * MIN, []).live;
  assert.equal(roundStart(done, "t1"), null, "finished: no round");
  assert.equal(roundStart(startClock(done, "t1", "Write", T0 + 50 * MIN)!, "t1"), T0 + 50 * MIN, "started again: a new round");
});

// ---------- the words ----------
ok("lengths of time in plain words", () => {
  assert.equal(P.durWords(1), "1 minute"); assert.equal(P.durWords(30), "30 minutes");
  assert.equal(P.durWords(60), "1 hour"); assert.equal(P.durWords(65), "1 hour 5 minutes"); assert.equal(P.durWords(120), "2 hours");
  assert.equal(P.durWords(61), "1 hour 1 minute");
});
ok("the card: the task as the headline, then how long, then the time left or Time's up", () => {
  const p = isl({ todo: { est: 45 } });
  assert.deepEqual(P.buzzWords(p, P.buzzDue(p, T0 + 30 * MIN)!), { main: "You've been working on this for 30 minutes", sub: "15 minutes left", ask: null });
  assert.deepEqual(P.buzzWords(p, P.buzzDue(p, T0 + 45 * MIN)!), { main: "You've been working on this for 45 minutes", sub: "Time's up", ask: null });
  const q = isl({ todo: { est: 20 } });
  assert.equal(P.buzzWords(q, P.buzzDue(q, T0 + 30 * MIN, new Set([P.buzzKey(q, "up")]))!).sub, "10 minutes over");
  assert.deepEqual(P.buzzWords(isl(), P.buzzDue(isl(), T0 + 60 * MIN)!), { main: "You've been working on this for 1 hour", sub: null, ask: null });
});
ok("the question's words", () => {
  const p = isl({ prefs: P.progressPrefs(undefined) });
  const w = P.buzzWords(p, P.buzzDue(p, T0 + 30 * MIN)!);
  assert.equal(w.ask, "Progress check-ins are on.");
  assert.equal(P.PROGRESS_WORDS.turnOn, "Keep on"); assert.equal(P.PROGRESS_WORDS.notNow, "Turn off");
});
ok("no em or en dashes in any of its words", () => {
  assert.ok(!/[–—]/.test(JSON.stringify([P.PROGRESS_WORDS, P.LOOKS])));
});

// ---------- the answer ----------
ok("the first card is shown once and Turn off still works after it is marked shown", () => {
  assert.deepEqual(P.progressAskPatch("on", {}), { progress: { on: true, every: 30, look: "ring" } });
  assert.deepEqual(P.progressAskPatch("off", { progress: { every: 45 } }), { progress: { on: false, every: 45, look: "ring" } });
  assert.equal(P.progressAskPatch("on", { progress: { on: false } }), null, "already answered (Settings): left alone");
  const shown = P.progressAskPatch("on", {})!;
  const next = isl({ prefs: P.progressPrefs(shown.progress) });
  assert.equal(P.buzzWords(next, P.buzzDue(next, T0 + 60 * MIN)!).ask, null);
  const off = P.progressAskPatch("disable", shown);
  assert.deepEqual(off, { progress: { on: false, every: 30, look: "ring" } });
  assert.equal(P.progressAskPatch("disable", off), null);
  assert.equal(P.progressAskPatch("on", off), null);
  assert.equal(P.progressAskPatch("maybe", {}), null);
});

// ---------- where it is wired in ----------
ok("the page sends it with the island state, and saves the answer", () => {
  const s = read("../src/island.ts");
  assert.match(s, /progress: progressPart\(s, st, shown, now\)/);
  assert.match(s, /m\.action === "progressAsk"/);
  assert.match(s, /progressAskPatch\(m\.id, st\?\.island\)/);
  assert.match(s, /feature\("island-progress"\)/);
});
ok("features.json: in core (the public build has it), on by default, web and Mac", () => {
  const f = JSON.parse(read("../core-root/features.json")).features.find((x: { id: string }) => x.id === P.PROGRESS_FEATURE);
  assert.ok(f);
  assert.equal(f.scope, "shared"); assert.equal(f.since, "1.77"); assert.equal(f.default, "on"); assert.deepEqual(f.parts, ["web", "mac"]);
});
const X = await import("../src/core/settingsindex.ts");
ok("its switch, interval and look in Settings, Dynamic Island (Mac), also in the public build", () => {
  const e = X.SETTINGS.find((x: { id: string }) => x.id === "island-progress");
  assert.ok(e); assert.equal(e!.group, "island"); assert.deepEqual(e!.on, ["mac"]);
  assert.ok(!("red" in e!) || !(e as { red?: boolean }).red, "not the developer only");
  assert.match(read("../src/views/SettingsGroups.tsx"), /"island-progress": function IslandProgressRow/);
});
ok("the expected time and the per task interval in Add task's Advanced and in Edit", () => {
  const tm = read("../src/views/TaskMap.tsx"), te = read("../src/views/TimeEstimate.tsx");
  assert.match(tm, /<AddTime [^>]*every=\{every\} setEvery=\{setEvery\}/);
  assert.match(tm, /<EditTime [^>]*every=\{every\} setEvery=\{setEvery\}/);
  assert.match(tm, /patch\.checkEvery = every/);
  assert.match(te, /<CheckEveryPicker/);
});
const F = await import("../src/core/featureintro.ts");
ok("the first real check-in carries the choice without a separate intro", () => {
  assert.ok(!F.INTROS.some((x: { id: string }) => x.id === "island-progress-177"));
});
console.log(`\n${n} passed`);
