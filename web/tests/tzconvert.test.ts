// The per zone converter on the time zone cards (core/tzconvert.ts, V1.36): reading what the developer types,
// and turning a wall clock time on a day in one zone into his own zone, with daylight saving right
// for that day in both zones, the spring night a time never happens and the autumn night it happens twice.
import assert from "node:assert/strict";
import { addDays, convertWall, dayTag, daysBetween, parseTyped, todayIn, zoneName, zoneShort } from "../src/core/tzconvert.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const TB = "Asia/Dubai", PT = "America/Los_Angeles", ET = "America/New_York", CT = "America/Chicago", MT = "America/Denver", UK = "Europe/London";
const at = (iso: string) => Date.parse(iso);
const day = (y: number, mo: number, d: number) => ({ y, mo, d });
const hm = (h: number, mi: number) => ({ h, mi });

// ---------- reading what he types ----------
ok("2pm, 2 pm, 2PM, 2p and 2 p.m. are all 14:00", () => {
  for (const s of ["2pm", "2 pm", "2PM", "2p", "2 p.m.", " 2pm "]) assert.deepEqual(parseTyped(s), { ...hm(14, 0), zone: undefined }, s);
});
ok("24 hour times: 14:00, 14.00, 14h00, 1400 and 14", () => {
  for (const s of ["14:00", "14.00", "14h00", "1400", "14"]) assert.deepEqual(parseTyped(s), { ...hm(14, 0), zone: undefined }, s);
});
ok("minutes: 2:30pm, 2.30pm, 2 30 pm, 1430, 930 and 0930", () => {
  assert.deepEqual(parseTyped("2:30pm"), { ...hm(14, 30), zone: undefined });
  assert.deepEqual(parseTyped("2.30pm"), { ...hm(14, 30), zone: undefined });
  assert.deepEqual(parseTyped("2 30 pm"), { ...hm(14, 30), zone: undefined });
  assert.deepEqual(parseTyped("1430"), { ...hm(14, 30), zone: undefined });
  assert.deepEqual(parseTyped("930"), { ...hm(9, 30), zone: undefined });
  assert.deepEqual(parseTyped("0930"), { ...hm(9, 30), zone: undefined });
});
ok("12am is midnight, 12pm is noon, and the words work too", () => {
  assert.deepEqual(parseTyped("12am"), { ...hm(0, 0), zone: undefined });
  assert.deepEqual(parseTyped("12:15 am"), { ...hm(0, 15), zone: undefined });
  assert.deepEqual(parseTyped("12pm"), { ...hm(12, 0), zone: undefined });
  assert.deepEqual(parseTyped("noon"), { ...hm(12, 0), zone: undefined });
  assert.deepEqual(parseTyped("midnight"), { ...hm(0, 0), zone: undefined });
  assert.deepEqual(parseTyped("0:00"), { ...hm(0, 0), zone: undefined });
});
ok("a zone after the time is understood: 2pm PT, 9am eastern time, 5pm UK", () => {
  assert.deepEqual(parseTyped("2pm PT"), { ...hm(14, 0), zone: PT });
  assert.deepEqual(parseTyped("2pm pst"), { ...hm(14, 0), zone: PT });
  assert.deepEqual(parseTyped("9am eastern time"), { ...hm(9, 0), zone: ET });
  assert.deepEqual(parseTyped("17:00 uk"), { ...hm(17, 0), zone: UK });
  assert.deepEqual(parseTyped("noon CT"), { ...hm(12, 0), zone: CT });
});
ok("not times: empty, words, 25:00, 13pm, 0am, 2:75, 24, 12345", () => {
  for (const s of ["", "   ", "abc", "25:00", "13pm", "0am", "2:75", "24", "12345", "2pm xyz", "2:5pm"]) assert.equal(parseTyped(s), null, JSON.stringify(s));
});

