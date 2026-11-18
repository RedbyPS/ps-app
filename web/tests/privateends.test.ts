// Run: node --experimental-strip-types tests/privateends.test.ts
// Private mode ends with the meeting (PS 1.68, core/privateends.ts). FICTIONAL meetings only.
import assert from "node:assert/strict";
import { PRIVATE_NEXT_MS, privatePatch, privateShouldEnd, privateSince, privateStamp } from "../src/core/privateends.ts";
import type { CalEvent } from "../src/core/model.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const T = (hm: string) => Date.parse(`2026-11-18T${hm}:00Z`);
const iso = (hm: string) => new Date(T(hm)).toISOString();
const meet = (id: string, from: string, to: string, p: Partial<CalEvent> = {}): CalEvent =>
  ({ id, title: "Call", start: iso(from), end: iso(to), allDay: false, link: "https://meet.example.com/abc", attendees: [], ...p });
const end = (privateAt: unknown, events: CalEvent[], now: string, privateMode: boolean | undefined = true) =>
  privateShouldEnd({ privateMode, privateAt, events, now: T(now) });

ok("on during a meeting: off once that meeting has ended, not before", () => {
  const ev = [meet("a", "10:00", "10:30")];
  assert.equal(end(iso("10:05"), ev, "10:29"), false);
  assert.equal(end(iso("10:05"), ev, "10:30"), true);
  assert.equal(end(iso("10:05"), ev, "15:00"), true, "a Mac that slept through the end turns it off when it runs again");
});
ok("on before a meeting: off when that meeting ends", () => {
  const ev = [meet("a", "10:00", "10:30")];
  assert.equal(end(iso("09:50"), ev, "10:10"), false);
  assert.equal(end(iso("09:50"), ev, "10:31"), true);
});
ok("on by hand after the last meeting, with nothing else today: it stays on", () => {
  const ev = [meet("a", "10:00", "10:30")];
  assert.equal(end(iso("10:45"), ev, "18:00"), false);
});
ok("back to back meetings keep it on until the last one ends", () => {
  const ev = [meet("a", "10:00", "10:30"), meet("b", "10:30", "11:00"), meet("c", "11:03", "11:30")];
  assert.equal(end(iso("10:05"), ev, "10:31"), false, "b is on");
  assert.equal(end(iso("10:05"), ev, "11:00"), false, "c starts within the next minutes");
  assert.equal(end(iso("10:05"), ev, "11:30"), true);
  assert.ok(PRIVATE_NEXT_MS === 5 * 60_000);
});
ok("a later meeting far enough away does not hold it", () => {
  const ev = [meet("a", "10:00", "10:30"), meet("b", "12:00", "12:30")];
  assert.equal(end(iso("10:05"), ev, "10:31"), true);
});
ok("only real meetings count: all day events, no people and no link, broken times", () => {
  const solo = meet("s", "10:00", "10:30", { link: null, attendees: [{ email: "me@example.com", self: true }] });
  const allDay = meet("d", "00:00", "10:20", { allDay: true });
  const broken = meet("x", "10:00", "10:30", { end: "not a time" });
  const backwards = meet("y", "10:30", "10:00");
  assert.equal(end(iso("09:00"), [solo, allDay, broken, backwards], "11:00"), false);
  const people = meet("p", "10:00", "10:30", { link: null, attendees: [{ email: "jo@example.com" }] });
  assert.equal(end(iso("09:00"), [people], "11:00"), true, "a meeting with people and no link counts");
});
ok("off already, unknown or junk start time: nothing to end", () => {
  const ev = [meet("a", "10:00", "10:30")];
  assert.equal(end(iso("10:05"), ev, "11:00", false), false);
  assert.equal(privateShouldEnd({ privateMode: undefined, privateAt: iso("10:05"), events: ev, now: T("11:00") }), false);
  assert.equal(end(undefined, ev, "11:00"), false);
  assert.equal(end("yesterday", ev, "11:00"), false);
  assert.equal(end(12345, ev, "11:00"), false);
  assert.equal(end(iso("10:05"), [], "11:00"), false);
});
ok("the watcher stamps a missing start while on, and clears a left over one while off", () => {
  const now = T("10:00");
  assert.deepEqual(privateStamp(true, undefined, now), { privateAt: iso("10:00") });
  assert.deepEqual(privateStamp(true, "junk", now), { privateAt: iso("10:00") });
  assert.equal(privateStamp(true, iso("09:00"), now), null);
  assert.deepEqual(privateStamp(false, iso("09:00"), now), { privateAt: null });
  assert.deepEqual(privateStamp(undefined, iso("09:00"), now), { privateAt: null });
  assert.equal(privateStamp(false, null, now), null);
  assert.equal(privateStamp(false, undefined, now), null);
});
ok("a stamp counts from when it was seen: a meeting already over before then never ends it", () => {
  // Turned on in an older build at 09:00 during a meeting that ended at 09:30; the Mac first sees it at 12:00 and stamps 12:00.
  const ev = [meet("a", "09:00", "09:30")];
  const st = privateStamp(true, undefined, T("12:00"))!;
  assert.equal(end(st.privateAt, ev, "12:01"), false);
});
ok("switching writes when it came on, or clears it", () => {
  assert.deepEqual(privatePatch(true, T("10:00")), { privateMode: true, privateAt: iso("10:00") });
  assert.deepEqual(privatePatch(false, T("10:00")), { privateMode: false, privateAt: null });
  assert.equal(privateSince(iso("10:00")), T("10:00"));
  assert.equal(privateSince(null), null);
});
console.log(`privateends: ${n} passed`);
