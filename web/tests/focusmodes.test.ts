// Run: node --experimental-strip-types tests/focusmodes.test.ts
// V1.43 Do Not Disturb settings and focus modes (src/core/dnd.ts), and the hover card's placing and words
// (src/core/hovercard.ts, src/core/hoverwords.ts). FICTIONAL data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const D = await import("../src/core/dnd.ts");
const H = await import("../src/core/hovercard.ts");
const W = await import("../src/core/hoverwords.ts");

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const T0 = Date.parse("2026-11-09T10:00:00.000Z");   // a Monday, 14:00 in the developer's city
const TZ = "Asia/Dubai";
const H1 = 3600_000, M = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const DASH = new RegExp("[\\u2013\\u2014]");

// ---------- modes ----------
ok("no modes saved: the four built in ones, Do Not Disturb first and keeping the old switches", () => {
  const m = D.modesOf({ on: false, pass: ["meetings"] });
  assert.deepEqual(m.map((x) => x.id), ["dnd", "deep", "calls", "sleep"]);
  assert.deepEqual(m[0].pass, ["meetings"]);
  assert.equal(D.moonMode(undefined).id, "dnd");
  assert.equal(D.activeMode({ on: false }, T0), null);
});

ok("the moon with no mode picked behaves as before (every toggle muted, same since)", () => {
  const d = D.dndApply(undefined, { op: "on" }, T0);
  assert.equal(d.on, true); assert.equal(d.since, iso(T0)); assert.equal(d.until, null);
  assert.equal(d.active, "dnd"); assert.equal(d.by, "hand");
  for (const x of D.DND_KINDS) assert.equal(D.dndMutes(d, x.k, T0), true, x.k);
});

ok("turning on a mode copies its switches into the live list, so every reader honours it", () => {
  const d = D.dndApply(undefined, { op: "on", mode: "calls" }, T0);
  assert.equal(D.activeMode(d, T0)!.id, "calls");
  assert.equal(D.dndMutes(d, "meetings", T0), false);
  assert.equal(D.dndMutes(d, "mail", T0), false);
  assert.equal(D.dndMutes(d, "chats", T0), true);
  assert.equal(D.dndNative(d, T0).mute.meetings, false);
});

ok("a mode's length sets the end time; a past time is never kept", () => {
  const deep = D.modesOf(undefined).find((m) => m.id === "deep")!;
  const u = D.modeUntil(deep, T0, TZ);
  assert.equal(u, iso(T0 + H1));
  const d = D.dndApply(undefined, { op: "on", mode: "deep", until: u }, T0);
  assert.equal(D.dndEndsAt(d, T0), T0 + H1);
  assert.equal(D.dndActive(d, T0 + H1 + 1), false);
  assert.equal(D.dndApply(undefined, { op: "on", until: iso(T0 - M) }, T0).until, null);
  assert.equal(D.modeUntil(D.modesOf(undefined)[0], T0), null);
});

ok("picking the moon's mode while off saves it; while on it takes over at once and keeps the end time", () => {
  let d = D.dndApply(undefined, { op: "pick", mode: "deep" }, T0);
  assert.equal(d.on, false); assert.equal(D.moonMode(d).id, "deep");
  d = D.dndApply(d, { op: "on", until: iso(T0 + 2 * H1) }, T0);
  assert.equal(D.activeMode(d, T0)!.id, "deep");
  d = D.dndApply(d, { op: "pick", mode: "calls" }, T0 + M);
  assert.equal(D.activeMode(d, T0 + M)!.id, "calls");
  assert.equal(d.mode, "calls");
  assert.equal(d.until, iso(T0 + 2 * H1));
  assert.equal(d.since, iso(T0), "the same stretch");
  assert.equal(D.dndMutes(d, "meetings", T0 + M), false);
  assert.deepEqual(D.dndApply(d, { op: "pick", mode: "nope" }, T0), d, "an unknown mode changes nothing");
});

