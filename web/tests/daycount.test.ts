// Run: node --experimental-strip-types tests/daycount.test.ts
// The day countdown (PS 1.70, core/daycount.ts): the prefs and their defaults, the zone, every end of day in a zone (daylight saving too),
// End day now? with Yes and 15 more mins, a zero nobody answered, the island reminders, the words and numbers, Lively near zero, the
// Priority 1 timers, and that the Settings section, the feature and the intro are all in place. No clock, no network, no vault.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as D from "../src/core/daycount.ts";
import * as R from "../src/core/resetday.ts";
import { SETTINGS, GROUPS } from "../src/core/settingsindex.ts";
import { INTROS } from "../src/core/featureintro.ts";

const tests: [string, () => void][] = [];
const ok = (name: string, fn: () => void) => tests.push([name, fn]);
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const H = 3_600_000, M = 60_000;
const T = (iso: string) => Date.parse(iso);
const TB = "Asia/Dubai";   // UTC+4 all year
const LONG_AGO = T("2026-01-01T00:00:00Z");
// "Every day at" (12:00 unless given): the 1.70 rules below. The 1.72 default, Same as reset time, has its own checks further down.
const P = (x: Partial<D.CdPrefs> = {}) => D.cleanCd({ mode: "daily", ...x });

// ---------- prefs ----------
ok("defaults: on, the day ends at the reset time (12:00 kept for Every day at), rounded bold, slide, lively, island, reminders every 3 hours, Priority 1 timers", () => {
  const p = D.cleanCd(undefined);
  assert.equal(p.on, true); assert.equal(p.mode, "reset"); assert.equal(p.at, "12:00"); assert.equal(p.tz, "");
  assert.equal(p.font, "rounded"); assert.equal(p.weight, 700); assert.equal(p.size, 100); assert.equal(p.anim, "slide");
  assert.equal(p.lively, true); assert.equal(p.island, true); assert.equal(p.remind, true); assert.equal(p.every, 3); assert.equal(p.p1, true);
  assert.deepEqual(p.days, Array(7).fill("12:00"));
});
ok("broken values take their defaults; sizes are kept in range", () => {
  const p = D.cleanCd({ on: "no", mode: "x", at: "25:00", days: [1, 2], tz: "../../etc", font: "comic", color: "red", weight: 900, size: 999, anim: "spin", every: 5 });
  assert.equal(p.on, true); assert.equal(p.mode, "reset"); assert.equal(p.at, "12:00"); assert.equal(p.tz, ""); assert.equal(p.font, "rounded");
  assert.equal(p.color, ""); assert.equal(p.weight, 700); assert.equal(p.size, D.SIZE_MAX); assert.equal(p.anim, "slide"); assert.equal(p.every, 3);
  assert.equal(D.cleanCd({ size: 1 }).size, D.SIZE_MIN);
  assert.equal(D.cleanCd({ color: "#ABCDEF" }).color, "#abcdef");
  assert.equal(D.cleanCd({ tz: "America/New_York" }).tz, "America/New_York");
  assert.deepEqual(D.cleanCd({ mode: "week", days: ["09:00", "", "x", "18:30", "12:00", "12:00", ""] }).days, ["09:00", "", "12:00", "18:30", "12:00", "12:00", ""]);
});
ok("only what differs from the defaults is saved", () => {
  assert.deepEqual(D.cdPatch(P(), { at: "17:00" }), { mode: "daily", at: "17:00" });
  assert.deepEqual(D.cdPatch(P({ at: "17:00" }), { at: "12:00" }), { mode: "daily" });
  assert.deepEqual(D.cdPatch(P(), { on: false, every: 6 }), { mode: "daily", on: false, every: 6 });
  assert.deepEqual(D.cdPatch(D.cleanCd({}), { on: false, every: 6 }), { on: false, every: 6 });
  assert.deepEqual(D.cdPatch(D.cleanCd({}), { mode: "daily" }), { mode: "daily" });
});
ok("the zone: the one picked, else Dubai on the developer's account, else the device's own", () => {
  assert.equal(D.cdZone({ tz: "" }, true, "Europe/London"), TB);
  assert.equal(D.cdZone({ tz: "" }, false, "Europe/London"), "Europe/London");
  assert.equal(D.cdZone({ tz: "Asia/Tokyo" }, true, "Europe/London"), "Asia/Tokyo");
  assert.equal(D.cdZone({ tz: "" }, false, ""), "UTC");
});