// ---------- days ----------
ok("today in a zone is that zone's own calendar day", () => {
  const t = at("2026-11-05T21:00:00Z");   // 01:00 on the 6th in the developer's city, 13:00 on the 5th in LA
  assert.deepEqual(todayIn(TB, t), day(2026, 11, 6));
  assert.deepEqual(todayIn(PT, t), day(2026, 11, 5));
});
ok("stepping days crosses month, year and leap day ends", () => {
  assert.deepEqual(addDays(day(2026, 1, 31), 1), day(2026, 2, 1));
  assert.deepEqual(addDays(day(2028, 2, 28), 1), day(2028, 2, 29));
  assert.deepEqual(addDays(day(2026, 12, 31), 1), day(2027, 1, 1));
  assert.deepEqual(addDays(day(2026, 3, 1), -1), day(2026, 2, 28));
  assert.equal(daysBetween(day(2026, 11, 5), day(2026, 12, 5)), 30);
});
ok("day tags", () => {
  assert.equal(dayTag(0), "");
  assert.equal(dayTag(1), "+1 day");
  assert.equal(dayTag(-1), "-1 day");
  assert.equal(dayTag(2), "+2 days");
});

// ---------- converting ----------
const one = (r: ReturnType<typeof convertWall>) => { assert.equal(r.kind, "ok"); return (r as Extract<typeof r, { kind: "ok" }>).hit; };

ok("The developer's example: 2pm PT on Thu 5 Nov 2026 is 02:00 on Fri 6 Nov in the developer's city (+1 day)", () => {
  const h = one(convertWall(day(2026, 11, 5), 14, 0, PT, TB));
  assert.equal(h.ts, at("2026-11-05T22:00:00Z"));   // Pacific is on winter time (UTC-8) after 1 Nov
  assert.deepEqual([h.at.d, h.at.h, h.at.mi], [6, 2, 0]);
  assert.equal(h.dayDiff, 1);
});
ok("the same 2pm PT in July is an hour earlier in the developer's city (Pacific summer time, Dubai has none)", () => {
  const h = one(convertWall(day(2026, 7, 15), 14, 0, PT, TB));
  assert.equal(h.ts, at("2026-07-15T21:00:00Z"));
  assert.deepEqual([h.at.d, h.at.h], [16, 1]);
  assert.equal(h.dayDiff, 1);
});
ok("9am ET stays on the same day in the developer's city (18:00 in winter, 17:00 in summer)", () => {
  const w = one(convertWall(day(2026, 11, 5), 9, 0, ET, TB));
  assert.deepEqual([w.at.d, w.at.h, w.dayDiff], [5, 18, 0]);
  const s = one(convertWall(day(2026, 6, 10), 9, 0, ET, TB));
  assert.deepEqual([s.at.d, s.at.h, s.dayDiff], [10, 17, 0]);
});
ok("11pm ET on New Year's Eve lands on 1 Jan 2027 in the developer's city", () => {
  const h = one(convertWall(day(2026, 12, 31), 23, 0, ET, TB));
  assert.deepEqual([h.at.y, h.at.mo, h.at.d, h.at.h], [2027, 1, 1, 8]);
  assert.equal(h.dayDiff, 1);
});
ok("the other way, a day back: 1am Dubai on 6 Nov is 1pm on 5 Nov in Pacific (-1 day)", () => {
  const h = one(convertWall(day(2026, 11, 6), 1, 0, TB, PT));
  assert.deepEqual([h.at.d, h.at.h, h.dayDiff], [5, 13, -1]);
});
ok("both zones' daylight saving count: 9am ET on 10 Mar 2026 is 13:00 in London (4h, not 5h)", () => {
  // The US moved its clocks on 8 Mar, the UK only on 29 Mar.
  const h = one(convertWall(day(2026, 3, 10), 9, 0, ET, UK));
  assert.equal(h.at.h, 13);
  const later = one(convertWall(day(2026, 4, 10), 9, 0, ET, UK));
  assert.equal(later.at.h, 14);
});