ok("a switch changes only its own mode, and the live list only when that mode is on", () => {
  let d = D.dndApply(undefined, { op: "on", mode: "dnd" }, T0);
  d = D.dndApply(d, { op: "pass", kind: "sounds", pass: true, mode: "deep" }, T0);
  assert.equal(D.dndMutes(d, "sounds", T0), true, "Deep work is not on");
  assert.deepEqual(D.modesOf(d).find((m) => m.id === "deep")!.pass, ["sounds"]);
  d = D.dndApply(d, { op: "pass", kind: "mail", pass: true }, T0);   // no mode: the one on
  assert.equal(D.dndMutes(d, "mail", T0), false);
  assert.deepEqual(D.modesOf(d)[0].pass, ["mail"]);
  d = D.dndApply(d, { op: "pick", mode: "deep" }, T0);
  assert.equal(D.dndMutes(d, "sounds", T0), false); assert.equal(D.dndMutes(d, "mail", T0), true);
});

ok("create, rename, change the icon, delete; at most 8; never the last one", () => {
  let d = D.dndApply(undefined, { op: "addMode", id: "m1abc", name: "Reading", icon: "book" }, T0);
  assert.equal(D.modesOf(d).length, 5);
  assert.deepEqual(D.modesOf(d)[4], { id: "m1abc", name: "Reading", icon: "book", pass: [] });
  assert.deepEqual(D.dndApply(d, { op: "addMode", id: "m1abc", name: "Again", icon: "bolt" }, T0), d, "same id twice");
  d = D.dndApply(d, { op: "editMode", mode: "m1abc", patch: { name: "  Reading   time  ", icon: "leaf" } }, T0);
  assert.equal(D.modesOf(d)[4].name, "Reading time"); assert.equal(D.modesOf(d)[4].icon, "leaf");
  d = D.dndApply(d, { op: "editMode", mode: "m1abc", patch: { name: "   " } }, T0);
  assert.equal(D.modesOf(d)[4].name, "Reading time", "an empty name is never saved");
  for (let i = 0; i < 6; i++) d = D.dndApply(d, { op: "addMode", id: `x${i}`, name: `Focus ${i}`, icon: "moon" }, T0);
  assert.equal(D.modesOf(d).length, D.MAX_MODES);
  for (const m of D.modesOf(d).slice(1)) d = D.dndApply(d, { op: "delMode", mode: m.id }, T0);
  assert.equal(D.modesOf(d).length, 1);
  assert.equal(D.modesOf(D.dndApply(d, { op: "delMode", mode: "dnd" }, T0)).length, 1, "the last one stays");
});

ok("deleting the mode that is on keeps Do Not Disturb on with the moon's mode", () => {
  let d = D.dndApply(undefined, { op: "pick", mode: "calls" }, T0);
  d = D.dndApply(d, { op: "on", mode: "deep" }, T0);
  d = D.dndApply(d, { op: "delMode", mode: "deep" }, T0);
  assert.equal(d.on, true);
  assert.equal(D.activeMode(d, T0)!.id, "calls");
  assert.equal(D.dndMutes(d, "meetings", T0), false);
  d = D.dndApply(d, { op: "delMode", mode: "calls" }, T0);
  assert.equal(D.moonMode(d).id, "dnd", "the moon's own mode deleted: the first one");
});

ok("only one mode turns on with Sleep mode", () => {
  let d = D.dndApply(undefined, { op: "editMode", mode: "sleep", patch: { sleep: true } }, T0);
  d = D.dndApply(d, { op: "editMode", mode: "deep", patch: { sleep: true } }, T0);
  assert.deepEqual(D.modesOf(d).filter((m) => m.sleep).map((m) => m.id), ["deep"]);
  d = D.dndApply(d, { op: "editMode", mode: "deep", patch: { sleep: false } }, T0);
  assert.equal(D.modesOf(d).some((m) => m.sleep), false);
});