// ---------- the ends of the day ----------
ok("every day at 12:00 in the developer's city: noon there is 08:00 UTC", () => {
  const now = T("2026-11-19T07:00:00Z");   // 11:00 in the developer's city
  assert.equal(D.nextEnd(P(), TB, now), T("2026-11-19T08:00:00Z"));
  assert.equal(D.prevEnd(P(), TB, now), T("2026-11-18T08:00:00Z"));
  assert.equal(D.nextEnd(P(), TB, T("2026-11-19T08:00:00Z")), T("2026-11-20T08:00:00Z"));
});
ok("daylight saving: 12:00 in London is 11:00 UTC in summer and 12:00 UTC in winter", () => {
  const p = P();
  assert.equal(D.nextEnd(p, "Europe/London", T("2026-03-28T13:00:00Z")), T("2026-03-29T11:00:00Z"));   // the clocks go forward that night
  assert.equal(D.nextEnd(p, "Europe/London", T("2026-10-24T13:00:00Z")), T("2026-10-25T12:00:00Z"));   // and back
});
ok("a time for each day: Friday 17:00, no end on Saturday, so Saturday counts down to Sunday", () => {
  const p = P({ mode: "week", days: ["12:00", "12:00", "12:00", "12:00", "17:00", "", "10:00"] });
  // Friday 20 Nov 2026, 10:00 in the developer's city
  assert.equal(D.nextEnd(p, TB, T("2026-11-20T06:00:00Z")), T("2026-11-20T13:00:00Z"));
  // Saturday 21 Nov, 12:00 in the developer's city: next is Sunday 10:00
  assert.equal(D.nextEnd(p, TB, T("2026-11-21T08:00:00Z")), T("2026-11-22T06:00:00Z"));
});

// ---------- End day now? ----------
const END = T("2026-11-19T08:00:00Z");
ok("before the end it counts down to it", () => {
  const st = D.cdNow(P(), {}, TB, END - 2 * H, LONG_AGO);
  assert.deepEqual(st, { target: END, asking: false, endKey: null, snoozed: false });
});
ok("at zero it asks, and keeps asking until answered", () => {
  for (const after of [0, 1000, 5 * M, 3 * H]) {
    const st = D.cdNow(P(), {}, TB, END + after, LONG_AGO);
    assert.equal(st.asking, true); assert.equal(st.target, END); assert.equal(st.endKey, new Date(END).toISOString());
  }
});
ok("Yes starts the next day's countdown at once (nothing else changes)", () => {
  const key = new Date(END).toISOString();
  const ans = D.answer({}, key, "yes", END + M);
  assert.deepEqual(ans, { end: key, yes: true });
  const st = D.cdNow(P(), ans, TB, END + 2 * M, LONG_AGO);
  assert.equal(st.asking, false); assert.equal(st.target, END + 24 * H);
});
ok("15 more mins counts down 15 minutes, then asks again", () => {
  const key = new Date(END).toISOString();
  const ans = D.answer({ rem: "2026-11-19T05:00:00.000Z" }, key, "snooze", END + 2 * M);
  assert.equal(ans.snooze, new Date(END + 17 * M).toISOString());
  assert.equal(ans.rem, "2026-11-19T05:00:00.000Z");   // the reminder field is kept
  const mid = D.cdNow(P(), ans, TB, END + 10 * M, LONG_AGO);
  assert.equal(mid.snoozed, true); assert.equal(mid.asking, false); assert.equal(mid.target, END + 17 * M);
  const back = D.cdNow(P(), ans, TB, END + 17 * M, LONG_AGO);
  assert.equal(back.asking, true);
});
ok("an answer for another day does not count", () => {
  const ans = D.answer({}, new Date(END - 24 * H).toISOString(), "yes", END - 24 * H);
  assert.equal(D.cdNow(P(), ans, TB, END + M, LONG_AGO).asking, true);
});
ok("a zero nobody answered is let go after 12 hours: the next day counts down", () => {
  const st = D.cdNow(P(), {}, TB, END + 12 * H + M, LONG_AGO);
  assert.equal(st.asking, false); assert.equal(st.target, END + 24 * H);
});
ok("an end before this device first ran never asks (an update never fires an old one)", () => {
  const st = D.cdNow(P(), {}, TB, END + 5 * M, END + M);
  assert.equal(st.asking, false); assert.equal(st.target, END + 24 * H);
});
ok("switched off: nothing", () => {
  assert.deepEqual(D.cdNow(P({ on: false }), {}, TB, END + M, LONG_AGO), { target: null, asking: false, endKey: null, snoozed: false });
});
ok("answers from anything are cleaned", () => {
  assert.deepEqual(D.cleanAns({ end: "x", yes: true, snooze: 4, rem: "nope" }), {});
  assert.deepEqual(D.cleanAns({ yes: true }), {});
  assert.deepEqual(D.cleanAns({ end: "2026-11-19T08:00:00Z", yes: "true" }), { end: "2026-11-19T08:00:00.000Z" });
});