// ---------- the clock change nights ----------
ok("US spring forward (Sun 8 Mar 2026): 2:30am Pacific never happens, read as 3:30am", () => {
  const r = convertWall(day(2026, 3, 8), 2, 30, PT, TB);
  assert.equal(r.kind, "missing");
  if (r.kind !== "missing") return;
  assert.equal(r.jumpFrom, 120);   // 2:00
  assert.equal(r.jumpTo, 180);     // jumps to 3:00
  assert.equal(r.hit.ts, at("2026-03-08T10:30:00Z"));   // 3:30am PDT
  assert.deepEqual([r.hit.at.d, r.hit.at.h, r.hit.at.mi, r.hit.dayDiff], [8, 14, 30, 0]);
});
ok("US spring forward: 2:00am Eastern never happens either, 1:59am and 3:00am do", () => {
  assert.equal(convertWall(day(2026, 3, 8), 2, 0, ET, TB).kind, "missing");
  assert.equal(one(convertWall(day(2026, 3, 8), 1, 59, ET, TB)).ts, at("2026-03-08T06:59:00Z"));   // still EST
  assert.equal(one(convertWall(day(2026, 3, 8), 3, 0, ET, TB)).ts, at("2026-03-08T07:00:00Z"));    // EDT
  for (const z of [CT, MT]) assert.equal(convertWall(day(2026, 3, 8), 2, 15, z, TB).kind, "missing", z);
});
ok("US fall back (Sun 1 Nov 2026): 1:30am Pacific happens twice, an hour apart in the developer's city", () => {
  const r = convertWall(day(2026, 11, 1), 1, 30, PT, TB);
  assert.equal(r.kind, "twice");
  if (r.kind !== "twice") return;
  assert.equal(r.first.ts, at("2026-11-01T08:30:00Z"));    // 1:30 PDT
  assert.equal(r.second.ts, at("2026-11-01T09:30:00Z"));   // 1:30 PST
  assert.deepEqual([r.first.at.h, r.first.at.mi, r.second.at.h], [12, 30, 13]);
  assert.equal(r.jumpFrom, 120);   // at 2:00
  assert.equal(r.jumpTo, 60);      // back to 1:00
  assert.deepEqual([r.first.dayDiff, r.second.dayDiff], [0, 0]);
});
ok("US fall back: 1:00am Central and Mountain happen twice, 12:59am and 2:00am once", () => {
  for (const z of [CT, MT, ET]) assert.equal(convertWall(day(2026, 11, 1), 1, 0, z, TB).kind, "twice", z);
  assert.equal(one(convertWall(day(2026, 11, 1), 0, 59, PT, TB)).ts, at("2026-11-01T07:59:00Z"));
  assert.equal(one(convertWall(day(2026, 11, 1), 2, 0, PT, TB)).ts, at("2026-11-01T10:00:00Z"));
});
ok("UK changes: 1:30am on 29 Mar 2026 never happens, on 25 Oct 2026 it happens twice", () => {
  const sp = convertWall(day(2026, 3, 29), 1, 30, UK, TB);
  assert.equal(sp.kind, "missing");
  if (sp.kind === "missing") assert.deepEqual([sp.jumpFrom, sp.jumpTo], [60, 120]);
  const fa = convertWall(day(2026, 10, 25), 1, 30, UK, TB);
  assert.equal(fa.kind, "twice");
  if (fa.kind === "twice") assert.deepEqual([fa.jumpFrom, fa.jumpTo, fa.second.ts - fa.first.ts], [120, 60, 3600000]);
});
ok("late evening Pacific on a change day crosses midnight in the developer's city with the new offset", () => {
  // 8 Mar 2026, 11pm PDT (UTC-7) = 06:00Z on the 9th = 10:00 on Mon 9 Mar in the developer's city.
  const h = one(convertWall(day(2026, 3, 8), 23, 0, PT, TB));
  assert.deepEqual([h.at.d, h.at.h, h.dayDiff], [9, 10, 1]);
  // 1 Nov 2026, 11pm PST (UTC-8) = 07:00Z on the 2nd = 11:00 on Mon 2 Nov in the developer's city.
  const w = one(convertWall(day(2026, 11, 1), 23, 0, PT, TB));
  assert.deepEqual([w.at.d, w.at.h, w.dayDiff], [2, 11, 1]);
});
ok("Dubai itself never changes its clocks: every wall time there happens once", () => {
  for (const d of [day(2026, 3, 29), day(2026, 10, 25), day(2026, 3, 8), day(2026, 11, 1)])
    for (let h = 0; h < 24; h++) assert.equal(convertWall(d, h, 30, TB, PT).kind, "ok");
});

ok("zone names for the card", () => {
  assert.equal(zoneShort(PT), "PT");
  assert.equal(zoneName(MT), "Mountain");
  assert.equal(zoneName("America/Sao_Paulo"), "Sao Paulo");
  assert.equal(zoneShort(TB), "");
});

console.log(`\n${n} passed`);