// ---------- people who get through ----------
ok("people who always get through: an address, a whole domain or part of a name, only in the mode that is on", () => {
  let d = D.dndApply(undefined, { op: "senders", mode: "deep", list: ["Pat@Example.com", "@acme.test", "jordan", "pat@example.com", "x"] }, T0);
  assert.deepEqual(D.modesOf(d).find((m) => m.id === "deep")!.senders, ["pat@example.com", "@acme.test", "jordan"]);
  assert.equal(D.dndLetsSender(d, "pat@example.com", null, T0), false, "off: nothing to let through");
  d = D.dndApply(d, { op: "on", mode: "deep" }, T0);
  assert.equal(D.dndLetsSender(d, "PAT@example.com", null, T0), true);
  assert.equal(D.dndLetsSender(d, "sam@acme.test", null, T0), true);
  assert.equal(D.dndLetsSender(d, "sam@notacme.test", null, T0), false);
  assert.equal(D.dndLetsSender(d, "j@other.test", "Jordan Lee", T0), true);
  assert.equal(D.dndLetsSender(d, "lee@other.test", "Lee Smith", T0), false);
  d = D.dndApply(d, { op: "pick", mode: "dnd" }, T0);
  assert.equal(D.dndLetsSender(d, "pat@example.com", null, T0), false, "another mode on");
  assert.equal(D.cleanSenders(Array.from({ length: 30 }, (_, i) => `p${i}@a.test`)).length, D.MAX_SENDERS);
});

ok("the mail pop-ups let those people through and tell the Mac's own stack (dndPass)", () => {
  const src = readFileSync(new URL("../src/mailcards.ts", import.meta.url), "utf8");
  assert.match(src, /dndLetsSender\(st\.dnd, c\.from, c\.fromName, now\)/);
  assert.match(src, /if \(letThrough\.has\(id\)\) return false;/);
  assert.match(src, /dndPass: true/);
  assert.match(readFileSync(new URL("../src/core/mailcards.ts", import.meta.url), "utf8"), /from: r\.data\.from, fromName: r\.data\.fromName \?\? null,/);
});

ok("G Squad has its own switch: chat sounds (the money nudge is gone since V1.43, so the board never checks it)", () => {
  assert.ok(D.DND_KINDS.some((x) => x.k === "gsquad"));
  assert.ok(!/dndMutes/.test(readFileSync(new URL("../src/squad/board.ts", import.meta.url), "utf8")), "no money pop-up to hold");
  assert.match(readFileSync(new URL("../src/squad/chatengine.ts", import.meta.url), "utf8"), /dndMutes\(st\.dnd, "gsquad", Date\.now\(\), "mac"\)/);
  const d = D.dndApply(undefined, { op: "on" }, T0);
  assert.equal(D.dndNative(d, T0).mute.gsquad, true);
});

// ---------- schedules ----------
const weekdays = { on: true, days: [1, 2, 3, 4, 5], from: "09:00", to: "12:00" };
const nights = { on: true, days: [0, 1, 2, 3, 4, 5, 6], from: "23:00", to: "07:00" };
const at = (hhmm: string, day = "2026-11-09") => D.wallMs(+day.slice(0, 4), +day.slice(5, 7), +day.slice(8, 10), +hhmm.slice(0, 2), +hhmm.slice(3), TZ);

ok("wall clock times in the developer's zone (Dubai is UTC+4)", () => {
  assert.equal(iso(at("14:00")), "2026-11-09T10:00:00.000Z");
  assert.equal(iso(D.wallMs(2026, 3, 29, 9, 0, "Europe/London")), "2026-03-29T08:00:00.000Z", "the day the clocks go forward");
});

ok("a schedule window: inside, outside, the wrong day, past midnight", () => {
  assert.deepEqual(D.scheduleWindow(weekdays, at("10:30"), TZ), { start: at("09:00"), end: at("12:00") });
  assert.equal(D.scheduleWindow(weekdays, at("12:00"), TZ), null, "the end is not inside");
  assert.equal(D.scheduleWindow(weekdays, at("08:59"), TZ), null);
  assert.equal(D.scheduleWindow(weekdays, at("10:00", "2026-11-08"), TZ), null, "Sunday");
  assert.equal(D.scheduleWindow({ ...weekdays, on: false }, at("10:30"), TZ), null);
  assert.deepEqual(D.scheduleWindow(nights, at("02:00", "2026-11-10"), TZ), { start: at("23:00"), end: at("07:00", "2026-11-10") });
  assert.deepEqual(D.scheduleWindow(nights, at("23:30"), TZ), { start: at("23:00"), end: at("07:00", "2026-11-10") });
  assert.equal(D.scheduleWindow({ ...nights, days: [1] }, at("02:00", "2026-11-11"), TZ), null, "started on Tuesday: not a Monday window");
});

