// Run: node --experimental-strip-types tests/gym.test.ts
// The gym reminder timing (src/core/gym.ts): 2 h, 1 h, 30 min and 10 min cards, the ring at minus 16,
// stale reminders after sleep, acknowledging, days and time changes. V1.57: nag mode, the ring time, a gym
// across midnight, Yes stopping everything, old settings with the defaults. FICTIONAL days only.
import assert from "node:assert/strict";
const G = await import("../src/core/gym.ts");

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const TZ = "Asia/Dubai";                       // UTC+4, no daylight saving
const at = (hm: string, day = "2026-11-03") => Date.parse(`${day}T${hm}:00+04:00`);
const P = G.gymPrefs(undefined);

const OLD = { end: "", nag: false, nagStart: "10:00", nagEvery: 15, ringAt: "" };
ok("defaults: on, every day, 08:00, nag mode off, no end or ring time of its own", () => {
  assert.deepEqual(P, { on: true, time: "08:00", days: [0, 1, 2, 3, 4, 5, 6], ...OLD });
});
ok("broken prefs fall back field by field", () => {
  assert.deepEqual(G.gymPrefs({ on: false, time: "25:00", days: [1, 1, 9, "x", 3] }), { on: false, time: "08:00", days: [1, 3], ...OLD });
  assert.deepEqual(G.gymPrefs({ nag: "yes", nagStart: "9:00", nagEvery: 1000, ringAt: "x", end: "08:00" }), { ...P, nagEvery: 120 });
  assert.equal(G.gymPrefs({ nagEvery: 1 }).nagEvery, 5);
});
ok("the day's steps: 06:00, 07:00, 07:30, 07:44 ring, 07:50", () => {
  const s = G.gymSteps(P, at("05:00"), TZ).filter((x) => x.day === "2026-11-03");
  assert.deepEqual(s.map((x) => [new Date(x.due).toISOString().slice(11, 16), x.ring]), [
    ["02:00", false], ["03:00", false], ["03:30", false], ["03:44", true], ["03:50", false]]);   // UTC: 06:00, 07:00, 07:30, 07:44, 07:50 Dubai
});
ok("each card is due at its time and only once", () => {
  for (const [hm, mins] of [["06:00", 120], ["07:00", 60], ["07:30", 30], ["07:50", 10]] as const) {
    const d = G.gymDue(P, at(hm) + 20_000, TZ, [], []);
    assert.equal(d?.mins, mins, hm);
    assert.equal(G.gymDue(P, at(hm) + 20_000, TZ, [], [d!.id]), null, hm + " twice");
  }
});
ok("the ring is never a Mac card", () => {
  assert.equal(G.gymDue(P, at("07:44") + 10_000, TZ, [], ["2026-11-03:120", "2026-11-03:60", "2026-11-03:30"]), null);
  assert.ok(G.gymSteps(P, at("05:00"), TZ).filter((x) => x.ring).every((x) => x.id.endsWith(":r")));
});
ok("nothing is due between steps", () => {
  assert.equal(G.gymDue(P, at("06:30"), TZ, [], []), null);
});
ok("slept through 06:00 and 07:00: waking at 07:10 fires nothing stale", () => {
  assert.equal(G.gymDue(P, at("07:10"), TZ, [], []), null);
  assert.equal(G.gymCard(P, at("07:10"), TZ, [], []), null);   // never shown, so no card either
});
ok("a step 1 minute late still fires, 3 minutes late is skipped", () => {
  assert.equal(G.gymDue(P, at("07:01"), TZ, [], [])?.mins, 60);
  assert.equal(G.gymDue(P, at("07:03"), TZ, [], []), null);
});
ok("woke at 07:30:30: only the 30 minute card, not the two before", () => {
  const d = G.gymDue(P, at("07:30") + 30_000, TZ, [], []);
  assert.equal(d?.mins, 30);
});
ok("the card follows the newest reminder shown and survives a restart (fired list)", () => {
  const fired = ["2026-11-03:120", "2026-11-03:60"];
  assert.equal(G.gymCard(P, at("07:20"), TZ, [], fired)?.mins, 60);
  const t = G.gymCardText(G.gymCard(P, at("07:20"), TZ, [], fired)!, at("07:20"), TZ, P.time);
  assert.deepEqual(t, { title: "Gym in 40 min", sub: "08:00 today" });
});
ok("card words at each step", () => {
  const c = (mins: number) => G.gymCardText({ at: at("08:00"), mins }, at("08:00") - mins * 60_000, TZ, "08:00").title;
  assert.deepEqual([c(120), c(60), c(30), c(10)], ["Gym in 2 h", "Gym in 1 h", "Gym in 30 min", "Gym in 10 min"]);
  assert.equal(G.gymCardText({ at: at("08:00"), mins: 10 }, at("08:05"), TZ, "08:00").title, "Gym time");
});
ok("the card leaves by itself 90 minutes after gym time", () => {
  const fired = ["2026-11-03:10"];
  assert.ok(G.gymCard(P, at("09:29"), TZ, [], fired));
  assert.equal(G.gymCard(P, at("09:31"), TZ, [], fired), null);
});
ok("acknowledged: the card goes and the day's later reminders stay quiet", () => {
  const acked = G.ackGym([], "2026-11-03", at("07:00"), TZ);
  assert.equal(G.gymCard(P, at("07:20"), TZ, acked, ["2026-11-03:60"]), null);
  assert.equal(G.gymDue(P, at("07:30") + 5000, TZ, acked, []), null);
  assert.ok(!G.gymSteps(P, at("07:20"), TZ, acked).some((s) => s.day === "2026-11-03"));
  assert.equal(G.gymSteps(P, at("07:20"), TZ, acked)[0].day, "2026-11-04");   // tomorrow still rings
});
ok("old acknowledged days are dropped", () => {
  const l = G.ackGym(["2026-10-01", "2026-11-01", "bad"], "2026-11-03", at("07:00"), TZ);
  assert.deepEqual(l, ["2026-11-01", "2026-11-03"]);
});
ok("off: nothing at all", () => {
  const off = { ...P, on: false };
  assert.equal(G.gymSteps(off, at("05:00"), TZ).length, 0);
  assert.equal(G.gymPlan(off, at("05:00"), TZ, []).items.length, 0);
});
ok("only the chosen days (Mon, Wed, Fri)", () => {
  const p = { ...P, days: [1, 3, 5] };
  const days = G.gymTimes(p, at("09:40", "2026-11-02"), TZ, 7).map((g) => g.day);   // Mon 2 Nov after the card left
  assert.deepEqual(days, ["2026-11-04", "2026-11-06", "2026-11-09"]);
});
ok("another time: 18:30 rings at 18:14", () => {
  const p = { ...P, time: "18:30" };
  const ring = G.gymSteps(p, at("12:00"), TZ).find((s) => s.ring)!;
  assert.equal(ring.due, at("18:14"));
});
ok("next wake: the next step, then the card leaving", () => {
  assert.equal(G.gymNextWake(P, at("06:10"), TZ, [], ["2026-11-03:120"]), at("07:00"));
  assert.equal(G.gymNextWake(P, at("07:55"), TZ, [], ["2026-11-03:10"]), at("09:30"));
});
ok("daylight saving: 08:00 London stays 08:00 on the change day", () => {
  const L = "Europe/London";
  const t = G.gymTimes(P, Date.parse("2026-10-25T00:30:00Z"), L, 1).find((g) => g.day === "2026-10-25")!;
  assert.equal(new Date(t.at).toISOString(), "2026-10-25T08:00:00.000Z");   // GMT again after 01:00 UTC
  const s = G.gymTimes(P, Date.parse("2026-10-24T00:30:00Z"), L, 0).find((g) => g.day === "2026-10-24")!;
  assert.equal(new Date(s.at).toISOString(), "2026-10-24T07:00:00.000Z");   // BST the day before
});
ok("the phone plan: times only, acknowledged days left out", () => {
  const plan = G.gymPlan(P, at("07:00"), TZ, ["2026-11-03"]);
  assert.equal(plan.items[0].day, "2026-11-04");
  assert.equal(plan.ring, 16);
  assert.deepEqual(plan.before, [120, 60, 30, 10]);
  assert.ok(plan.items.length >= 7);
  assert.ok(!JSON.stringify(plan).includes("Gym"));
});
// The developer's choices (2 Nov 2026). The phone ring's 10 minutes and its Later are in ps-gos GymClockTest.
const D = await import("../src/core/dnd.ts");
ok("Mac Later: the card is put away 5 minutes, then back (the next look is armed for it)", () => {
  const s = G.gymLater("2026-11-03", at("07:31"));
  assert.equal(s.until, at("07:36"));
  assert.equal(G.gymSnoozed(s, "2026-11-03", at("07:35")), true);
  assert.equal(G.gymSnoozed(s, "2026-11-03", at("07:36")), false);
  assert.equal(G.gymSnoozed(s, "2026-11-04", at("07:35")), false);   // another day's card is not put away
  assert.equal(G.gymNextWake(P, at("07:31"), TZ, [], ["2026-11-03:30"], s), at("07:36"));
  assert.equal(G.gymNextWake(P, at("07:37"), TZ, [], ["2026-11-03:30"], s), at("07:50"));
});
ok("PS Do Not Disturb: the Mac card stays quiet, the ring never does (it is an alarm)", () => {
  const all = D.dndApply(undefined, { op: "on" }, at("07:00"));          // everything muted
  assert.equal(G.gymQuiet("card", all, at("07:30")), true);
  assert.equal(G.gymQuiet("ring", all, at("07:44")), false);
  assert.equal(G.gymQuiet("card", { on: false }, at("07:30")), false);
  const letMeetings = D.dndApply(all, { op: "pass", kind: "meetings", pass: true }, at("07:01"));
  assert.equal(G.gymQuiet("card", letMeetings, at("07:30")), false);
  // The phone's plan has no DND in it at all, so the shell rings whatever DND says.
  assert.equal(G.gymPlan.length, 4);
  assert.ok(!/dnd/i.test(JSON.stringify(G.gymPlan(P, at("07:00"), TZ, []))));
});
ok("fired ids older than yesterday are pruned", () => {
  assert.deepEqual(G.pruneFired(["2026-11-01:60", "2026-11-02:10", "2026-11-03:120"], at("07:00"), TZ), ["2026-11-02:10", "2026-11-03:120"]);
});