// ---------- the island reminders ----------
ok("every 3 hours counting back from the end: 09:00, 06:00 ... in the developer's city", () => {
  const p = P();
  const now = T("2026-11-19T05:10:00Z");   // 09:10 there, the 09:00 reminder is due
  const st = D.cdNow(p, {}, TB, now, LONG_AGO);
  assert.equal(D.remindDue(p, st, {}, TB, now, LONG_AGO), T("2026-11-19T05:00:00Z"));
  assert.equal(D.WORDS.remind(st.target! - now), "You have 2h 50m left");
  // Acknowledged: quiet until the next one
  const ans = D.remAck({}, T("2026-11-19T05:00:00Z"));
  assert.equal(D.remindDue(p, st, ans, TB, now, LONG_AGO), null);
  assert.equal(D.nextRemind(p, st, now), null);   // the end itself is never a reminder (it is the card)
  const early = T("2026-11-19T04:00:00Z");
  assert.equal(D.nextRemind(p, D.cdNow(p, {}, TB, early, LONG_AGO), early), T("2026-11-19T05:00:00Z"));
});
ok("no reminder right at the start of a day, none while asking or snoozed, none switched off, none from before this device ran", () => {
  const p = P();
  const justAfter = END + 30 * M;   // the day ended half an hour ago and was answered Yes
  const yes = D.answer({}, new Date(END).toISOString(), "yes", END + M);
  const st = D.cdNow(p, yes, TB, justAfter, LONG_AGO);
  assert.equal(D.remindDue(p, st, yes, TB, justAfter, LONG_AGO), null);   // the slot 24 h before the next end is this end
  const asking = D.cdNow(p, {}, TB, END + M, LONG_AGO);
  assert.equal(D.remindDue(p, asking, {}, TB, END + M, LONG_AGO), null);
  const now = T("2026-11-19T05:10:00Z");
  assert.equal(D.remindDue(P({ remind: false }), D.cdNow(p, {}, TB, now, LONG_AGO), {}, TB, now, LONG_AGO), null);
  assert.equal(D.remindDue(p, D.cdNow(p, {}, TB, now, now - M), {}, TB, now, now - M), null);
});
ok("how often is picked: every hour gives 11:00 for a noon end", () => {
  const p = P({ every: 1 });
  const now = T("2026-11-19T07:01:00Z");
  assert.equal(D.remindDue(p, D.cdNow(p, {}, TB, now, LONG_AGO), {}, TB, now, LONG_AGO), T("2026-11-19T07:00:00Z"));
});

// ---------- words, numbers, Lively ----------
ok("the clock reads like the Mac island's: 4:12:09, 12:09, 0:00", () => {
  assert.equal(D.clock(4 * H + 12 * M + 9000), "4:12:09");
  assert.equal(D.clock(12 * M + 9000), "12:09");
  assert.equal(D.clock(0), "0:00");
  assert.equal(D.clock(-5000), "0:00");
  assert.equal(D.clock(23 * H + 59 * M + 59_500), "24:00:00");
  assert.equal(D.leftWords(4 * H + 12 * M), "4h 12m"); assert.equal(D.leftWords(3 * H), "3h"); assert.equal(D.leftWords(35 * M), "35m"); assert.equal(D.leftWords(45_000), "45s");
});
ok("Lively near zero: calm, a glow from an hour, warmer from 15 minutes, a rumble in the last 3", () => {
  assert.equal(D.livelyStage(2 * H, false), 0); assert.equal(D.livelyStage(H, false), 1); assert.equal(D.livelyStage(15 * M, false), 2);
  assert.equal(D.livelyStage(3 * M, false), 3); assert.equal(D.livelyStage(5 * H, true), 3);
});
ok("the card's words", () => {
  assert.equal(D.WORDS.endAsk, "End day now?"); assert.equal(D.WORDS.yes, "Yes"); assert.equal(D.WORDS.snooze, "Give me 15 more mins");
  assert.equal(D.WORDS.ack, "Acknowledged"); assert.equal(D.WORDS.settings, "Settings");
});