ok("the clock turns a scheduled mode on until the window ends, once per window", () => {
  let d = D.dndApply(undefined, { op: "editMode", mode: "deep", patch: { schedule: weekdays } }, T0);
  assert.equal(D.dndAuto(d, { now: at("08:00"), tz: TZ, sleep: null }), null);
  const op = D.dndAuto(d, { now: at("09:01"), tz: TZ, sleep: null });
  assert.deepEqual(op, { op: "auto", mode: "deep", key: `sched:deep:${at("09:00")}`, by: "schedule", until: iso(at("12:00")) });
  d = D.dndApply(d, op!, at("09:01"));
  assert.equal(D.activeMode(d, at("09:01"))!.id, "deep"); assert.equal(d.by, "schedule");
  assert.equal(D.dndAuto(d, { now: at("09:30"), tz: TZ, sleep: null }), null, "already on");
  d = D.dndApply(d, { op: "off" }, at("10:00"));
  assert.equal(D.dndAuto(d, { now: at("10:01"), tz: TZ, sleep: null }), null, "turned off by hand inside the window: stays off");
  assert.equal(D.dndActive(D.dndApply(d, D.dndAuto(d, { now: at("09:05", "2026-11-10"), tz: TZ, sleep: null })!, at("09:05", "2026-11-10")), at("09:05", "2026-11-10")), true, "the next window turns it on again");
  assert.equal(D.dndActive(D.dndApply(d, op!, at("09:01")), at("12:00")), false, "ends with the window");
});

ok("a schedule never takes over Do Not Disturb turned on by hand", () => {
  let d = D.dndApply(undefined, { op: "editMode", mode: "deep", patch: { schedule: weekdays } }, T0);
  d = D.dndApply(d, { op: "on", mode: "calls" }, at("08:30"));
  assert.equal(D.dndAuto(d, { now: at("09:10"), tz: TZ, sleep: null }), null);
});

ok("Sleep mode: on with its mode when you go to sleep, off when you wake, a hand turn off is kept", () => {
  let d = D.dndApply(undefined, { op: "editMode", mode: "sleep", patch: { sleep: true } }, T0);
  const sleep = { at: iso(at("23:10")), woke: null, breaks: null };
  assert.equal(D.dndAuto(d, { now: at("23:00"), tz: TZ, sleep: null }), null, "no sleep");
  const op = D.dndAuto(d, { now: at("23:11"), tz: TZ, sleep })!;
  assert.equal(op.op, "auto");
  d = D.dndApply(d, op, at("23:11"));
  assert.equal(D.activeMode(d, at("23:11"))!.id, "sleep"); assert.equal(d.by, "sleep"); assert.equal(d.until, null);
  assert.equal(D.dndAuto(d, { now: at("23:30"), tz: TZ, sleep }), null);
  assert.deepEqual(D.dndAuto(d, { now: at("07:00", "2026-11-10"), tz: TZ, sleep: { ...sleep, woke: iso(at("07:00", "2026-11-10")) } }), { op: "off" });
  assert.deepEqual(D.dndAuto(d, { now: at("07:00", "2026-11-10"), tz: TZ, sleep: null }), { op: "off" }, "sleep logged and gone");
  const off = D.dndApply(d, { op: "off" }, at("23:40"));
  assert.equal(D.dndAuto(off, { now: at("23:45"), tz: TZ, sleep }), null, "turned off by hand while asleep: stays off");
  assert.equal(D.dndAuto(off, { now: at("01:00", "2026-11-10"), tz: TZ, sleep: { ...sleep, breaks: [{}] } })?.op, "auto", "back to sleep after a break: on again");
});

ok("Sleep mode never turns off what you turned on by hand, and without a Sleep mode mode nothing happens", () => {
  let d = D.dndApply(undefined, { op: "on", mode: "deep" }, T0);
  assert.equal(D.dndAuto(d, { now: T0, tz: TZ, sleep: null }), null);
  assert.equal(D.dndAuto(d, { now: T0, tz: TZ, sleep: { at: iso(T0 - M) } }), null);
  d = D.dndApply(undefined, { op: "editMode", mode: "sleep", patch: { sleep: true } }, T0);
  d = D.dndApply(d, { op: "on", mode: "deep" }, T0);
  assert.equal(D.dndAuto(d, { now: T0, tz: TZ, sleep: { at: iso(T0 - M) } }), null, "on by hand: left alone");
});

