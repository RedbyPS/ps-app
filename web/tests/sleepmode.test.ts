// Run: node --experimental-strip-types tests/sleepmode.test.ts
// Sleep mode (V1.40, src/core/sleepmode.ts): settings cleaning, alarm times across midnight and day sleep, the
// panel time, the ring window, the drift, the words, counts only by default, and the sleep proposed after Wake up.
// Plus source checks that every device's path exists and no dashes slipped into the words. FICTIONAL data.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
const M = await import("../src/core/sleepmode.ts");
const S = await import("../src/core/sleep.ts");
const W = await import("../src/core/sleepwake.ts");
const SS = await import("../src/core/sleepsettings.ts");
const SI = await import("../src/core/settingsindex.ts");

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const TB = "Asia/Dubai";
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const at = (iso: string) => Date.parse(iso);

ok("cleanSleepMode drops junk, keeps 5 alarms sorted, clamps the panel", () => {
  const c = M.cleanSleepMode({ show: false, details: "yes", panel: 9999, evil: 1,
    alarms: [{ id: "b", at: "08:00" }, { id: "a", at: "07:30", on: false }, { id: "x", at: "25:00" }, { id: "b", at: "09:00" },
      { id: "c", at: "06:00" }, { id: "d", at: "05:00" }, { id: "e", at: "04:00" }, { id: "f", at: "03:00" }, null, { id: "bad id!", at: "07:00" }] });
  assert.equal(c.show, false);
  assert.equal(c.details, undefined);
  assert.equal(c.panel, M.PANEL_MAX);
  assert.equal((c as Record<string, unknown>).evil, undefined);
  assert.equal(c.alarms!.length, 5);
  assert.deepEqual(c.alarms!.map((a) => a.at), ["04:00", "05:00", "06:00", "07:30", "08:00"]);
  assert.equal(c.alarms!.find((a) => a.id === "a")!.on, false);
});
ok("defaults: shown, no alarms, counts only, panel 30 min, asks to log", () => {
  assert.deepEqual(M.sleepModeOf(undefined), { show: true, alarms: [], details: false, panel: 30, ask: true, look: M.LOOK_DEF, lock: true, wake: W.WAKE_DEF, ringAlways: true, once: null });
});

ok("a night sleeper: 23:40 bedtime, 07:30 alarm rings the next morning", () => {
  const since = at("2026-11-07T19:40:00Z");   // 23:40 Dubai
  const r = M.ringsFor([{ id: "a", at: "07:30", on: true }], since, TB);
  assert.equal(new Date(r[0].at).toISOString(), "2026-11-08T03:30:00.000Z");
});
ok("The developer's day sleep: 07:10 bedtime, a 14:30 alarm rings the same day", () => {
  const since = at("2026-11-08T03:10:00Z");   // 07:10 Dubai
  const r = M.ringsFor([{ id: "a", at: "14:30", on: true }, { id: "b", at: "07:00", on: true }, { id: "c", at: "15:00", on: false }], since, TB);
  assert.deepEqual(r.map((x) => x.label), ["14:30", "07:00"]);
  assert.equal(new Date(r[0].at).toISOString(), "2026-11-08T10:30:00.000Z");
  assert.equal(new Date(r[1].at).toISOString(), "2026-11-09T03:00:00.000Z");   // 07:00 has passed: tomorrow
});
ok("an alarm across a clock change lands on the wall time", () => {
  const since = at("2026-10-24T22:00:00Z");   // London, the night the clocks go back
  const r = M.ringsFor([{ id: "a", at: "08:00", on: true }], since, "Europe/London");
  assert.equal(new Date(r[0].at).toISOString(), "2026-10-25T08:00:00.000Z");   // 08:00 GMT
});
ok("wake time: first alarm, else the usual wake (at least an hour on), else none", () => {
  const since = at("2026-11-08T03:10:00Z");
  const rings = M.ringsFor([{ id: "a", at: "14:30", on: true }], since, TB);
  assert.equal(M.wakeAt(rings, since, TB, "15:00"), rings[0].at);
  assert.equal(new Date(M.wakeAt([], since, TB, "15:00")!).toISOString(), "2026-11-08T11:00:00.000Z");
  assert.equal(new Date(M.wakeAt([], since, TB, "07:30")!).toISOString(), "2026-11-09T03:30:00.000Z");   // 07:30 is 20 min away: tomorrow
  assert.equal(M.wakeAt([], since, TB, null), null);
});
ok("the panel rises 30 min before the wake time, never before bedtime", () => {
  const since = 1_000_000_000_000, wake = since + 8 * 3600_000;
  assert.equal(M.panelAt(wake, since, 30), wake - 30 * 60_000);
  assert.equal(M.panelAt(since + 10 * 60_000, since, 30), since);
  assert.equal(M.panelAt(null, since, 30), null);
});
ok("a ring is due from its time for 5 minutes, once, and stops itself after 10", () => {
  const r = [{ id: "a", at: 1000_000, label: "07:30" }];
  assert.equal(M.ringDue(r, 999_999, new Set()), null);
  assert.equal(M.ringDue(r, 1000_000, new Set())?.id, "a");
  assert.equal(M.ringDue(r, 1000_000 + 4 * 60_000, new Set())?.id, "a");
  assert.equal(M.ringDue(r, 1000_000 + 6 * 60_000, new Set()), null);
  assert.equal(M.ringDue(r, 1000_000, new Set([M.ringKey(r[0])])), null);
  assert.equal(M.stillRinging(0, M.RING_FOR - 1), true);
  assert.equal(M.stillRinging(0, M.RING_FOR), false);
});
ok("the drift stays inside 6 px and moves every 90 s", () => {
  const seen = new Set<string>();
  for (let t = 0; t < 400 * M.DRIFT_EVERY; t += M.DRIFT_EVERY) {
    const d = M.drift(t);
    assert.ok(Math.abs(d.x) <= M.DRIFT && Math.abs(d.y) <= M.DRIFT);
    seen.add(`${d.x},${d.y}`);
    assert.deepEqual(M.drift(t + M.DRIFT_EVERY - 1), d);
  }
  assert.ok(seen.size > 20);
});
ok("words: asleep for, tasks, squad hidden without a squad, alarms", () => {
  assert.equal(M.asleepFor(0, 30_000), "Asleep for a moment");
  assert.equal(M.asleepFor(0, 12 * 60_000), "Asleep for 12 min");
  assert.equal(M.asleepFor(0, (7 * 60 + 5) * 60_000), "Asleep for 7 h 05");
  assert.equal(M.taskLine(0), "Nothing on your list for today");
  assert.equal(M.taskLine(1), "1 task for today");
  assert.equal(M.taskLine(5), "5 tasks for today");
  assert.equal(M.squadLine(null), null);
  assert.equal(M.squadLine(undefined), null);
  assert.equal(M.squadLine(0), "Nobody in your G Squad is working yet");
  assert.equal(M.squadLine(1), "1 person is working");
  assert.equal(M.squadLine(4), "4 people are working");
  assert.equal(M.alarmLine([]), "No alarm, silent all night");
  assert.equal(M.alarmLine([{ id: "a", at: 1, label: "07:30" }, { id: "b", at: 2, label: "08:00" }, { id: "c", at: 3, label: "08:15" }]), "Alarms 07:30, 08:00 and 08:15");
});
ok("today's tasks: open, due today or earlier or no date, repeating not done; Priority 1 first", () => {
  const list = [
    { title: "later", type: "once" as const, done: false, due: "2026-11-09", order: 1 },
    { title: "today", type: "once" as const, done: false, due: "2026-11-08", order: 2 },
    { title: "nodate", type: "once" as const, done: false, order: 3 },
    { title: "done", type: "once" as const, done: true, order: 0 },
    { title: "cleared", type: "once" as const, done: false, clearedAt: "x", order: 0 },
    { title: "daily", type: "daily" as const, done: false, order: 0 },
    { title: "p1", type: "once" as const, done: false, order: 9, p1: true },
  ];
  assert.deepEqual(M.todayTasks(list, "2026-11-08").map((t) => t.title), ["p1", "today", "nodate", "daily"]);
});
ok("the plan: counts only unless details is on; the squad line hides with no squad", () => {
  const prefs = M.sleepModeOf({ sleepMode: { alarms: [{ id: "a", at: "14:30", on: true }] } });
  const tasks = [{ title: "Call Fictional Client about the   invoice", type: "once" as const, done: false }];
  const p = M.buildPlan({ since: at("2026-11-08T03:10:00Z"), tz: TB, prefs, tasks, squad: null });
  assert.equal(p.tasks.count, 1);
  assert.deepEqual(p.tasks.titles, []);
  assert.equal(JSON.stringify(p).includes("Fictional"), false);
  assert.equal(p.words.squad, null);
  assert.equal(p.panel, p.wake! - 30 * 60_000);
  const full = M.buildPlan({ since: at("2026-11-08T03:10:00Z"), tz: TB, prefs: { ...prefs, details: true }, tasks, squad: 3 });
  assert.deepEqual(full.tasks.titles, ["Call Fictional Client about the invoice"]);
  assert.equal(full.words.squad, "3 people are working");
});
ok("Wake up proposes the sleep: 07:10 to 14:40 is 7 h 30 on that date", () => {
  const p = M.propose({ at: "2026-11-08T03:10:00.000Z", tz: TB }, at("2026-11-08T10:40:00Z"), new Date("2026-11-08T10:41:00Z"))!;
  assert.equal(p.why, "ok");
  assert.equal(p.day, "2026-11-08");
  assert.equal(p.asleep, "07:10");
  assert.equal(p.wake, "14:40");
  assert.equal(p.mins, 450);
  assert.equal(p.log!.src, "sleepmode");
  assert.equal(p.log!.day, "2026-11-08");
});
ok("a doze under 30 min or a forgotten button over 20 h is not logged", () => {
  assert.equal(M.propose({ at: "2026-11-08T03:10:00.000Z", tz: TB }, at("2026-11-08T03:30:00Z"))!.why, "short");
  assert.equal(M.propose({ at: "2026-11-06T03:10:00.000Z", tz: TB }, at("2026-11-08T03:30:00Z"))!.why, "long");
  assert.equal(M.propose({ at: "junk", tz: TB }, 1), null);
});
ok("times changed on the card: a night across midnight", () => {
  const l = M.editedLog("2026-11-08", "23:30", "07:00", TB)!;
  assert.equal(l.start, "2026-11-07T19:30:00.000Z");
  assert.equal(l.src, "sleepmode");
  assert.equal(M.editedLog("2026-11-08", "07:00", "07:00", TB), null);
});