// ---------- V1.57: nag mode, the ring time, a gym across midnight (the developer, 13 Nov 2026) ----------
const NIGHT = G.gymPrefs({ on: true, time: "23:00", end: "01:00", days: [0, 1, 2, 3, 4, 5, 6], nag: true, nagStart: "10:00", nagEvery: 15, ringAt: "22:55" });
const day3 = (s: { day: string }) => s.day === "2026-11-03";
ok("old settings (on, time, days only) load with the defaults and work exactly as before", () => {
  const old = G.gymPrefs({ on: true, time: "08:00", days: [2, 4] });
  assert.deepEqual(old, { on: true, time: "08:00", days: [2, 4], ...OLD });
  assert.equal(G.gymEnd(old), "09:30");
  assert.equal(G.gymRingAt(old), "07:44");
  const s = G.gymSteps(old, at("05:00"), TZ).filter(day3);
  assert.deepEqual(s.map((x) => [x.mins, x.ring]), [[120, false], [60, false], [30, false], [16, true], [10, false]]);
  // The phone plan still has what a pre V1.57 phone needs.
  const plan = G.gymPlan(old, at("05:00"), TZ, []);
  assert.deepEqual([plan.before, plan.ring], [[120, 60, 30, 10], 16]);
  assert.equal(plan.items[0].ring, at("07:44"));
  assert.equal(plan.items[0].every, 0);
});
ok("nag steps: every 15 minutes from 10:00 until the gym ends, no 2 h / 1 h / 30 / 10 steps", () => {
  const s = G.gymSteps(NIGHT, at("09:00"), TZ).filter((x) => day3(x) && !x.ring);
  assert.equal(s[0].due, at("10:00"));
  assert.equal(s[1].due, at("10:15"));
  assert.equal(s[s.length - 1].due, at("00:45", "2026-11-04"));   // the last one before 01:00
  assert.equal(s.length, 60);                                      // 10:00 to 00:45 every 15 min
  assert.ok(s.every((x) => x.nag && x.id.startsWith("2026-11-03:n")));
  assert.equal(G.gymDue(NIGHT, at("10:00") + 5000, TZ, [], [])?.id, "2026-11-03:n0");
  assert.equal(G.gymDue(NIGHT, at("10:15") + 5000, TZ, [], ["2026-11-03:n0"])?.id, "2026-11-03:n1");
  assert.equal(G.gymDue(NIGHT, at("09:59"), TZ, [], []), null);
  // Another interval: every 30 min from 12:00.
  const p30 = { ...NIGHT, nagStart: "12:00", nagEvery: 30 };
  const t = G.gymSteps(p30, at("09:00"), TZ).filter((x) => day3(x) && !x.ring).map((x) => x.due);
  assert.deepEqual(t.slice(0, 3), [at("12:00"), at("12:30"), at("13:00")]);
});
ok("a Mac that slept through nag steps shows one when it wakes, not a pile", () => {
  const d = G.gymDue(NIGHT, at("13:07"), TZ, [], ["2026-11-03:n0"]);
  assert.equal(d?.id, "2026-11-03:n12");                          // the 13:00 one, once
  assert.equal(G.gymDue(NIGHT, at("13:08"), TZ, [], ["2026-11-03:n0", d!.id]), null);
  const card = G.gymCard(NIGHT, at("13:08"), TZ, [], ["2026-11-03:n0", d!.id]);
  assert.equal(card?.day, "2026-11-03");
  assert.equal(G.gymNextWake(NIGHT, at("13:08"), TZ, [], ["2026-11-03:n0", d!.id]), at("13:15"));
});
ok("the ring time: exactly 22:55, not gym time minus 16", () => {
  const ring = G.gymSteps(NIGHT, at("09:00"), TZ).find((x) => day3(x) && x.ring)!;
  assert.equal(ring.due, at("22:55"));
  assert.equal(G.gymPlan(NIGHT, at("09:00"), TZ, []).items.find(day3)!.ring, at("22:55"));
  // With nag mode off too.
  const p = { ...NIGHT, nag: false };
  assert.equal(G.gymSteps(p, at("09:00"), TZ).find((x) => day3(x) && x.ring)!.due, at("22:55"));
  // A ring time after midnight rings after midnight, still for that day.
  const late = G.gymSteps({ ...NIGHT, ringAt: "00:20" }, at("09:00"), TZ).find((x) => day3(x) && x.ring)!;
  assert.equal(late.due, at("00:20", "2026-11-04"));
  assert.equal(late.day, "2026-11-03");
});
ok("the ring only without a Yes that day", () => {
  assert.ok(G.gymPlan(NIGHT, at("15:00"), TZ, []).items.some(day3));
  const acked = G.ackGym([], "2026-11-03", at("15:00"), TZ);
  const plan = G.gymPlan(NIGHT, at("15:00"), TZ, acked);
  assert.ok(!plan.items.some(day3), "the phone gets no ring for that day");
  assert.ok(!G.gymSteps(NIGHT, at("15:00"), TZ, acked).some((x) => day3(x) && x.ring));
  assert.ok(plan.acked.includes("2026-11-03"));
});
ok("Yes stops everything for that day: the card, every later nag step, the ring; the next day still nags", () => {
  const fired = ["2026-11-03:n20"];
  const acked = G.ackGym([], "2026-11-03", at("15:05"), TZ);
  assert.equal(G.gymCard(NIGHT, at("15:06"), TZ, acked, fired), null);
  assert.equal(G.gymDue(NIGHT, at("15:15") + 5000, TZ, acked, fired), null);
  assert.ok(!G.gymSteps(NIGHT, at("15:06"), TZ, acked).some(day3));
  assert.equal(G.gymSteps(NIGHT, at("15:06"), TZ, acked)[0].due, at("10:00", "2026-11-04"));
  assert.equal(G.gymNextWake(NIGHT, at("15:06"), TZ, acked, fired), at("10:00", "2026-11-04"));
});
ok("a gym across midnight: the day is the day the nagging started, not the day it ends", () => {
  // 00:30 on 4 Nov, still in the 23:00 to 01:00 gym of 3 Nov.
  const t = G.gymToday(NIGHT, at("00:30", "2026-11-04"), TZ)!;
  assert.equal(t.day, "2026-11-03");
  assert.deepEqual([t.at, t.end, t.ring, t.from], [at("23:00"), at("01:00", "2026-11-04"), at("22:55"), at("10:00")]);
  const d = G.gymDue(NIGHT, at("00:30", "2026-11-04") + 1000, TZ, [], []);
  assert.equal(d?.day, "2026-11-03");
  // A Yes saved for 3 Nov at 00:30 on 4 Nov stops 3 Nov's, and 4 Nov's day still runs from 10:00.
  const acked = G.ackGym([], t.day, at("00:30", "2026-11-04"), TZ);
  assert.equal(G.gymDue(NIGHT, at("00:45", "2026-11-04") + 1000, TZ, acked, []), null);
  assert.equal(G.gymSteps(NIGHT, at("00:31", "2026-11-04"), TZ, acked)[0].id, "2026-11-04:n0");
  // The card leaves at 01:00, not 90 minutes after 23:00.
  assert.ok(G.gymCard(NIGHT, at("00:59", "2026-11-04"), TZ, [], ["2026-11-03:n59"]));
  assert.equal(G.gymCard(NIGHT, at("01:01", "2026-11-04"), TZ, [], ["2026-11-03:n59"]), null);
  // Only on the days picked, judged by the day the nagging starts: Tuesday 3 Nov only.
  const tue = { ...NIGHT, days: [2] };
  assert.deepEqual(G.gymTimes(tue, at("09:00"), TZ, 7).map((g) => g.day), ["2026-11-03", "2026-11-10"]);
  assert.equal(G.gymToday(tue, at("00:30", "2026-11-04"), TZ)?.day, "2026-11-03");
});
ok("nag mode with a gym time earlier than the nag start: the gym is after midnight", () => {
  const p = { ...NIGHT, time: "00:30", end: "02:00", ringAt: "" };
  const g = G.gymTimes(p, at("09:00"), TZ, 0).find(day3)!;
  assert.deepEqual([g.from, g.at, g.end, g.ring], [at("10:00"), at("00:30", "2026-11-04"), at("02:00", "2026-11-04"), at("00:14", "2026-11-04")]);
  assert.deepEqual(G.gymCardText({ at: g.at, mins: 0 }, at("23:00"), TZ, p.time, G.gymEnd(p)), { title: "Gym in 1 h 30 min", sub: "00:30 to 02:00 tomorrow" });
});
ok("the phone plan carries each day's nag start, interval, end and ring", () => {
  const plan = G.gymPlan(NIGHT, at("09:00"), TZ, []);
  const i = plan.items.find(day3)!;
  assert.deepEqual(i, { day: "2026-11-03", at: at("23:00"), end: at("01:00", "2026-11-04"), ring: at("22:55"), from: at("10:00"), every: 15 * 60_000 });
  assert.equal(plan.nag, true);
  assert.equal(plan.ringAt, "22:55");
  assert.ok(!JSON.stringify(plan).includes("Gym"));
});
ok("the API: reads every field, changes only what it is sent, never a Yes", () => {
  const a = G.apiGym(NIGHT, [], at("12:00"), TZ);
  assert.deepEqual(a, { on: true, time: "23:00", endTime: "01:00", days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"], nag: true, nagStart: "10:00", nagEvery: 15, ringTime: "22:55", saidYesToday: false });
  assert.equal(G.apiGym(NIGHT, ["2026-11-03"], at("12:00"), TZ).saidYesToday, true);
  const r = G.apiGymPatch(NIGHT, { nagEvery: 20 });
  assert.ok("prefs" in r && r.prefs.nagEvery === 20 && r.prefs.time === "23:00");
  assert.ok(!(G.API_GYM_FIELDS as readonly string[]).some((f) => G.API_GYM_YES.includes(f)));
});
ok("the Mac card and Fitness say Yes, I'm going", () => {
  assert.equal(G.YES_WORDS, "Yes, I'm going");
});

// ---------- 1.60: the phone only follows the SAVED gym settings ----------
ok("no gym plan before the saved settings have loaded (the 08:00 default must never reach the phone)", () => {
  assert.equal(G.gymReady({ hasSettings: false, syncing: true, lastSync: null }), false);    // just unlocked, first sync running
  assert.equal(G.gymReady({ hasSettings: false, syncing: false, lastSync: null }), false);   // nothing here yet, no sync finished
  assert.equal(G.gymReady({ hasSettings: false, syncing: true, lastSync: "2026-11-10T10:00:00Z" }), false);
  assert.equal(G.gymReady({ hasSettings: true, syncing: true, lastSync: null }), true);      // the saved (cached) settings are here
  assert.equal(G.gymReady({ hasSettings: false, syncing: false, lastSync: "2026-11-10T10:00:00Z" }), true);   // synced: nothing was ever saved
});
ok("a gym saved for the night gives a plan with night times only, the default only when nothing is saved", () => {
  const tz = "Asia/Dubai", now = Date.parse("2026-11-10T01:00:00+04:00");
  const night = G.gymPlan(G.gymPrefs({ on: true, time: "23:00", end: "01:00", ringAt: "22:55" }), now, tz, []);
  assert.ok(night.items.length > 0);
  assert.ok(night.items.every((i) => new Date(i.ring + 4 * 3_600_000).getUTCHours() === 22), "every ring is at 22:55 Dubai, none in the morning");
  assert.equal(night.time, "23:00");
  assert.equal(G.gymPlan(G.gymPrefs(undefined, true), now, tz, []).time, "08:00", "an unsaved gym is the default, which is why it must not be handed over before the settings load");
});

ok("PS 1.68 Fitness loads faster: a pull opens its sealed rows at once and a pull asked for during a pull runs right after", async () => {
  const { readFileSync } = await import("node:fs");
  const g = readFileSync(new URL("../src/squad/gym.ts", import.meta.url), "utf8");
  const pull = g.slice(g.indexOf("async function pull()"), g.indexOf("function keepPulling"));
  for (const what of ["cardsOpen", "rowsOpen", "postsOpen", "exOpen"]) assert.match(pull, new RegExp(`const ${what} = await Promise\\.all\\(`), what);
  assert.doesNotMatch(pull, /for \(const [a-z]+ of p\.(rows|posts|ex|members)\) \{[^}]*await /, "no open one after another");
  assert.match(pull, /if \(pulling\) \{ pullAgain = true; return; \}/);
  assert.match(pull, /finally \{ pulling = false; if \(pullAgain\) \{ pullAgain = false; void pull\(\); \} \}/);
});

console.log(`\n${n} gym tests passed`);