// ---------- what comes in from the overlay ----------
ok("cleanDndOp checks every new action; auto is never taken from outside", () => {
  assert.deepEqual(D.cleanDndOp({ op: "on", mode: "deep", until: iso(T0) }), { op: "on", mode: "deep", until: iso(T0) });
  assert.deepEqual(D.cleanDndOp({ op: "on", mode: "<b>" }), { op: "on" });
  assert.equal(D.cleanDndOp({ op: "on", until: "soon" }), null);
  assert.deepEqual(D.cleanDndOp({ op: "pick", mode: "calls" }), { op: "pick", mode: "calls" });
  assert.equal(D.cleanDndOp({ op: "pick", mode: "Calls!" }), null);
  assert.deepEqual(D.cleanDndOp({ op: "addMode", id: "m00001", name: "Gym", icon: "rocket" }), { op: "addMode", id: "m00001", name: "Gym", icon: "moon" });
  assert.deepEqual(D.cleanDndOp({ op: "editMode", mode: "deep", patch: { schedule: { on: true, days: [1, 9], from: "9:00", to: "12:00" } } }), null, "a broken time");
  assert.deepEqual(D.cleanDndOp({ op: "editMode", mode: "deep", patch: { schedule: { on: true, days: [1, 9, "2"], from: "09:00", to: "12:00" } } }),
    { op: "editMode", mode: "deep", patch: { schedule: { on: true, days: [1], from: "09:00", to: "12:00" } } });
  assert.deepEqual(D.cleanDndOp({ op: "editMode", mode: "deep", patch: { schedule: null, length: "hour", sleep: true } }),
    { op: "editMode", mode: "deep", patch: { length: "hour", sleep: true, schedule: null } });
  assert.deepEqual(D.cleanDndOp({ op: "senders", mode: "deep", list: ["A@B.test", 4] }), { op: "senders", mode: "deep", list: ["a@b.test"] });
  assert.equal(D.cleanDndOp({ op: "auto", mode: "deep", key: "k", by: "schedule", until: null }), null);
  assert.equal(D.cleanDndOp({ op: "delMode" }), null);
});

ok("a saved mode is never trusted as is", () => {
  const m = D.modesOf({ on: false, modes: [{ id: "BAD ID", name: "x" }, { id: "ok1", name: "a\u2014b", icon: "nope", pass: ["mail", "fake"], senders: ["  z@z.test "], schedule: { on: true, days: [3], from: "25:00", to: "1" } }] as never });
  assert.deepEqual(m, [{ id: "ok1", name: "a-b", icon: "moon", pass: ["mail"], senders: ["z@z.test"] }]);
  assert.equal(D.modesOf({ on: false, modes: [] }).length, 4, "an empty list: the built in ones");
  assert.match(D.newModeId(() => 0.5), /^m[a-z0-9]{6}$/);
});

ok("the new words have no dashes", () => {
  for (const m of D.defaultModes()) assert.ok(!DASH.test(m.name), m.name);
  for (const x of D.DND_KINDS) assert.ok(!DASH.test(x.label + x.hint), x.k);
  for (const f of ["../src/views/DndSettings.tsx", "../src/views/Dnd.tsx", "../src/views/FocusIcon.tsx", "../src/ui/hovercard.ts", "../src/ui/hovercard.css", "../src/core/hovercard.ts", "../src/core/hoverwords.ts", "../src/core/dnd.ts"])
    assert.ok(!DASH.test(readFileSync(new URL(f, import.meta.url), "utf8")), f);
});