// ---------- Wake up (V1.41, the developer 7 Nov 2026: "The wake up button doesn't work") ----------
ok("Wake up shows the card at once from the open sleep, even before the vault write lands", () => {
  const w = at("2026-11-08T03:00:00Z");
  assert.deepEqual(M.wakeCard({ at: "2026-11-07T19:40:00.000Z", tz: TB }, w, null, TB),
    { at: "2026-11-07T19:40:00.000Z", tz: TB, woke: "2026-11-08T03:00:00.000Z" });
});
ok("Wake up on the screen before the open sleep was saved still has a card (from when the screen went up)", () => {
  const since = at("2026-11-07T19:40:00Z"), w = at("2026-11-08T03:00:00Z");
  assert.deepEqual(M.wakeCard(null, w, since, TB), { at: "2026-11-07T19:40:00.000Z", tz: TB, woke: "2026-11-08T03:00:00.000Z" });
  assert.equal(M.wakeCard(null, w, null, TB), null);
  assert.equal(M.wakeCard({ at: "2026-11-07T19:40:00.000Z", tz: TB, woke: "2026-11-08T02:00:00.000Z" }, w, null, TB), null);
  assert.equal(M.wakeCard({ at: "junk", tz: TB }, w, null, TB), null);
});
ok("Wake up on one device ends the clock on the others, never a new sleep after an old wake", () => {
  const since = at("2026-11-07T19:40:00Z");
  assert.equal(M.wokeElsewhere({ at: "2026-11-07T19:40:00.000Z", woke: "2026-11-08T03:00:00.000Z" }, true, since), true);
  assert.equal(M.wokeElsewhere({ at: "2026-11-07T19:40:00.000Z", woke: "2026-11-08T03:00:00.000Z" }, false, since), false);
  assert.equal(M.wokeElsewhere({ at: "2026-11-07T19:40:00.000Z" }, true, since), false);
  assert.equal(M.wokeElsewhere({ at: "2026-11-06T19:40:00.000Z", woke: "2026-11-07T03:00:00.000Z" }, true, since), false);
});
ok("the engine wires it: the row hides and the card shows from this device's copy, every step is logged", () => {
  const e = src("src/sleepmode/engine.ts"), v = src("src/views/SleepMode.tsx");
  assert.match(e, /set\(\{ here: false, asking: false, since: null, choose:/);   // V1.43: the chooser shows at once
  assert.match(e, /sleepLog\(`Wake up/);
  assert.match(e, /type: "log", text: t/);
  assert.match(e, /endIfWokeElsewhere\(\)/);
  assert.doesNotMatch(e, /savePrefs\(\{ sleepOpen: \{ \.\.\.o, woke[^\n]*\.catch\(\(\) => \{\}\)/);
  assert.match(v, /!s\.here && !s\.woke && !s\.choose/);   // the row hides at once on Wake up (V1.41, V1.43 the chooser)
  assert.match(v, /s\.woke \?\? \(o\?\.woke/);
});
ok("a kept Tab list on a Mac takes clicks on the card, its note and the settings sheet", () => {
  const tm = src("src/views/TaskMap.tsx");
  assert.match(tm, /SLEEP_LAYERS = "\.slp-card, \.slp-note, \.slp-layer, \.slp-screen/);
  assert.match(tm, /\.tm-ctx-ed, " \+ SLEEP_LAYERS/);
});

// ---------- V1.42 Customise, the stopwatch, the pointer ----------
ok("the look: defaults, junk dropped, every number kept in range", () => {
  assert.deepEqual(M.cleanLook(null), M.LOOK_DEF);
  const l = M.cleanLook({ size: 9999, font: "comic", h12: "yes", secs: true, color: "chartreuse", bright: 1, bg: "ps", pos: "top",
    show: { date: true, squad: false, evil: true }, watch: "big", pointer: -4, extra: 1 });
  assert.equal(l.size, M.SIZE_MAX); assert.equal(l.font, "thin"); assert.equal(l.h12, false); assert.equal(l.secs, true);
  assert.equal(l.color, "amber"); assert.equal(l.bright, M.BRIGHT_MIN); assert.equal(l.bg, "ps"); assert.equal(l.pos, "top");
  assert.equal(l.show.date, true); assert.equal(l.show.squad, false); assert.equal(l.show.asleep, true);
  assert.equal((l.show as Record<string, unknown>).evil, undefined); assert.equal((l as Record<string, unknown>).extra, undefined);
  assert.equal(l.watch, "big"); assert.equal(l.pointer, 0);
  assert.equal(M.cleanLook({ size: 1 }).size, M.SIZE_MIN);
  assert.equal(M.cleanLook({ pointer: 999 }).pointer, M.POINTER_MAX);
});
ok("the look is saved with the other Sleep mode settings and filled in by sleepModeOf", () => {
  assert.deepEqual(M.sleepModeOf(undefined).look, M.LOOK_DEF);
  const c = M.cleanSleepMode({ show: true, look: { size: 180, color: "red" } });
  assert.equal(c.look!.size, 180); assert.equal(c.look!.color, "red");
  assert.equal(M.sleepModeOf({ sleepMode: c }).look.font, "thin");
  assert.equal(M.cleanSleepMode({ show: true }).look, undefined);
});
ok("colours: the clock colour, a dim shade of it, near black, the PS background", () => {
  assert.equal(M.inkHex("amber"), "#e7a35e");
  assert.equal(M.bgHex({ bg: "black", color: "red" }), M.NIGHT);
  assert.match(M.bgHex({ bg: "dim", color: "red" }), /^#[0-9a-f]{6}$/);
  assert.notEqual(M.bgHex({ bg: "dim", color: "red" }), M.NIGHT);
  assert.equal(M.bgHex({ bg: "ps", color: "amber" }, "#1A2B3C"), "#1a2b3c");
  assert.equal(M.bgHex({ bg: "ps", color: "amber" }, "url(x)"), M.NIGHT);
  assert.equal(M.bgHex({ bg: "ps", color: "amber" }, null), M.NIGHT);
});
ok("the clock: 24 hour, 12 hour with AM and PM, seconds", () => {
  const t = new Date(2026, 10, 8, 19, 5, 9).getTime(), m = new Date(2026, 10, 8, 0, 30, 0).getTime();
  assert.deepEqual(M.clockText(t, { h12: false, secs: false }), { time: "19:05", ampm: null });
  assert.deepEqual(M.clockText(t, { h12: true, secs: false }), { time: "7:05", ampm: "PM" });
  assert.deepEqual(M.clockText(t, { h12: false, secs: true }), { time: "19:05:09", ampm: null });
  assert.deepEqual(M.clockText(m, { h12: true, secs: false }), { time: "12:30", ampm: "AM" });
  assert.deepEqual(M.clockText(m, { h12: false, secs: false }), { time: "00:30", ampm: null });
});
ok("the stopwatch keeps time from timestamps: pause, start again, reset, and while the screen is dim", () => {
  let w = M.watchStart(M.WATCH_ZERO, 1000);
  assert.equal(M.watchMs(w, 61_000), 60_000);            // a minute later, however few ticks the dim screen drew
  w = M.watchPause(w, 61_000);
  assert.equal(M.watchMs(w, 999_000), 60_000);           // paused: frozen
  w = M.watchStart(w, 100_000);
  assert.equal(M.watchMs(w, 105_500), 65_500);
  assert.equal(M.watchStart(w, 200_000), w);             // Start while running changes nothing
  assert.deepEqual(M.watchReset(), M.WATCH_ZERO);
  assert.equal(M.watchText(7_000), "0:07");
  assert.equal(M.watchText(754_000), "12:34");
  assert.equal(M.watchText(3_723_000), "1:02:03");
});
ok("the plan carries the look to the Mac and the phone, colours resolved, and the new words", () => {
  const p = M.buildPlan({ since: at("2026-11-07T19:40:00Z"), tz: TB, prefs: { ...M.sleepModeOf(undefined), look: M.cleanLook({ color: "blue", bright: 50, bg: "dim", watch: "big" }) },
    tasks: [], squad: null, psBase: "#101010" });
  assert.equal(p.look.ink, "#7aaaee"); assert.equal(p.look.bright, 0.5); assert.equal(p.look.watch, "big");
  assert.match(p.look.bg, /^#[0-9a-f]{6}$/);
  assert.equal(p.words.start, "Start"); assert.equal(p.words.pause, "Pause"); assert.equal(p.words.reset, "Reset"); assert.equal(p.words.customise, "Customise");
});
ok("wiring: Customise on the web screen, the look in Sleep settings (V1.47), Esc closes it, the pointer hides on the screen only", () => {
  const v = src("src/views/SleepMode.tsx"), c = src("src/views/SleepCustomise.tsx"), f = src("src/views/SleepFace.tsx"), css = src("src/views/sleepmode.css");
  assert.match(c, /Customise the sleep screen/);
  assert.match(v, /openCustomise\(\)/);
  assert.match(src("src/views/SleepSettings.tsx"), /<LookPiece k=\{lb\} look=\{look\} change=\{change\} \/>/);
  assert.match(v, /sleepMode: prefsOf\(\{ \.\.\.p, \.\.\.patch \}\)/);   // other settings never drop the look (V1.43: prefsOf sends every field)
  assert.match(v, /leaveScreen\(\)/);                  // Esc still leaves the web screen
  assert.match(c, /e\.key === "Escape"/);
  assert.match(c, /Back to sleep/);
  assert.match(f, /useHiddenPointer/);
  assert.match(css, /\.slp-screen\.nocursor, \.slp-screen\.nocursor \* \{ cursor: none !important; \}/);
  assert.match(src("src/views/TaskMap.tsx"), /SLEEP_LAYERS = "[^"]*\.slp-cust"/);
  for (const x of ["src/views/SleepCustomise.tsx", "src/views/SleepFace.tsx"]) assert.equal(/[–—]/.test(src(x)), false, x);
});

// ---------- V1.43: Touch ID on Wake up is a setting (on), and short breaks ----------
ok("Touch ID to leave: on unless switched off, and the plan tells the shells", () => {
  assert.equal(M.sleepModeOf(undefined).lock, true);
  assert.equal(M.sleepModeOf({ sleepMode: { lock: false } }).lock, false);
  assert.equal(M.cleanSleepMode({ lock: "no" }).lock, undefined);
  const p = M.buildPlan({ since: at("2026-11-07T19:40:00Z"), tz: TB, prefs: { ...M.sleepModeOf(undefined), lock: false }, tasks: [], squad: null });
  assert.equal(p.lock, false);
  assert.match(p.words.locked, /^Wake up leaves at once/);
  assert.equal(p.words.breakAsk, "Go back to sleep?");
});
const T0 = at("2026-11-07T20:00:00Z"), MIN = 60_000;
const open0 = { at: new Date(T0).toISOString(), tz: TB };
ok("Wake up pauses the sleep; I'm up ends it at the press", () => {
  const p = M.pauseOpen(open0, T0 + 180 * MIN);
  assert.equal(p.paused, new Date(T0 + 180 * MIN).toISOString());
  const u = M.upOpen(p, T0 + 200 * MIN);
  assert.equal(u.woke, p.paused); assert.equal(u.paused, null);
});
ok("Back to sleep in N: a break from the press, until N minutes from now; 5 to 120 in fives", () => {
  assert.deepEqual(M.BREAK_STEPS.slice(0, 3), [5, 10, 15]); assert.equal(M.BREAK_STEPS.at(-1), 120); assert.equal(M.BREAK_DEF, 5);
  const p = M.pauseOpen(open0, T0 + 180 * MIN);
  const b = M.breakOpen(p, 30, T0 + 181 * MIN, "mac");
  assert.equal(b.brk!.from, p.paused); assert.equal(b.brk!.until, new Date(T0 + 211 * MIN).toISOString()); assert.equal(b.brk!.dev, "mac");
  assert.equal(M.breakOpen(p, 7, T0, "web").brk!.until, new Date(T0 + 5 * MIN).toISOString());   // an odd number: the default
});
ok("the break's stages: running, asked 3 times 5 minutes apart, then it ends", () => {
  const brk = { until: new Date(T0).toISOString() };
  assert.deepEqual(M.breakStage(brk, T0 - 1), { stage: "running", ask: 0 });
  assert.deepEqual(M.breakStage(brk, T0), { stage: "ask", ask: 1 });
  assert.deepEqual(M.breakStage(brk, T0 + 5 * MIN), { stage: "ask", ask: 2 });
  assert.deepEqual(M.breakStage(brk, T0 + 14 * MIN), { stage: "ask", ask: 3 });
  assert.deepEqual(M.breakStage(brk, T0 + 15 * MIN), { stage: "end", ask: 3 });
  assert.deepEqual(M.breakStage(null, T0), { stage: "none", ask: 0 });
});
ok("Back to sleep keeps the break; 5 more minutes; I'm up now ends at the break's start", () => {
  const b = M.breakOpen(M.pauseOpen(open0, T0 + 180 * MIN), 30, T0 + 180 * MIN, "phone");
  const r = M.resumeOpen(b, T0 + 210 * MIN);
  assert.equal(r.brk, null); assert.deepEqual(r.breaks, [{ start: new Date(T0 + 180 * MIN).toISOString(), end: new Date(T0 + 210 * MIN).toISOString() }]);
  assert.equal(M.moreOpen(b, T0 + 212 * MIN).brk!.until, new Date(T0 + 217 * MIN).toISOString());
  assert.equal(M.upOpen(b, T0 + 230 * MIN).woke, new Date(T0 + 180 * MIN).toISOString());
  // Sleep pressed again while a Wake up waited for its answer: that time is a break too.
  const p2 = M.resumeOpen(M.pauseOpen(open0, T0 + 60 * MIN), T0 + 70 * MIN);
  assert.equal(p2.breaks!.length, 1); assert.equal(p2.paused, null);
});
ok("no answer: the sleep ends at the last moment of activity, never before the break began, and that time is a break", () => {
  const b = M.breakOpen(M.pauseOpen(open0, T0 + 180 * MIN), 10, T0 + 180 * MIN, "web");
  const t = M.timeoutOpen(b, T0 + 186 * MIN, T0 + 205 * MIN);
  assert.equal(t.woke, new Date(T0 + 186 * MIN).toISOString());
  assert.deepEqual(t.breaks, [{ start: new Date(T0 + 180 * MIN).toISOString(), end: new Date(T0 + 186 * MIN).toISOString() }]);
  assert.equal(M.timeoutOpen(b, T0, T0 + 205 * MIN).woke, new Date(T0 + 180 * MIN).toISOString());   // activity before the break: the break's start
});
ok("the Sleep log keeps the breaks: time asleep leaves them out, the line says when and how long", () => {
  const log = S.makeLog({ start: T0, end: T0 + 450 * MIN, tz: TB, src: "sleepmode",
    breaks: [{ start: new Date(T0 + 180 * MIN).toISOString(), end: new Date(T0 + 210 * MIN).toISOString() }] })!;
  assert.equal(S.sleepMins(log), 420);
  assert.equal(S.breakLine(log), "1 break: 30 min, 3 h in");
  assert.equal(S.cleanLog(JSON.parse(JSON.stringify(log)))!.breaks!.length, 1);
  const two = S.makeLog({ start: T0, end: T0 + 450 * MIN, tz: TB, breaks: [
    { start: new Date(T0 + 60 * MIN).toISOString(), end: new Date(T0 + 70 * MIN).toISOString() },
    { start: new Date(T0 + 65 * MIN).toISOString(), end: new Date(T0 + 80 * MIN).toISOString() },     // overlaps: merged
    { start: new Date(T0 + 300 * MIN).toISOString(), end: new Date(T0 + 335 * MIN).toISOString() },
    { start: new Date(T0 - 60 * MIN).toISOString(), end: new Date(T0 - 30 * MIN).toISOString() },     // outside: dropped
    { start: "junk", end: "junk" }] })!;
  assert.equal(two.breaks!.length, 2); assert.equal(S.sleepMins(two), 450 - 20 - 35);
  assert.equal(S.breakLine(two), "2 breaks: 55 min");
  assert.equal(S.breakLine(S.makeLog({ start: T0, end: T0 + 450 * MIN, tz: TB })!), null);
  assert.equal(S.makeLog({ start: T0, end: T0 + 450 * MIN, tz: TB })!.breaks, undefined);
});
ok("streaks and the card use time asleep, not time in bed", () => {
  const log = S.makeLog({ start: T0, end: T0 + 440 * MIN, tz: TB, src: "sleepmode",
    breaks: [{ start: new Date(T0 + 180 * MIN).toISOString(), end: new Date(T0 + 230 * MIN).toISOString() }] })!;
  assert.equal(S.onTarget(log, 7 * 60), false);    // 7 h 20 in bed, 6 h 30 asleep: not on a 7 h target
  const p = M.propose({ ...open0, breaks: log.breaks }, T0 + 440 * MIN)!;
  assert.equal(p.mins, 390); assert.equal(p.log!.breaks!.length, 1);
  assert.equal(M.editedLog(p.day, p.asleep, p.wake, TB, new Date(), log.breaks)!.breaks!.length, 1);
});
ok("wiring: the chooser, the pop-up, the break row, the Touch ID switch, Esc never traps", () => {
  const v = src("src/views/SleepMode.tsx"), e = src("src/sleepmode/engine.ts");
  assert.match(v, /Up for the day, or just checking something\?/);
  assert.match(v, /Back to sleep in \{mins\} min/);
  assert.match(v, /Go back to sleep\?/);
  assert.match(v, /5 more minutes/); assert.match(v, /I'm up now/);
  assert.match(v, /On a break, back to sleep at/);
  assert.match(src("src/views/SleepSettings.tsx"), /seg\("Ask for Touch ID to leave Sleep mode", p\.lock/);   // V1.47: in Sleep settings, Security and leaving
  assert.match(v, /sleepMode: prefsOf\(/);
  assert.match(v, /void chooseUp\(\); \} \};/);          // Esc on the chooser: I'm up
  assert.match(v, /hideBreakAsk\(\); \} \};/);           // Esc on the pop-up: away until the next ask
  assert.match(e, /psPost\(\{ type: "sleep:show" \}\)/);  // the Mac raises the Tab list for the ask
  assert.match(e, /type: "sleep:break", until/);              // the phone gets the break's end
  assert.match(src("src/fitness/Sleep.tsx"), /breakLine\(l\)/);
});

// ---------- the parts on every device ----------
ok("every new sentence has no em or en dash", () => {
  for (const f of ["src/core/sleepmode.ts", "src/sleepmode/engine.ts", "src/sleepmode/squad.ts", "src/views/SleepMode.tsx", "src/views/sleepmode.css"]) {
    assert.equal(/[–—]/.test(src(f)), false, f);
  }
});
ok("the settings are checked on the way in (ps.ts cleanLooks) and saved in the vault settings", () => {
  assert.match(src("src/ps.ts"), /o\.sleepMode = cleanSleepMode\(p\.sleepMode\)/);
  assert.match(src("src/core/model.ts"), /sleepMode\?: SleepModePrefs/);
});
ok("the button sits at the end of the list, next to Resurrect, and its settings show for everyone", () => {
  const tm = src("src/views/TaskMap.tsx");
  assert.match(tm, /<SleepRow/);
  assert.match(src("src/views/Completed.tsx"), /\{extra\}/);
  assert.doesNotMatch(tm, /red && <SleepRow/);
  // V1.47: Settings, Sleep mode is one row with a button that opens Sleep mode's own settings, for every account.
  const groups = src("src/views/SettingsGroups.tsx");
  assert.match(groups, /"sleep-settings": function SleepEntryRow/);
  assert.match(groups, /go === "sleepSettings"\) later\(\(\) => openSleepSettings/);
  assert.doesNotMatch(groups, /red && <SleepEntryRow/);
});
ok("routing: the Mac and the phone get the plan, any other page shows its own screen with a wake lock", () => {
  const e = src("src/sleepmode/engine.ts");
  assert.match(e, /type: "sleep:start"/);
  assert.match(e, /navigator as Navigator & \{ wakeLock/);
  assert.match(src("src/views/SleepMode.tsx"), /only ring while this page stays open/);
});

ok("the analogue face (V1.43): the choices, its own colours, the hands' angles, the marks", () => {
  assert.equal(M.LOOK_DEF.face, "digital");
  const l = M.cleanLook({ face: "analogue", dial: "roman", hand: "none", faceInk: "#112233", handInk: "gold", tickInk: "javascript:", digi: false });
  assert.equal(l.face, "analogue"); assert.equal(l.dial, "roman"); assert.equal(l.hand, "none"); assert.equal(l.digi, false);
  assert.equal(l.faceInk, "#112233"); assert.equal(l.handInk, "gold"); assert.equal(l.tickInk, "same");
  const bad = M.cleanLook({ face: "sundial", dial: "hex", hand: "fast" });
  assert.equal(bad.face, "digital"); assert.equal(bad.dial, "ticks"); assert.equal(bad.hand, "sweep"); assert.equal(bad.digi, true);
  const pl = M.planLook(M.cleanLook({ color: "teal", face: "analogue", handInk: "#ff0000" }));
  assert.equal(pl.faceInk, M.inkHex("teal")); assert.equal(pl.tickInk, M.inkHex("teal")); assert.equal(pl.handInk, "#ff0000");
  const d = new Date(2026, 10, 8, 15, 30, 15, 500);
  const sw = M.handAngles(d, "sweep"), tk = M.handAngles(d, "tick");
  assert.equal(sw.minute, 30.25 * 6); assert.equal(sw.hour, (3 + 30.25 / 60) * 30); assert.equal(sw.second, 15.5 * 6); assert.equal(tk.second, 90);
  assert.equal(M.handAngles(new Date(2026, 10, 8, 0, 0, 0)).hour, 0);
  const marks = M.dialMarks("numbers");
  assert.equal(marks.length, 60); assert.equal(marks.filter((x) => x.major).length, 12);
  assert.deepEqual(marks.filter((x) => x.label).map((x) => x.label), ["12", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
  assert.equal(M.dialMarks("roman")[45].label, "IX");
  assert.equal(M.dialMarks("ticks").some((x) => x.label), false);
});
// ---------- V1.43: more looks, "Wake me up in", wake styles ----------
ok("look (V1.43): 12 fonts, weight, letter spacing, wheel colours for the clock, the words and the background", () => {
  assert.equal(M.FONTS.length, 12);
  for (const f of M.FONTS) assert.ok(M.FONT_NAMES[f]);
  const l = M.cleanLook({ font: "hand", weight: 650, spacing: 99, color: "#A1B2C3", text: "pink", bg: "#010203" });
  assert.equal(l.font, "hand");
  assert.equal(l.weight, 700);                    // to the nearest hundred
  assert.equal(l.spacing, M.SPACING_MAX);
  assert.equal(l.color, "#a1b2c3");
  assert.equal(l.text, "pink");
  assert.equal(l.bg, "#010203");
  const bad = M.cleanLook({ font: "comic", weight: -5, spacing: "x", color: "#12", text: "javascript:", bg: "url(x)" });
  assert.equal(bad.font, "thin"); assert.equal(bad.weight, 0); assert.equal(bad.spacing, 0);
  assert.equal(bad.color, "amber"); assert.equal(bad.text, "same"); assert.equal(bad.bg, "black");
  const pl = M.planLook(l);
  assert.equal(pl.ink, "#a1b2c3"); assert.equal(pl.text, M.inkHex("pink")); assert.equal(pl.bg, "#010203");
  assert.equal(pl.weight, 700); assert.equal(pl.spacing, M.SPACING_MAX);
  assert.equal(M.planLook(M.cleanLook({ color: "teal" })).text, M.inkHex("teal"));   // "same" follows the clock
  assert.equal(M.bgHex({ bg: "dim", color: "#ff0000" }), "#180202");                 // a dim shade of a wheel colour too
  assert.equal(M.LOOK_DEF.show.count, false);
});
ok("saving keeps every field: the Touch ID switch and the wake settings survive a Customise save", () => {
  const v = M.sleepModeOf({ sleepMode: { lock: false, wake: { timer: "sunrise", strobe: true } } });
  const back = M.sleepModeOf({ sleepMode: M.prefsOf({ ...v, look: M.cleanLook({ font: "serif" }) }) });
  assert.equal(back.lock, false);
  assert.equal(back.wake.timer, "sunrise");
  assert.equal(back.wake.strobe, true);
  assert.equal(back.look.font, "serif");
  assert.match(src("src/views/SleepCustomise.tsx"), /prefsOf\(/);
});
ok("Wake me up in: the research list (naps 10, 20, 90 plus 5; sleeps 4 h 30, 6 h, 7 h 30, 9 h plus 15), 7 h 30 first", () => {
  const c = W.wakeInChoices();
  assert.deepEqual(c.map((x) => x.sleep), [10, 20, 90, 270, 360, 450, 540]);
  assert.deepEqual(c.map((x) => x.mins), [15, 25, 95, 285, 375, 465, 555]);
  assert.deepEqual(c.map((x) => x.name), ["Nap", "Nap", "Nap", "Short sleep", "Short sleep", "5 sleep loops", "6 sleep loops"]);
  assert.equal(W.wakeInPick(), 465);
  assert.ok(!c.some((x) => x.name === "Nap" && x.sleep >= 30 && x.sleep <= 60));   // no 30 to 60 minute nap quick picks
  // One small table: change it and the suggestions follow.
  assert.deepEqual(W.wakeInChoices({ ...W.SLEEP_CYCLES, naps: [20], sleeps: [480], mainBuffer: 10, napBuffer: 0 }).map((x) => x.mins), [20, 490]);
});
ok("Wake me up in: the wake time lands on a whole minute, custom times are checked", () => {
  const now = at("2026-11-08T19:41:31Z");
  assert.equal(new Date(W.wakeInAt(now, 20)).toISOString(), "2026-11-08T20:02:00.000Z");   // 20:01:31 rounds to 20:02
  assert.equal(new Date(W.wakeInAt(at("2026-11-08T19:41:20Z"), 465)).toISOString(), "2026-11-09T03:26:00.000Z");
  assert.equal(W.okWakeIn(3), null); assert.equal(W.okWakeIn(5), 5); assert.equal(W.okWakeIn(16 * 60), 960); assert.equal(W.okWakeIn(961), null);
  assert.equal(W.okWakeIn("abc"), null);
  assert.equal(W.durText(20), "20 min"); assert.equal(W.durText(105), "1 h 45"); assert.equal(W.durText(420), "7 h"); assert.equal(W.durText(65), "1 h 05");
  assert.equal(W.countdownLine(now + 372 * 60_000, now), "Wakes you in 6 h 12");
  assert.equal(W.countdownLine(now + 4 * 60_000 - 10_000, now), "Wakes you in 4 min");
  assert.equal(W.countdownLine(now - 1, now), "Waking you now");
});
ok("Wake me up in: kept on the open sleep, rings on every device, goes when it has rung", () => {
  const now = at("2026-11-08T19:40:00Z");
  const o = { at: new Date(now).toISOString(), tz: TB };
  const o2 = M.timerOpen(o, 105, now + 60_000, "loud");
  assert.equal(o2.timer!.mins, 105);
  assert.equal(o2.timer!.at, "2026-11-08T21:26:00.000Z");
  assert.equal(o2.timer!.style, "loud");
  assert.equal(M.timerOpen(o2, null, now, "chime").timer, null);
  assert.equal(M.timerOpen(o, 2, now, "chime").timer, null);           // under 5 minutes: no timer
  const p = M.buildPlan({ since: now, tz: TB, prefs: { ...M.sleepModeOf({ sleepMode: { alarms: [{ id: "a", at: "07:30", on: true }] } }) }, tasks: [], squad: null, timer: o2.timer, now });
  assert.deepEqual(p.rings.map((r) => r.id), [M.TIMER_ID, "a"]);
  assert.equal(p.rings[0].label, "01:26");                              // Dubai
  assert.equal(p.rings[0].style, "loud");
  assert.equal(p.wake, Date.parse("2026-11-08T21:26:00Z"));             // the panel and the countdown point at it
  assert.deepEqual(p.timer, { at: Date.parse("2026-11-08T21:26:00Z"), mins: 105 });
  assert.equal(p.words.countdown, "Wakes you in 1 h 46");
  assert.equal(p.words.alarm, "Alarms 01:26 (Wake me up in) and 07:30");
  assert.equal(p.wakeIn.length, 7);
  // Wake up after it rang: the timer is done with, so Back to sleep never rings it again. Before it: kept.
  assert.equal(M.pauseOpen(o2, Date.parse("2026-11-08T21:30:00Z")).timer, null);
  assert.equal(M.pauseOpen(o2, Date.parse("2026-11-08T21:00:00Z")).timer!.mins, 105);
  assert.equal(M.resumeOpen({ ...o2, paused: "2026-11-08T21:00:00.000Z" }, Date.parse("2026-11-08T21:05:00Z")).timer!.mins, 105);
  // A timer from before this sleep never rings.
  assert.equal(M.buildPlan({ since: now, tz: TB, prefs: M.sleepModeOf(undefined), tasks: [], squad: null, timer: { at: new Date(now - 60_000).toISOString(), mins: 20, style: "chime" } }).rings.length, 0);
  assert.equal(W.cleanTimer({ at: "nope", mins: 20 }), null);
  assert.equal(W.cleanTimer({ at: o2.timer!.at, mins: 105, style: "evil" })!.style, "chime");
});
ok("wake styles: one per alarm, Strobe flash rings as Bright white until switched on, Sunrise lights up first", () => {
  const since = at("2026-11-07T19:40:00Z");
  const alarms = [{ id: "a", at: "07:30", on: true, style: "sunrise" as const }, { id: "b", at: "07:40", on: true, style: "strobe" as const }, { id: "c", at: "07:50", on: true }];
  const c = M.cleanSleepMode({ alarms: [...alarms, { id: "d", at: "08:00", on: true, style: "disco" }] });
  assert.equal(c.alarms![0].style, "sunrise");
  assert.equal(c.alarms![3].style, undefined);
  const off = M.ringsFor(alarms, since, TB, W.cleanWake({ sunrise: 30 }));
  assert.deepEqual(off.map((r) => r.style), ["sunrise", "white", "chime"]);
  assert.equal(off[0].at - off[0].from!, 30 * 60_000);
  assert.equal(off[1].from, off[1].at);
  assert.equal(M.ringsFor(alarms, since, TB, W.cleanWake({ strobe: true }))[1].style, "strobe");
  // An early sunrise never starts before you went to sleep.
  const r = M.ringsFor([{ id: "a", at: "23:50", on: true, style: "sunrise" }], since, TB, W.cleanWake({ sunrise: 30 }));
  assert.equal(r[0].from, since);
  // The light before the alarm: only inside the sunrise, and not once that ring is done.
  const done = new Set<string>();
  assert.equal(M.dawnRing(off, off[0].from! - 1, done), null);
  assert.equal(M.dawnRing(off, off[0].from! + 60_000, done)!.id, "a");
  assert.equal(M.dawnRing(off, off[0].at, done), null);
  done.add(M.ringKey(off[0]));
  assert.equal(M.dawnRing(off, off[0].from! + 60_000, done), null);
  assert.deepEqual(W.cleanWake({ timer: "evil", sunrise: 45, wave: "red", strobe: "yes", level: "max" }), W.WAKE_DEF);
  assert.equal(W.cleanWake({ level: 0.42 }).level, 0.4);   // V1.44 alarm loudness, steps of 5%
  assert.equal(W.cleanWake({}).level, 0.8);
});
ok("wake styles: sounds rise unless Loud, Silent light is silent", () => {
  // V1.44: every style starts at half or more and is full within 30 seconds (V1.43 started at 12 to 15%).
  assert.equal(W.ringVolume("chime", 0), 0.5);
  assert.ok(Math.abs(W.ringVolume("chime", 10_000) - 0.75) < 1e-9);
  assert.equal(W.ringVolume("chime", 20_000), 1);
  for (const s of W.WAKE_STYLES) if (s !== "light") { assert.ok(W.ringVolume(s, 0) >= 0.5, s); assert.equal(W.ringVolume(s, 30_000), 1, s); }
  assert.equal(W.ringVolume("chime", 10 * 60_000), 1);
  assert.equal(W.ringVolume("loud", 0), 1);
  assert.equal(W.ringVolume("light", 60_000), 0);
  for (const s of W.WAKE_STYLES) if (s !== "loud" && s !== "light") assert.ok(W.ringVolume(s, 0) < W.ringVolume(s, 4_000), s);
  assert.equal(W.WAKE_SPEC.loud.loud, true);
  assert.equal(W.WAKE_SPEC.white.bright, true);
  assert.equal(Object.values(W.WAKE_SPEC).filter((x) => x.loud).length, 1);   // only Loud ignores the alarm loudness (always 100%)
});
ok("wake styles: the light (sunrise ramp, red pulse, wave, white, a strobe never over 3 a second)", () => {
  const o = { dawnMs: 20 * 60_000, wave: [10, 20, 250] as [number, number, number], ink: [231, 163, 94] as [number, number, number] };
  assert.equal(W.wakeLight("chime", 1000, o), null);
  assert.equal(W.wakeLight("loud", 1000, o), null);
  assert.equal(W.wakeLight("alert", -1000, o), null);
  const s0 = W.wakeLight("sunrise", -o.dawnMs, o)!, s5 = W.wakeLight("sunrise", -o.dawnMs / 2, o)!, s1 = W.wakeLight("sunrise", 0, o)!;
  assert.ok(s0.rgb[0] < 60 && s0.a < 0.3);                     // starts dark red and dim
  assert.ok(s5.rgb[0] > s0.rgb[0] && s5.a > s0.a);             // warms up
  assert.ok(s1.rgb[2] > 200 && s1.a === 1);                     // bright warm white at the alarm
  assert.equal(W.wakeLight("sunrise", -o.dawnMs - 1, o), null);
  const a0 = W.wakeLight("alert", 0, o)!, a1 = W.wakeLight("alert", W.PULSE_MS / 2, o)!;
  assert.ok(a0.a < 0.3 && a1.a === 1 && a1.rgb[0] === 255 && a1.rgb[1] < 40);
  assert.deepEqual(W.wakeLight("wave", W.WAVE_MS / 2, o)!.rgb, [10, 20, 250]);
  assert.deepEqual(W.wakeLight("white", 5, o), { rgb: [255, 255, 255], a: 1 });
  // Strobe: count the changes from white to black over 10 seconds at 1 ms steps.
  let flashes = 0, prev = W.strobeOn(0);
  for (let t = 1; t <= 10_000; t++) { const on = W.strobeOn(t); if (on && !prev) flashes++; prev = on; }
  assert.ok(flashes / 10 <= W.STROBE_MAX_HZ, `flashes a second ${flashes / 10}`);
  assert.equal(flashes, 20);                                    // 2 a second
  assert.equal(W.STROBE_HZ, 2);
  let fast = 0; prev = W.strobeOn(0, 50);
  for (let t = 1; t <= 10_000; t++) { const on = W.strobeOn(t, 50); if (on && !prev) fast++; prev = on; }
  assert.ok(fast / 10 <= W.STROBE_MAX_HZ);                      // even asked for 50, it stays at 3 at most
  assert.equal(W.inkOn({ rgb: [255, 255, 255], a: 1 }), "dark");
  assert.equal(W.inkOn({ rgb: [36, 2, 0], a: 0.3 }), "light");
  assert.match(W.STROBE_WARN, /seizures/);
});
ok("V1.43 words: no dashes in any new sentence", () => {
  const words = [...Object.values(W.WAKE_NAMES), ...Object.values(W.WAKE_NOTES), W.STROBE_WARN, ...Object.values(M.FONT_NAMES), ...Object.values(M.COLOR_NAMES),
    ...Object.values(M.WEIGHT_NAMES), ...M.BGS.map((b) => b.name), ...Object.values(M.sleepWords({ rings: [], tasks: 0, squad: null })).filter((x): x is string => typeof x === "string")];
  for (const w of words) assert.equal(/[–—]/.test(w), false, w);
  for (const f of ["src/core/sleepwake.ts", "src/views/SleepMode.tsx", "src/views/SleepCustomise.tsx", "src/views/SleepFace.tsx", "src/views/SleepWake.tsx", "src/views/sleepmode.css"])
    if (existsSync(new URL(`../${f}`, import.meta.url))) assert.equal(/[–—]/.test(src(f)), false, f);
});

// ---------- V1.47: Sleep mode's own settings, full screen (core/sleepsettings.ts, views/SleepSettings.tsx) ----------
ok("Sleep settings: eight simple groups, each with a row before More, one plain line on every setting", () => {
  assert.deepEqual(SS.SLEEP_GROUPS.map((g) => g.id), ["alarms", "clock", "screen", "log", "styles", "watch", "leave", "device"]);
  // The main pages keep the few things people set (V1.47); the rest is under More.
  const main = SS.SLEEP_GROUPS.flatMap((g) => SS.sleepRowsOf(g.id, "mac").main.map((e) => e.id));
  assert.ok(main.length <= 18, `${main.length} main rows`);
  for (const id of ["alarms", "wake-in", "face", "size", "font", "colour", "bright", "pieces", "ask", "breaks"]) assert.ok(main.includes(id), id);
  for (const id of ["loudness", "details", "panel", "pointer", "weight", "spacing"]) assert.ok(!main.includes(id), id);
  for (const w of ["mac", "web", "phone"] as const) for (const g of SS.SLEEP_GROUPS) assert.ok(SS.sleepRowsOf(g.id, w).main.length > 0, `${w} ${g.id}`);
  for (const e of SS.SLEEP_ENTRIES) {
    assert.ok(e.line.length > 10 && e.line.length < 140, e.id);
    assert.equal(/[\u2013\u2014]/.test(e.name + e.line + (e.words ?? []).join(" ")), false, e.id);
  }
  assert.equal(new Set(SS.SLEEP_ENTRIES.map((e) => e.id)).size, SS.SLEEP_ENTRIES.length);
  assert.ok(!SS.sleepRowsOf("watch", "phone").main.some((e) => e.id === "pointer"));   // no pointer on a phone
  assert.ok(SS.sleepRowsOf("clock", "mac").more.some((e) => e.id === "spacing"));      // rare ones under More
});
ok("Sleep settings: nothing is lost, every old setting has a place, and every place has a control", () => {
  for (const m of SS.MOVED) assert.ok(SS.sleepEntry(m.now), `${m.old} -> ${m.now}`);
  assert.equal(SS.MOVED.length, 30);
  const view = src("src/views/SleepSettings.tsx");
  for (const e of SS.SLEEP_ENTRIES) {
    if (e.id === "esc" || e.id === "breaks") continue;   // a plain line, no control
    assert.ok(new RegExp(`(case "${e.id}"|\\b${e.id.replace(/-/g, "\\-")}: ")`).test(view), `${e.id} has a control`);
  }
  // The alarm sound's place for V1.47's playlists and libraries.
  assert.match(view, /case "sound":/);
});
ok("Sleep settings: its own search, and the main Settings search finds each one and opens it there", () => {
  const ids = (q: string, w: "mac" | "web" | "phone" = "mac") => SS.searchSleep(q, w).map((e) => e.id);
  assert.equal(ids("touch id")[0], "lock");
  assert.equal(ids("font")[0], "font");
  assert.equal(ids("strobe")[0], "strobe");
  assert.equal(ids("nap")[0], "wake-in");
  assert.ok(!ids("pointer", "phone").includes("pointer"));   // no pointer setting on a phone
  assert.deepEqual(ids("zzqx"), []);
  const ctx = { red: false, where: "mac" as const };
  const hit = SI.searchSettings("sunrise starts", ctx)[0].e;
  assert.equal(hit.id, "sleep.sunrise"); assert.equal(hit.go, "sleepSettings");
  assert.equal(SI.landingOf(hit).id, "sleep-settings");
  for (const e of SS.SLEEP_ENTRIES) assert.ok(SI.settingById(`sleep.${e.id}`), e.id);
  assert.equal(SI.groupById("sleep").label, "Sleep mode");
});
ok("Sleep settings open from the pencil, a right click on the button and Settings; Esc steps out one layer at a time", () => {
  const v = src("src/views/SleepMode.tsx"), s = src("src/views/SleepSettings.tsx");
  assert.match(v, /className="slp-pen"[^\n]*openSleepSettings\(\)/);
  assert.match(v, /onContextMenu=\{\(e\) => \{[^\n]*openSleepSettings\(\)/);
  assert.match(v, /<SleepSettingsHost \/>/);
  assert.doesNotMatch(v, /SleepSettingsLayer|className="slp-sheet"/);   // the old sheet is gone
  assert.match(s, /if \(fromEsc && q\) \{ setQ\(""\); return; \}/);
  assert.match(s, /if \(narrow && inside\)/);
  assert.match(s, /wakeOverlayUp\(\) \|\| sleepState\(\)\.customising/);
  assert.match(s, /__psDimxClose/);
  assert.match(s, /psPost\(\{ type: "dimx", open: true \}\)/);
});

// ---------- V1.47: a sound per alarm, custom sounds loop until Stop, alarms ring with Sleep mode off, the gear ----------
ok("each alarm keeps its own sound; junk is the default; Alarms ring even when Sleep mode is off is on by default", () => {
  const c = M.cleanSleepMode({ alarms: [{ id: "a", at: "07:00", sound: "own" }, { id: "b", at: "08:00", sound: "t:0123456789abcdef" }, { id: "c", at: "09:00", sound: "t:zz" }, { id: "d", at: "10:00", sound: "auto" }] });
  assert.deepEqual(c.alarms!.map((a) => a.sound), ["own", "t:0123456789abcdef", undefined, undefined]);
  assert.equal(M.sleepModeOf(undefined).ringAlways, true);
  assert.equal(M.sleepModeOf({ sleepMode: { ringAlways: false } }).ringAlways, false);
  assert.equal(M.prefsOf(M.sleepModeOf({ sleepMode: { ringAlways: false } })).ringAlways, false);   // a save keeps it
  const r = M.ringsFor(c.alarms!, at("2026-11-07T19:40:00Z"), TB);
  assert.equal(r.find((x) => x.id === "a")!.sound, "own");
  assert.equal(r.find((x) => x.id === "d")!.sound, undefined);
});
ok("what a ring plays: built in stops after 10 minutes; your own sound and a playlist file loop until Stop", () => {
  const list = { on: true, end: "loop" as const, fade: 10, days: { "2026-11-11": { id: "aaaaaaaaaaaaaaaa", name: "Talk", secs: 600, n: 1, of: 2 } } };
  const day = "2026-11-11";
  assert.deepEqual(M.ringPlay({}, null, day, false), { kind: "builtin", len: M.RING_FOR });
  assert.deepEqual(M.ringPlay({}, null, day, true), { kind: "own", len: M.FOREVER });
  assert.deepEqual(M.ringPlay({ sound: "builtin" }, list, day, true), { kind: "builtin", len: M.RING_FOR });
  assert.deepEqual(M.ringPlay({}, list, day, true), { kind: "track", id: "aaaaaaaaaaaaaaaa", loop: true, fade: 10, len: M.FOREVER });
  assert.deepEqual(M.ringPlay({ sound: "t:bbbbbbbbbbbbbbbb" }, null, day, false), { kind: "track", id: "bbbbbbbbbbbbbbbb", loop: true, fade: 0, len: M.FOREVER });
  assert.equal(M.ringPlay({}, { ...list, on: false }, day, false).kind, "builtin");      // the playlist only for alarms set to it
  assert.equal(M.ringPlay({ sound: "list" }, { ...list, on: false }, day, false).kind, "track");
  assert.equal(M.ringPlay({ sound: "list" }, list, "2026-11-12", true).kind, "own");     // no file that day: your own sound
  const whole = M.ringPlay({ sound: "list" }, { ...list, end: "whole" as const }, day, false);
  assert.equal(whole.kind === "track" && whole.loop, false);
  assert.ok(Number.isFinite(whole.len));
  assert.equal(M.stillRinging(0, 10 * 3600_000, M.FOREVER), true);
});
ok("the plan: the days' files go when an alarm plays the playlist even with it off; an alarm while Sleep mode is off is marked", () => {
  const prefs = M.sleepModeOf({ sleepMode: { alarms: [{ id: "a", at: "07:30", on: true, sound: "list" }],
    wake: { list: { on: false, order: "seq", end: "loop", fade: 0, tracks: [{ id: "aaaaaaaaaaaaaaaa", name: "Talk", secs: 60, bytes: 1000, ext: "mp3" }], seed: "s", start: "", cycle: [] } } } });
  const now = at("2026-11-10T19:40:00Z");
  const p = M.buildPlan({ since: now, tz: TB, prefs, tasks: [], squad: null, now, alarmOnly: true });
  assert.ok(p.list && p.list.on === false && Object.keys(p.list.days).length > 0);
  assert.equal(p.alarmOnly, true);
  assert.equal(p.rings[0].sound, "list");
  const off = M.buildPlan({ since: now, tz: TB, prefs: { ...prefs, alarms: [{ id: "a", at: "07:30", on: true }] }, tasks: [], squad: null, now });
  assert.equal(off.list, null);
  assert.equal(off.alarmOnly, undefined);
});
ok("wiring (V1.47): a Sound on each alarm row, the web gear, the shells get the alarms, their gear opens Sleep settings", () => {
  const v = src("src/views/SleepMode.tsx"), w = src("src/views/SleepWake.tsx"), e = src("src/sleepmode/engine.ts"), ss = src("src/views/SleepSettings.tsx");
  assert.match(v, /<SoundPick value=\{a\.sound \?\? "auto"\}/);
  assert.match(w, /export function SoundPick/);
  assert.match(v, /className="slp-gear"/);
  assert.match(v, /ringPlay\(due, plan\.list/);
  assert.match(e, /type: "sleep:alarms", plan/);
  assert.match(e, /m\.alarmOnly === true/);
  assert.match(e, /m\.stopped === "settings"/);
  assert.match(e, /m\.type === "sleep:settings"/);
  assert.match(ss, /case "ring-always":/);
  assert.match(ss, /Back to sleep/);
  assert.match(ss, /<PinnedPreview id="sleep-screen"/);
  assert.match(src("src/looks/AppearanceSettings.tsx"), /<PinnedPreview id="look-accent"/);
});
const mac = process.env.PS_MAC_DIR || `${process.env.HOME}/Projects/ps-mac`;
if (existsSync(`${mac}/Sources/SleepScreen.swift`)) ok("Mac: power assertion, battery stop, Touch ID to leave, never over 1Password or Signal", () => {
  const s = readFileSync(`${mac}/Sources/SleepScreen.swift`, "utf8");
  assert.match(s, /IOPMAssertionCreateWithName/);
  assert.match(s, /stopPct = 20/);
  assert.match(s, /TouchLock\.evaluate/);
  assert.match(s, /Protected\.matches/);
  assert.equal(/[–—]/.test(s), false);
});
if (existsSync(`${mac}/Sources/SleepScreen.swift`) && /authTimeout/.test(readFileSync(`${mac}/Sources/SleepScreen.swift`, "utf8"))) ok("Mac (V1.41): every sleep message and Wake up step is logged, a Touch ID that never answers frees the button, the prompt is never under the clock", () => {
  const s = readFileSync(`${mac}/Sources/SleepScreen.swift`, "utf8");
  assert.match(s, /psLog\("PS sleep: got \\\(type\)/);
  if (!/custTapped/.test(s)) assert.match(s, /psLog\("PS sleep: Wake up pressed/);   // a V1.41 checkout
  else {                                                                                // V1.42: Wake up and Customise share one ask
    assert.match(s, /psLog\("PS sleep: \\\(name\) pressed/);
    assert.match(s, /@objc private func wakeTapped\(\) \{ ask\("wake"\) \}/);
    assert.match(s, /@objc private func custTapped\(\) \{ ask\("customise"\) \}/);
    assert.match(s, /NSCursor\.setHiddenUntilMouseMoves\(true\)/);
    assert.match(s, /func showPointer\(\)/);
  }
  assert.match(s, /authTimeout/);
  assert.match(s, /w\.level = \.normal/);
});
if (existsSync(`${mac}/Sources/SleepWake.swift`)) ok("Mac (V1.43): the same wake numbers, Stop needs no Touch ID, Loud and Bright white give everything back, a test copy never touches the volume", () => {
  const w = readFileSync(`${mac}/Sources/SleepWake.swift`, "utf8"), s = readFileSync(`${mac}/Sources/SleepScreen.swift`, "utf8");
  assert.match(w, /strobeHz = 2\.0, strobeMaxHz = 3\.0/);
  assert.match(w, /pulseMs = 2000\.0, waveMs = 6000\.0, breatheMs = 4000\.0/);
  assert.match(w, /\(\[10, 20, 90\]\.map[\s\S]{0,120}\+ 5[\s\S]{0,200}\[270, 360, 450, 540\][\s\S]{0,120}\+ 15/);   // the same fallback list
  assert.equal(W.STROBE_HZ, 2); assert.equal(W.PULSE_MS, 2000); assert.equal(W.WAVE_MS, 6000); assert.equal(W.BREATHE_MS, 4000);
  for (const f of ["AtkinsonHyperlegibleNext-Variable", "JetBrainsMono-Variable", "IBMPlexMono-Regular", "SourceSerif4-Variable", "Silkscreen-Regular", "PixelifySans-Variable", "Caveat-Variable", "PatrickHand-Regular", "GochiHand-Regular"]) {
    assert.match(w, new RegExp(`"${f}"`)); assert.match(src("src/views/sleepmode.css"), new RegExp(`${f}\\.(woff2|ttf)`));
  }
  assert.match(s, /@objc private func stopTapped\(\) \{ stopRing\(\); poke\(\) \}/);   // no Touch ID to stop the sound
  assert.match(s, /private func stopRing\(\) \{[\s\S]{0,600}giveBack\(\)/);
  assert.match(s, /volumeGet: \{ nil \}, volumeSet: \{ _, _ in \}, brightGet: \{ _ in nil \}, brightSet: \{ _, _ in \}/);
  assert.match(s, /"wakeIn\\":/);
  assert.equal(/[\u2013\u2014]/.test(w + s), false);
});
// ---------- V1.52 (the developer): the AI Sentry mode button on the Mac's sleep screen ----------
ok("V1.52 the look: where the AI Sentry mode button sits, left centre by default, synced with the look", () => {
  assert.equal(M.LOOK_DEF.sentry, "left");
  assert.equal(M.cleanLook({ sentry: "bottomRight" }).sentry, "bottomRight");
  assert.equal(M.cleanLook({ sentry: "hidden" }).sentry, "hidden");
  assert.equal(M.cleanLook({ sentry: "middle" }).sentry, "left");
  assert.equal(M.planLook(M.cleanLook({ sentry: "right" })).sentry, "right");
  assert.equal(M.sleepModeOf({ sleepMode: { look: { sentry: "bottomLeft" } } }).look.sentry, "bottomLeft");
});
ok("V1.52 the plan: the button's part only when asked for (the Mac), never with an alarm while Sleep mode is off", () => {
  const prefs = M.sleepModeOf(undefined);
  const base = { since: at("2026-11-07T19:40:00Z"), tz: TB, prefs, tasks: [], squad: null };
  const sentry = { prefs: { lowStop: true, lowPct: 10, lid: true, lidSet: false, restartH: 8, restartSleepH: 18 }, reboot: { helper: "on" } };
  assert.equal(M.buildPlan(base).sentry, undefined, "the phone and the website get none");
  const p = M.buildPlan({ ...base, sentry });
  assert.deepEqual(p.sentry?.plan, { lowStop: true, lowPct: 10, lid: true, restartH: 18 }, "the Sleep mode restart time is armed");
  assert.equal(p.sentry?.check, null);
  assert.equal(M.buildPlan({ ...base, sentry, alarmOnly: true }).sentry, undefined);
  const e = src("src/sleepmode/engine.ts");
  assert.ok(e.includes('WHERE === "mac" ? { prefs: sentryOf(settingsData(s)), reboot: psSettingsNow()?.reboot } : null'), "only the Mac's plan carries it");
});
ok("V1.52 settings: the AI Sentry mode button row, on a Mac only, in Customise and Sleep mode's settings", () => {
  const e = SS.sleepEntry("sentry");
  assert.ok(e && e.group === "screen" && !e.more && e.name === "AI Sentry mode button");
  assert.deepEqual(e!.on, ["mac"]);
  assert.ok(SS.sleepRowsOf("screen", "mac").main.some((x) => x.id === "sentry"));
  assert.ok(!SS.sleepRowsOf("screen", "phone").main.some((x) => x.id === "sentry") && !SS.sleepRowsOf("screen", "web").main.some((x) => x.id === "sentry"));
  assert.equal(SS.searchSleep("sentry", "mac")[0]?.id, "sentry");
  const c = src("src/views/SleepCustomise.tsx"), st = src("src/views/SleepSettings.tsx");
  assert.ok(c.includes('case "sentry": return seg("AI Sentry mode button"') && c.includes('WHERE === "mac" && row("AI Sentry mode button", "sentry"'));
  assert.ok(st.includes('sentry: "sentry" }'), "Sleep mode's settings draw the same control");
  // V1.52 (the developer): Restart if not unlocked during Sleep mode, next to the button choice, the same synced value as Settings
  const r = SS.sleepEntry("sentry-restart");
  assert.ok(r && r.group === "screen" && r.name === "Restart if not unlocked during Sleep mode");
  assert.deepEqual(r!.on, ["mac"]);
  assert.ok(st.includes('case "sentry-restart": return { body: <SentryRestartSleepSetting /> };'));
  assert.ok(!/[\u2013\u2014]/.test(e!.line + e!.name));
});
ok("PS 1.68: an unanswered sleep is logged by itself (at the next Sleep press, or 3 hours after waking), never over a typed one", () => {
  const open = { at: "2026-11-17T21:30:00.000Z", tz: TB, woke: "2026-11-18T04:00:00.000Z" };
  const woke = at("2026-11-18T04:00:00Z");
  assert.equal(M.unsavedLog(open, woke + 60 * 60_000, null), null, "an hour after waking: the card may still be answered");
  const log = M.unsavedLog(open, woke + 3 * 3_600_000, null)!;
  assert.ok(log && log.src === "sleepmode", "3 hours after waking: logged");
  assert.equal(log.day, "2026-11-18");
  assert.ok(M.unsavedLog(open, woke + 60_000, null, true), "the next Sleep press logs it at once");
  assert.equal(M.unsavedLog(open, woke + 5 * 3_600_000, { src: "manual" }), null, "a sleep typed by hand is never replaced");
  assert.ok(M.unsavedLog(open, woke + 5 * 3_600_000, { src: "sleepmode" }), "an earlier Sleep mode one for that date is");
  assert.equal(M.unsavedLog({ at: open.at, tz: TB }, woke + 5 * 3_600_000, null), null, "not woken yet: nothing");
  assert.equal(M.unsavedLog(null, woke, null), null);
  const e = readFileSync(new URL("../src/sleepmode/engine.ts", import.meta.url), "utf8");
  assert.match(e, /if \(live\(openSleep\(\)\)\) return;\n  await logUnsaved\(true\);/, "before a new sleep writes over it");
  assert.match(e, /void logUnsaved\(\); \}\);/, "and on every vault change");
});
console.log(`\n${n} passed`);
