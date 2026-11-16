// V1.47: Create event in Time zones (src/core/gcal.ts). A time picked in Convert a time opens Google Calendar's
// new event page: start and end in UTC, 30 minutes, the zone the developer was looking at as ctz, the person's name in the title.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EVENT_MINUTES, GCAL_NEW, eventTitle, gcalLink, gcalStamp } from "../src/core/gcal.ts";
import { convertWall } from "../src/core/tzconvert.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const ET = "America/New_York", TB = "Asia/Dubai", UK = "Europe/London", IN = "Asia/Kolkata";
const day = (y: number, mo: number, d: number) => ({ y, mo, d });
const q = (link: string) => new URL(link).searchParams;
const moment = (y: number, mo: number, d: number, h: number, mi: number, from: string) => {
  const r = convertWall(day(y, mo, d), h, mi, from, TB);
  assert.equal(r.kind, "ok"); return (r as { hit: { ts: number } }).hit.ts;
};

ok("the stamp is UTC, whole seconds, Google's shape", () => {
  assert.equal(gcalStamp(Date.UTC(2026, 10, 10, 14, 0, 0)), "20261110T140000Z");
  assert.equal(gcalStamp(Date.UTC(2026, 0, 2, 3, 4, 5, 999)), "20260102T030405Z");
});
ok("2pm New York in winter is 19:00 UTC, the end 30 minutes later, shown in New York time", () => {
  const link = gcalLink({ start: moment(2026, 12, 1, 14, 0, ET), tz: ET, title: eventTitle("Sarah") });
  assert.ok(link.startsWith(`${GCAL_NEW}?action=TEMPLATE&`), link);
  assert.ok(link.includes("&dates=20261201T190000Z/20261201T193000Z"), link);
  assert.equal(q(link).get("ctz"), ET);
  assert.ok(link.includes("ctz=America/New_York"), "the slash in the zone stays readable");
  assert.equal(q(link).get("text"), "Call with Sarah");
});
ok("daylight saving: 2pm New York in July is 18:00 UTC (one hour earlier than in winter)", () => {
  assert.ok(gcalLink({ start: moment(2026, 7, 1, 14, 0, ET), tz: ET }).includes("dates=20260701T180000Z/20260701T183000Z"));
  assert.ok(gcalLink({ start: moment(2026, 7, 1, 14, 0, UK), tz: UK }).includes("dates=20260701T130000Z/20260701T133000Z"), "London in summer");
  assert.ok(gcalLink({ start: moment(2026, 12, 1, 14, 0, UK), tz: UK }).includes("dates=20261201T140000Z/20261201T143000Z"), "London in winter");
});
ok("the autumn night a time happens twice gives two different events an hour apart", () => {
  const r = convertWall(day(2026, 11, 1), 1, 30, ET, TB);
  assert.equal(r.kind, "twice");
  const t = r as { first: { ts: number }; second: { ts: number } };
  assert.ok(gcalLink({ start: t.first.ts, tz: ET }).includes("dates=20261101T053000Z/20261101T060000Z"));
  assert.ok(gcalLink({ start: t.second.ts, tz: ET }).includes("dates=20261101T063000Z/20261101T070000Z"));
});
ok("an end that crosses midnight UTC and a half hour zone", () => {
  assert.ok(gcalLink({ start: Date.UTC(2026, 11, 31, 23, 45) }).includes("dates=20261231T234500Z/20270101T001500Z"));
  assert.ok(gcalLink({ start: moment(2026, 11, 11, 9, 0, IN), tz: IN }).includes("dates=20261111T033000Z/20261111T040000Z"), "India +5:30");
});
ok("length: 30 minutes unless said", () => {
  assert.equal(EVENT_MINUTES, 30);
  assert.ok(gcalLink({ start: 0, minutes: 60 }).includes("dates=19700101T000000Z/19700101T010000Z"));
  assert.ok(gcalLink({ start: 0, minutes: 0 }).includes("/19700101T003000Z"));
});
ok("names with spaces, symbols and other scripts are encoded; blank names give Call", () => {
  assert.equal(eventTitle("  Mary   Jane  O'Neil "), "Call with Mary Jane O'Neil");
  assert.equal(eventTitle(""), "Call"); assert.equal(eventTitle(undefined), "Call"); assert.equal(eventTitle("   "), "Call");
  const link = gcalLink({ start: 0, title: eventTitle("Marisol & Wren #1 / Анна") });
  assert.ok(link.includes("text=Call%20with%20Marisol%20%26%20Wren%20%231%20%2F%20%D0%90"), link);
  assert.equal(q(link).get("text"), "Call with Marisol & Wren #1 / Анна");
  assert.equal([...q(link).keys()].join(","), "action,text,dates", "nothing smuggled in through the name");
});
ok("no zone, or a strange one, leaves ctz out (Google uses the calendar's own)", () => {
  assert.equal(q(gcalLink({ start: 0 })).get("ctz"), null);
  assert.equal(q(gcalLink({ start: 0, tz: "x&authuser=evil" })).get("ctz"), null);
  assert.equal(q(gcalLink({ start: 0, tz: TB })).get("ctz"), TB);
});
ok("authuser only when PS knows the account", () => {
  assert.equal(q(gcalLink({ start: 0 })).get("authuser"), null);
  assert.equal(q(gcalLink({ start: 0, authuser: null })).get("authuser"), null);
  assert.equal(q(gcalLink({ start: 0, authuser: " " })).get("authuser"), null);
  assert.equal(q(gcalLink({ start: 0, authuser: "red@example.com" })).get("authuser"), "red@example.com");
  assert.equal(q(gcalLink({ start: 0, authuser: 1 })).get("authuser"), "1");
});
ok("the button: a plain new window link (the Mac and the phone hand it to the browser), the person's name, every result kind", () => {
  const tsx = readFileSync(new URL("../src/views/TimeZones.tsx", import.meta.url), "utf8");
  assert.match(tsx, /<a className=\{`tm-cv-ev[^>]*href=\{gcalLink\(\{ start, tz, title \}\)\} target="_blank" rel="noopener noreferrer"/);
  assert.ok(tsx.includes('res.kind === "ok" && <EventLink start={res.hit.ts} tz={from} who={who} />'));
  assert.ok(tsx.includes("<EventLink start={res.first.ts}") && tsx.includes("<EventLink start={res.second.ts}"), "both times on the night clocks go back");
  assert.ok(tsx.includes("{picked && <EventLink start={picked.ts} tz={picked.tz} who={p.name} small />}"), "each client on the card");
  assert.ok(tsx.includes("over(p.tz!, zoneTitle(p.tz!), el, p.name)"), "a found person's name rides to the card");
});

console.log(`gcal: ${n} passed`);