ok("the moon has the cog on its top right, a long press, the mode's icon, and the settings close on Esc", () => {
  const dnd = readFileSync(new URL("../src/views/Dnd.tsx", import.meta.url), "utf8");
  const set = readFileSync(new URL("../src/views/DndSettings.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../src/views/dnd.css", import.meta.url), "utf8");
  assert.match(dnd, /className=\{`dnd-cog/);
  assert.match(dnd, /press\.current\.long = true/);
  assert.match(dnd, /mode && mode\.icon !== "moon" \? <span className="dnd-mode-now"><FocusIcon/);
  assert.match(css, /\.dnd-cog \{ position: absolute; top: -5px; right: -6px;/);
  assert.match(set, /if \(e\.key === "Escape"\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); onClose\(\); \}/);
  assert.match(readFileSync(new URL("../src/views/TaskMap.tsx", import.meta.url), "utf8"), /\.dnd-btn, \.dnd-cog, /, "kept list hit rects");
});

// ---------- the hover card ----------
const view = { w: 1440, h: 900 };
const rect = (left: number, top: number, w = 34, h = 34) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h });

ok("the card sits under the button, its arrow at the middle", () => {
  const p = H.placeCard(rect(700, 60), { w: 200, h: 50 }, view);
  assert.deepEqual(p, { x: 617, y: 102, side: "below", arrow: 100 });
});

ok("never off screen: the top right buttons pull the card in, the arrow still points at the button", () => {
  const p = H.placeCard(rect(1400, 20), { w: 220, h: 50 }, view);
  assert.equal(p.x + 220, view.w - 8);
  assert.equal(p.arrow, 1417 - p.x);
  const q = H.placeCard(rect(0, 20, 20, 20), { w: 220, h: 50 }, view);
  assert.equal(q.x, 8); assert.equal(q.arrow, 12, "clear of the rounded corner");
});

ok("no room below: above the button; no room either side: kept inside the screen", () => {
  assert.equal(H.placeCard(rect(700, 860), { w: 200, h: 50 }, view).side, "above");
  assert.equal(H.placeCard(rect(700, 860), { w: 200, h: 50 }, view).y, 860 - 8 - 50);
  const tiny = H.placeCard(rect(10, 10), { w: 300, h: 300 }, { w: 200, h: 200 });
  assert.equal(tiny.x, 8); assert.ok(tiny.y >= 8);
});

ok("a short delay so it never flickers, quicker while moving along a row", () => {
  assert.ok(H.SHOW_MS >= 300 && H.SHOW_MS <= 600);
  assert.ok(H.WARM_MS < 120 && H.WARM_FOR_MS >= 300);
});

ok("words: a button's own, the list's, or the title split in two; never a dash", () => {
  assert.deepEqual(H.cleanTip("Undo", "Undo"), { name: "Undo", line: "" });
  assert.equal(H.cleanTip("", "x"), null);
  assert.deepEqual(H.cleanTip("A \u2014 b", null), { name: "A , b", line: "" });
  assert.deepEqual(H.splitTitle("Close (Esc)"), { name: "Close", line: "Esc" });
  assert.deepEqual(H.splitTitle("Tick off: Buy milk"), { name: "Tick off", line: "Buy milk" });
  assert.deepEqual(H.splitTitle("Settings"), { name: "Settings", line: "" });
  assert.deepEqual(W.wordsFor("End your day"), { name: "End your day", line: "Unticks your daily tasks and clears finished ones" });
  assert.equal(W.wordsFor("Something else"), null);
  for (const [k, [a, b]] of Object.entries(W.HOVER_WORDS)) {
    assert.ok(!DASH.test(k + a + b), k);
    assert.ok(a.length <= 40 && b.length <= 70 && b.length > 0, `${k}: short`);
    assert.equal(k, k.toLowerCase(), "keys are lower case");
  }
});

ok("every top right button says what it is and what it does", () => {
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf8");
  assert.match(read("../src/views/Dnd.tsx"), /data-tip-line=\{on \? "Click for what it mutes, or turn it off"/);
  assert.match(read("../src/views/Dnd.tsx"), /data-tip="Do Not Disturb settings" data-tip-line="What it mutes, focus modes and schedules"/);
  assert.match(read("../src/views/Security.tsx"), /data-tip-line=\{warn \?/);
  assert.match(read("../src/views/Second.tsx"), /data-tip-line=\{v\.peer \?/);
  assert.match(read("../src/views/GSquad.tsx"), /data-tip="G Squad"/);
  assert.ok(!/className="gs-tip"/.test(read("../src/views/GSquad.tsx")), "the old G Squad tooltip is gone");
  assert.match(read("../src/main.tsx"), /if \(import\.meta\.env\.MODE !== "gos"\) startHoverCards\(\);/);
  const css = read("../src/ui/hovercard.css");
  assert.match(css, /pointer-events: none/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

console.log(`\n${n} of ${n} passed`);
