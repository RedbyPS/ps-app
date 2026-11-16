// Run: node --experimental-strip-types tests/lastonline.test.ts
// "Last online" (src/core/lastonline.ts): durations, the figures over the drop list, grouping by day, and each
// device's last seen from records the vault already holds (Second Computer hellos and heartbeats, the phone's
// screen time, notes and commands). FICTIONAL data only.
import assert from "node:assert/strict";
const L = await import("../src/core/lastonline.ts");
const { EMPTY_LOCAL } = await import("../src/second/view.ts");

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const T0 = Date.parse("2026-11-04T12:00:00.000Z");
const S = 1000, M = 60_000, H = 3_600_000, D = 86_400_000;
const env = (body: object) => ({ body: JSON.stringify(body), sig: "x", by: "y" });
const doc = (kind: string, data: unknown, id = Math.random().toString(36).slice(2)) => ({ id, ws: null, kind, data, author: null, updatedAt: null }) as never;

ok("durations read like the developer talks", () => {
  assert.equal(L.dur(25 * S), "25 s");
  assert.equal(L.dur(12 * M + 10 * S), "12 min");
  assert.equal(L.dur(H + 4 * M), "1 h 4 min");
  assert.equal(L.dur(2 * H), "2 h");
  assert.equal(L.dur(2 * D + 3 * H), "2 d 3 h");
  assert.equal(L.dur(-5), "0 s");
});

ok("figures: drops today and this week, time offline this week (an open drop counts up to now), the longest", () => {
  const drops = [
    { start: T0 - 10 * D, end: T0 - 10 * D + 5 * H, cause: "vpn" as const },          // outside the week, the longest
    { start: T0 - 7 * D - 10 * M, end: T0 - 7 * D + 20 * M, cause: "dns" as const },   // straddles the week: 20 min count
    { start: T0 - 2 * D, end: T0 - 2 * D + 30 * M, cause: "wifi-lost" as const },
    { start: T0 - 5 * M, cause: "no-route" as const },                                 // open
  ];
  const s = L.dropStats(drops, T0);
  assert.equal(s.day, 1);
  assert.equal(s.week, 3);
  assert.equal(s.weekMs, 20 * M + 30 * M + 5 * M);
  assert.equal(s.longest, drops[0]);
  assert.equal(s.longestMs, 5 * H);
  assert.deepEqual(L.dropStats([], T0), { day: 0, week: 0, weekMs: 0, longest: null, longestMs: 0 });
});

ok("grouped by local day, newest first", () => {
  const g = L.byDay([
    { start: Date.parse("2026-11-02T08:00:00Z"), end: Date.parse("2026-11-02T08:05:00Z"), cause: "vpn" },
    { start: Date.parse("2026-11-04T01:31:00Z"), end: Date.parse("2026-11-04T01:43:00Z"), cause: "vpn" },
    { start: Date.parse("2026-11-04T09:00:00Z"), end: Date.parse("2026-11-04T09:01:00Z"), cause: "dns" },
  ], "UTC");
  assert.deepEqual(g.map((x) => [x.day, x.drops.length]), [["2026-11-04", 2], ["2026-11-02", 1]]);
  assert.equal(g[0].drops[0].cause, "dns");
});

ok("unknown causes from an older or newer PS show as Unknown, never crash", () => {
  assert.equal(L.causeOf("vpn"), "vpn");
  assert.equal(L.causeOf("solar-flare"), "unknown");
  assert.equal(L.causeOf(undefined), "unknown");
  assert.ok(Object.values(L.CAUSES).every((c) => !/[\u2013\u2014]/.test(c.label + c.why)), "no long dashes");
});

const me = { device: "dev-m4", name: "Studio M4", pub: "pk4", role: "primary" as const };
const local = { ...EMPTY_LOCAL, native: true, me };
const hello = (from: string, name: string, at: number, role = "secondary") => doc("sdev", { env: env({ v: 1, t: "dev", id: `h-${from}`, from, to: "*", at, name, pub: `pk-${from}`, role, chip: "Apple M1", app: "1.30" }) });
const stat = (from: string, at: number) => doc("sstat", { env: env({ v: 1, t: "stat", id: `s-${at}`, from, to: "*", at, cpu: 3, battery: null, charging: false, power: "ac", busy: null, queue: 0, have: {} }) });

ok("the other Mac: its newest heartbeat, online within 7 minutes; this Mac itself is never listed", () => {
  const docs = [hello("dev-m4", "Studio M4", T0 - D, "primary"), hello("dev-m1", "Home M1", T0 - 2 * D), stat("dev-m1", T0 - 3 * M)];
  const seen = L.devicesSeen(docs, local, T0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, "Home M1");
  assert.equal(seen[0].at, T0 - 3 * M);
  assert.equal(seen[0].online, true);
  assert.match(seen[0].detail, /M1/);
  const later = L.devicesSeen(docs, local, T0 + 10 * M);
  assert.equal(later[0].online, false);
});

ok("the phone: the newest of its screen time save, a note, a signed command and its key announcement", () => {
  const phoneDev = doc("sdev", { phone: true, device: "ph-1", pub: "ppk", name: "Phone", at: T0 - 5 * D });
  const st = doc("screentime", { day: "2026-11-04", device: "gos", apps: [], updatedAt: new Date(T0 - 40 * M).toISOString() });
  const macSt = doc("screentime", { day: "2026-11-04", device: "mac", apps: [], updatedAt: new Date(T0 - M).toISOString() });
  const note = doc("smsg", { phone: true, text: "hi", at: T0 - 2 * H });
  const cmd = doc("scmd", { env: env({ v: 1, t: "cmd", id: "c1", from: "ph-1", to: "dev-m4", at: T0 - 20 * M, exp: T0, action: "lock" }) });
  let seen = L.devicesSeen([phoneDev, st, macSt, note], local, T0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "phone");
  assert.equal(seen[0].at, T0 - 40 * M, "the Mac's own screen time never counts for the phone");
  assert.equal(seen[0].online, false);
  assert.match(seen[0].source, /screen time/);
  seen = L.devicesSeen([phoneDev, st, note, cmd], local, T0);
  assert.equal(seen[0].at, T0 - 20 * M);
  const fresh = doc("screentime", { day: "2026-11-04", device: "gos", apps: [], updatedAt: new Date(T0 - 2 * M).toISOString() });
  assert.equal(L.devicesSeen([phoneDev, fresh], local, T0)[0].online, true);
});

ok("a clock far ahead is ignored, no phone records means no phone row, newest device first", () => {
  const ahead = doc("screentime", { day: "2026-11-05", device: "gos", apps: [], updatedAt: new Date(T0 + H).toISOString() });
  const phoneDev = doc("sdev", { phone: true, device: "ph-1", pub: "ppk", name: "Phone", at: T0 - 5 * D });
  const s = L.devicesSeen([phoneDev, ahead], local, T0);
  assert.equal(s[0].at, T0 - 5 * D);
  assert.deepEqual(L.devicesSeen([], local, T0), []);
  const both = L.devicesSeen([hello("dev-m1", "Home M1", T0 - 3 * H), phoneDev, doc("screentime", { day: "2026-11-04", device: "gos", apps: [], updatedAt: new Date(T0 - M).toISOString() })], local, T0);
  assert.deepEqual(both.map((x) => x.kind), ["phone", "mac"]);
});

console.log(`\n${n} passed`);