// ---------- Priority 1 timers ----------
ok("a Priority 1 task's timer runs out 24 hours after it became Priority 1; none without a start, done, daily or not P1", () => {
  const now = T("2026-11-19T10:00:00Z");
  assert.equal(D.p1Deadline({ p1: true, p1At: "2026-11-19T06:00:00Z" }, now), T("2026-11-20T06:00:00Z"));
  assert.equal(D.p1Deadline({ p1: true, p1At: null }, now), null);
  assert.equal(D.p1Deadline({ p1: true, p1At: "2026-11-19T06:00:00Z", done: true }, now), null);
  assert.equal(D.p1Deadline({ p1: true, p1At: "2026-11-19T06:00:00Z", type: "daily" }, now), null);
  assert.equal(D.p1Deadline({ p1: false, p1At: "2026-11-19T06:00:00Z" }, now), null);
  assert.equal(D.p1Deadline({ p1: true, p1At: "2026-11-30T06:00:00Z" }, now), null);   // a start from the future is not believed
});

// ---------- PS 1.72: Same as reset time (Jan via the developer, 21 Nov 2026: "I think it should probably be setting both") ----------
ok("1.72: nothing picked before (no settings, or only looks) follows the reset time; a time of your own keeps Every day at", () => {
  assert.equal(D.cleanCd(undefined).mode, "reset");
  assert.equal(D.cleanCd({}).mode, "reset");
  assert.equal(D.cleanCd({ font: "mono", color: "#5eead4" }).mode, "reset");
  assert.equal(D.cleanCd({ days: Array(7).fill("09:00") }).mode, "reset");   // only "A time for each day" with mode saved counts as picked
  const own = D.cleanCd({ at: "13:00" });   // a 1.70 or 1.71 pick: only the time was saved
  assert.equal(own.mode, "daily"); assert.equal(own.at, "13:00");
  assert.equal(D.cleanCd({ mode: "week", days: Array(7).fill("18:00") }).mode, "week");
  assert.equal(D.cleanCd({ mode: "daily" }).mode, "daily");
  assert.equal(D.cleanCd({ mode: "reset", at: "13:00" }).mode, "reset");
});
ok("1.72: saved and read back, every choice stays as picked (a kept time saves its mode)", () => {
  const cases: Partial<D.CdPrefs>[] = [{ mode: "reset" }, { mode: "daily" }, { mode: "daily", at: "13:00" }, { mode: "reset", at: "13:00" }, { mode: "week", days: Array(7).fill("18:00") }];
  for (const c of cases) {
    const back = D.cleanCd(D.cdPatch(D.cleanCd({}), c));
    assert.equal(back.mode, c.mode, JSON.stringify(c));
    if (c.at) assert.equal(back.at, c.at);
  }
  // From a kept 13:00 back to the reset time: the 13:00 stays for later, and the mode is saved with it.
  assert.deepEqual(D.cdPatch(P({ at: "13:00" }), { mode: "reset" }), { mode: "reset", at: "13:00" });
});
ok("1.72: the developer's account keeps his 1.70 noon (never saved, as it was the default) until he picks another Day ends", () => {
  const red = D.cleanCd({}, true);
  assert.equal(red.mode, "daily"); assert.equal(red.at, "12:00");
  assert.equal(D.cleanCd({ font: "mono" }, true).mode, "daily");
  // He picks Same as reset time: saved as such, and read back as such on his account.
  const pick = D.cdPatch(red, { mode: "reset" });
  assert.deepEqual(pick, { mode: "reset" });
  assert.equal(D.cleanCd(pick, true).mode, "reset");
  // A look changed on his account saves his noon with it, so it stays noon everywhere.
  assert.equal(D.cleanCd(D.cdPatch(red, { font: "mono" })).mode, "daily");
});
ok("1.72: following the reset time is every day at the reset time (midnight when never set)", () => {
  const p = D.cleanCd({});
  assert.deepEqual(D.cdEffective(p, "05:00"), { ...p, mode: "daily", at: "05:00" });
  assert.equal(D.cdEffective(p, "nope").at, "00:00");
  const own = P({ at: "13:00" });
  assert.equal(D.cdEffective(own, "05:00"), own);   // a day end of your own is never moved
});
ok("1.72: the zone follows the reset's zone (Your time zone) unless one was picked; Every day at keeps the 1.70 rule", () => {
  assert.equal(D.cdZone({ tz: "", mode: "reset" }, true, "Europe/London", "Europe/Berlin"), "Europe/Berlin");
  assert.equal(D.cdZone({ tz: "", mode: "reset" }, false, "Europe/London", "Europe/London"), "Europe/London");
  assert.equal(D.cdZone({ tz: "Asia/Tokyo", mode: "reset" }, false, "Europe/London", "Europe/Berlin"), "Asia/Tokyo");
  assert.equal(D.cdZone({ tz: "", mode: "daily" }, true, "Europe/London", "Europe/Berlin"), TB);
});
const BER = "Europe/Berlin";   // UTC+1 in November
const resetAt = (hm: string, tz: string) => { const m = +hm.slice(0, 2) * 60 + +hm.slice(3); return (t: number) => R.nextResetAt(t - 1, tz, m); };
ok("1.72 Jan's case: reset at 05:00, countdown never touched, Reset automatically on: it counts to 05:00 and never sits at 0:00", () => {
  const p = D.cdEffective(D.cleanCd({}), "05:00");
  const five = T("2026-11-21T04:00:00Z");   // 05:00 in Berlin
  assert.equal(D.cdNow(p, {}, BER, five - 3 * H, LONG_AGO).target, five);
  const noon = T("2026-11-21T11:00:00Z");   // the 1.70 default is not an end any more
  assert.deepEqual(D.cdNow(p, {}, BER, noon + M, LONG_AGO, resetAt("05:00", BER)), { target: five + 24 * H, asking: false, endKey: null, snoozed: false });
  for (const after of [0, 1000, 5 * M, 6 * H]) {
    const st = D.cdNow(p, {}, BER, five + after, LONG_AGO, resetAt("05:00", BER));
    assert.equal(st.asking, false); assert.equal(st.target, five + 24 * H);
  }
  // Reset automatically off: the day end still asks End day now? at 05:00, as in 1.70.
  assert.equal(D.cdNow(p, {}, BER, five + M, LONG_AGO).asking, true);
});
ok("1.72 Jan's refined case: countdown at midnight, reset at 05:00: asks at midnight, an unanswered zero lets go at the 05:00 Reset", () => {
  const p = P({ at: "00:00" });
  const mid = T("2026-11-20T23:00:00Z");   // 00:00 on 21 Nov in Berlin
  const five = mid + 5 * H;
  assert.equal(D.cdNow(p, {}, BER, mid - H, LONG_AGO, resetAt("05:00", BER)).target, mid);
  const ask = D.cdNow(p, {}, BER, mid + 2 * H, LONG_AGO, resetAt("05:00", BER));
  assert.equal(ask.asking, true);
  const gone = D.cdNow(p, {}, BER, five + M, LONG_AGO, resetAt("05:00", BER));
  assert.equal(gone.asking, false); assert.equal(gone.target, mid + 24 * H);
  // Without Reset automatically: the 1.70 rule, half way to the next end (12 hours).
  assert.equal(D.cdNow(p, {}, BER, five + M, LONG_AGO).asking, true);
});
ok("1.72: one reset time moves a countdown that follows it", () => {
  const p = D.cleanCd({});
  const now = T("2026-11-21T00:30:00Z");   // 04:30 in the developer's city
  assert.equal(D.cdNow(D.cdEffective(p, "05:00"), {}, TB, now, LONG_AGO, resetAt("05:00", TB)).target, T("2026-11-21T01:00:00Z"));
  assert.equal(D.cdNow(D.cdEffective(p, "04:00"), {}, TB, now, LONG_AGO, resetAt("04:00", TB)).target, T("2026-11-22T00:00:00Z"));
  assert.equal(D.cdNow(D.cdEffective(p, "00:00"), {}, TB, now, LONG_AGO, resetAt("00:00", TB)).target, T("2026-11-21T20:00:00Z"));
});
ok("1.72: both times side by side under Reset automatically, linked both ways, with existing words only (one new choice)", () => {
  assert.equal(D.WORDS.sameAsReset("05:00"), "Same as reset time (05:00)");
  const ar = read("src/views/AutoReset.tsx");
  assert.match(ar, />Day ends</); assert.match(ar, /aria-label="Day ends"/);
  assert.match(ar, /onClick=\{\(\) => pickCd\(RESET_AT_DEFAULT\)\}>Midnight</);
  assert.match(ar, /onClick=\{onCountdown\}>Countdown text</);
  assert.match(ar, /setCd\(\{ mode: "daily", at: x \}\)/);
  assert.match(read("src/views/SettingsGroups.tsx"), /onCountdown=\{\(\) => openSettings\("countdown", \{ jump: "cd-mode" \}\)\}/);
  const cds = read("src/views/CountdownSettings.tsx");
  assert.match(cds, /WORDS\.sameAsReset\(resetAt\)/);
  assert.equal(cds.split('openSettings("time", { jump: "auto-reset" }); }}>Reset automatically at</button>').length, 3);
  const eng = read("src/daycount.ts");
  assert.match(eng, /cdEffective\(saved, resetAtOf\(st0\)\)/);
  assert.match(eng, /st0\.autoReset === "midnight" && !st0\.rules\?\.length \? \(t: number\) => nextResetAt\(t - 1, rTz, rMin\)/);
});

