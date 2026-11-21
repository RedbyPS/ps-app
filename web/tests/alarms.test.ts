// Run: node --experimental-strip-types tests/alarms.test.ts
// V1.57 alarms at any time (src/core/remind.ts, the developer 13 Nov 2026: "PS can ring the phone like an alarm at any time I pick,
// like today's 07:44 gym ring"): the record, the rings the phone gets (times, days, zones, a Yes on either device),
// the Mac's card window, the limits, and that the page, the phone and the Mac each take their part. FICTIONAL times only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const R = await import("../src/core/remind.ts");

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const TZ = "Asia/Dubai";   // UTC+4, no daylight saving
const at = (hm: string, day = "2026-11-03") => Date.parse(`${day}T${hm}:00+04:00`);   // Tue 3 Nov 2026
const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function recWith(...alarms: Partial<import("../src/core/remind.ts").Reminder>[]) {
  let rec = R.emptyRemind();
  alarms.forEach((a, i) => {
    const id = `al${i}`;
    rec = R.addAlarm(rec, id, 1000);
    rec = R.patchReminder(rec, id, a, 2000 + i);
  });
  return rec;
}

ok("a new alarm: 07:00 every day, this device's zone, Acknowledge and Later, one click, amber, the alarm tone on the Mac", () => {
  const a = R.newAlarm("abc", 5);
  assert.equal(a.alarm, true);
  assert.deepEqual([a.at, a.until, a.days, a.tz, a.click, a.snooze, a.later, a.sound], ["07:00", "07:10", [0, 1, 2, 3, 4, 5, 6], "", true, 5, "Later", "alarm"]);
  assert.equal(R.yesOf(a), "Acknowledge");
  assert.equal(R.pillOf(a), "Alarm");
  assert.equal(R.alarmText(a), "Alarm at 07:00");
});
ok("cleaning keeps an alarm an alarm: 10 minute window, Later 5 minutes, one click, whatever was sent", () => {
  const a = R.cleanReminder({ id: "x1", alarm: true, at: "23:55", until: "02:00", snooze: 60, later: "Nope", click: false, label: "GYM", text: "Go now" })!;
  assert.deepEqual([a.at, a.until, a.snooze, a.later, a.click, a.label, a.text], ["23:55", "00:05", 5, "Later", true, "GYM", "Go now"]);
  // A reminder on a task can never be an alarm; an old reminder without the flag stays a reminder.
  assert.equal(R.cleanReminder({ id: "x2", alarm: true, task: "t-1" })!.alarm, undefined);
  assert.equal(R.cleanReminder({ id: "x3", at: "09:00", until: "21:00" })!.alarm, undefined);
});
ok("alarms are kept apart from the list's reminders, and count with them towards the 20", () => {
  let rec = R.addReminder(R.remindOrDefault(null, false), "rm1", 0);
  rec = R.addAlarm(rec, "al1", 1);
  rec = R.addReminder(rec, "rm2", 2);
  assert.deepEqual(R.plainOf(rec).map((r) => r.id), ["rm1", "rm2"]);
  assert.deepEqual(R.alarmsOf(rec).map((r) => r.id), ["al1"]);
  for (let i = 0; i < 30; i++) rec = R.addAlarm(rec, `z${i}`, 10 + i);
  assert.equal(rec.list.filter((r) => !r.task).length, R.REM_MAX);
  assert.equal(R.addReminder(rec, "late1", 99), rec);
  assert.equal(R.cleanRemind(rec).list.length, R.REM_MAX);
  // Move up and down only past other alarms.
  const two = recWith({ at: "06:00" }, { at: "07:00" });
  const moved = R.moveReminder(R.addReminder(two, "rm9", 5), "al1", -1, 6);
  assert.deepEqual(R.alarmsOf(moved).map((r) => r.id), ["al1", "al0"]);
});
ok("the rings the phone gets: each day's time in the alarm's zone, soonest first, nothing switched off", () => {
  const rec = recWith({ at: "07:44" }, { at: "13:00", days: [1, 3, 5] }, { at: "09:00", on: false });
  const rings = R.alarmRings(rec, at("06:00"), TZ);
  assert.equal(rings[0].at, at("07:44"));
  assert.equal(rings[0].day, "2026-11-03");
  assert.ok(!rings.some((x) => x.id === "al2"), "off: never rings");
  const wed = rings.filter((x) => x.id === "al1").map((x) => x.day);
  assert.deepEqual(wed.slice(0, 3), ["2026-11-04", "2026-11-06", "2026-11-09"]);   // Mon, Wed, Fri only
  for (let i = 1; i < rings.length; i++) assert.ok(rings[i].at >= rings[i - 1].at);
  assert.ok(rings.length <= R.ALARM_RINGS_MAX);
});
ok("a ring carries its own screen: title, words, stop button, Later, colours and readable ink", () => {
  const rec = recWith({ at: "07:44", label: "GYM", text: "Get up and go", yes: "I'm up", bg: "#f6f3ee", accent: "#e0457b" });
  const r = R.alarmRings(rec, at("06:00"), TZ)[0];
  assert.deepEqual([r.title, r.text, r.yes, r.later, r.bg, r.accent], ["GYM", "Get up and go", "I'm up", "Later", "#f6f3ee", "#e0457b"]);
  assert.equal(r.ink, "#17121a");   // a light background gets dark words
});
ok("a time zone of its own: 07:00 London is 11:00 in the developer's city", () => {
  const rec = recWith({ at: "07:00", tz: "Europe/London" });
  assert.equal(R.alarmRings(rec, at("06:00"), TZ)[0].at, Date.parse("2026-11-03T07:00:00Z"));
});
ok("after midnight: 00:30 rings on its own day", () => {
  const rec = recWith({ at: "00:30" });
  const r = R.alarmRings(rec, at("23:00"), TZ).find((x) => x.at > at("23:00"))!;
  assert.deepEqual([r.day, r.at], ["2026-11-04", at("00:30", "2026-11-04")]);
});
ok("Acknowledge on the phone (a remAct done for that day) stops it on both: no ring, the Mac card done; tomorrow still rings", () => {
  let rec = recWith({ at: "07:44" });
  const a = rec.list[0];
  assert.equal(R.remStatus(a, rec.state[a.id], at("07:46"), TZ), "show");
  rec = R.applyAct(rec, { id: a.id, act: "done", day: "2026-11-03", at: at("07:46"), by: "phone" })!;
  assert.equal(R.remStatus(a, rec.state[a.id], at("07:47"), TZ), "done");
  const rings = R.alarmRings(rec, at("07:47"), TZ);
  assert.ok(!rings.some((x) => x.day === "2026-11-03"), "the phone stops ringing (the ring is no longer in its plan)");
  assert.equal(rings[0].day, "2026-11-04");
});
ok("Acknowledge on the Mac card (doneAct at that moment) is the same day", () => {
  const rec = recWith({ at: "07:44" });
  const act = R.doneAct(rec.list[0], at("07:50"), TZ, "mac");
  assert.equal(act.day, "2026-11-03");
});
ok("the Mac card's window is 10 minutes from the ring time; later it does not open by itself", () => {
  const rec = recWith({ at: "07:44" });
  const a = rec.list[0];
  assert.equal(R.remStatus(a, undefined, at("07:43"), TZ), "closed");
  assert.equal(R.remStatus(a, undefined, at("07:44"), TZ), "show");
  assert.equal(R.remStatus(a, undefined, at("07:53"), TZ), "show");
  assert.equal(R.remStatus(a, undefined, at("07:54"), TZ), "closed");
});
ok("a ring that may still be ringing or snoozed stays in the plan for 6 hours, then goes", () => {
  const rec = recWith({ at: "07:44" });
  assert.ok(R.alarmRings(rec, at("13:00"), TZ).some((x) => x.day === "2026-11-03"));
  assert.ok(!R.alarmRings(rec, at("14:00"), TZ).some((x) => x.day === "2026-11-03"));
});
ok("the Mac's plan has the alarm with its words; Settings shows when it rings", () => {
  const rec = recWith({ at: "07:44", text: "", label: "" });
  const item = R.remPlan(rec, false).items[0];
  assert.deepEqual([item.pill, item.text, item.yes, item.later, item.click, item.at, item.until], ["Alarm", "Alarm at 07:44", "Acknowledge", "Later", true, "07:44", "07:54"]);
  assert.equal(R.windowWords(rec.list[0]), "Rings at 07:44, every day");
  assert.equal(R.windowWords({ ...rec.list[0], days: [1, 2, 3, 4, 5] }), "Rings at 07:44, weekdays");
});
ok("two devices: a merge keeps the alarm an alarm", () => {
  const a = recWith({ at: "07:44" });
  const b = R.patchReminder(a, "al0", { at: "08:00" }, 9000);
  const m = R.mergeRemind(a, b);
  assert.equal(m.list[0].alarm, true);
  assert.equal(m.list[0].at, "08:00");
  assert.equal(m.list[0].until, "08:10");
});
ok("every part takes its part: the phone rings them, the Mac shows the card, nobody gets them twice", () => {
  const gw = src("src/gymwatch.ts"), rw = src("src/remwatch.ts");
  assert.match(gw, /\.\.\.alarmRings\(remindRec\(s\)/, "the gym plan carries the rings to the phone");
  assert.match(gw, /duePlan\(s, now\)\.rings/, "PS 1.73: and the Priority 1 alarms (core/duealerts.ts)");
  assert.match(gw, /gymPlan\(p, now, tz, acked\), alarms \}/, "both go in the plan's alarms");
  assert.match(rw, /PHONE && alarms\.size/, "the phone's reminder notifications leave them out");
  // The phone side (alarm rings, Acknowledge, missed) is checked by ps-gos GymClockTest.
});

console.log(`\n${n} alarm tests passed`);