// ---------- where it lives ----------
ok("Settings, Countdown text: the group, its twelve rows, each with a control", () => {
  assert.ok(GROUPS.some((g) => g.id === "countdown" && g.label === "Countdown text"));
  const rows = SETTINGS.filter((e) => e.group === "countdown").map((e) => e.id);
  assert.deepEqual(rows, ["cd-on", "cd-mode", "cd-tz", "cd-font", "cd-color", "cd-weight", "cd-size", "cd-anim", "cd-lively", "cd-island", "cd-remind", "cd-p1"]);
  const groups = read("src/views/SettingsGroups.tsx");
  for (const id of rows) assert.ok(groups.includes(`"${id}": (p) => <CdSetting {...p} k="${id.slice(3)}" />`), id);
});
ok("the feature: core, shared, since 1.70, on by default, web, Mac and phone", () => {
  const f = JSON.parse(read("core-root/features.json")).features.find((x: { id: string }) => x.id === D.CD_FEATURE);
  assert.ok(f); assert.equal(f.owner, "core"); assert.equal(f.scope, "shared"); assert.equal(f.since, "1.70"); assert.equal(f.default, "on");
  assert.deepEqual(f.parts, ["web", "mac", "phone"]);
});
ok("the intro: one Ok, never reused", () => {
  const i = INTROS.find((x) => x.id === "day-countdown-170");
  assert.ok(i); assert.equal(i!.show, "Ok"); assert.equal(i!.choice, true);
});
ok("a right click on a timer wins over the task's own menu", () => {
  const v = read("src/views/DayCountdown.tsx");
  assert.match(v, /export function openCdMenu[\s\S]*?e\.preventDefault\(\);\s*e\.stopPropagation\(\);/);
  assert.match(read("src/views/TaskMap.tsx"), /<P1Timer t=\{t\} \/>/);
});
ok("Yes never touches the task list", () => {
  const eng = read("src/daycount.ts");
  for (const bad of ["resetTodos", "toggleTodo", "updateTodo", "addTodo", "deleteTodo"]) assert.ok(!eng.includes(bad), bad);
});
ok("no em or en dashes in the new files", () => {
  for (const p of ["src/core/daycount.ts", "src/daycount.ts", "src/views/DayCountdown.tsx", "src/views/CountdownSettings.tsx", "src/views/daycount.css", "src/views/AutoReset.tsx"]) {
    assert.ok(!/[\u2013\u2014]/.test(read(p)), p);
  }
});

let pass = 0;
for (const [name, fn] of tests) {
  try { fn(); pass++; } catch (e) { console.error(`FAIL ${name}\n`, e); }
}
console.log(`${pass} of ${tests.length} checks passed`);
if (pass !== tests.length) process.exit(1);
