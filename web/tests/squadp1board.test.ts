// Run: node --experimental-strip-types tests/squadp1board.test.ts
// Squad Priority 1 board (PS 1.68, core/squadp1board.ts): how each P1 ended (hit or miss) from the shared copies, that an ending is
// final, that a vanished P1 is never counted, the hit rate window and its words, the streak, the ranking, the colours of the time
// left (red only in the last 2 hours), the panel's rows setting, and the tablayout setting it is saved in. Made up ids only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as B from "../src/core/squadp1board.ts";
import { cleanLayout, setCfg, emptyLayout } from "../src/core/tablayout.ts";

const tests: [string, () => void][] = [];
const ok = (name: string, fn: () => void) => tests.push([name, fn]);
const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
const H = 3_600_000, D = 24 * H;
const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const iso = (t: number) => new Date(t).toISOString();
const A = "m-a", Bm = "m-b", C = "m-c";
const copy = (id: string, member: string, startAgo: number, x = false, doneAgo?: number) =>
  ({ id, member, t: `Task ${id}`, x, s: iso(NOW - startAgo), ...(doneAgo !== undefined ? { xa: iso(NOW - doneAgo) } : {}) });

ok("an open P1 inside its 24 hours is open, past them a miss, done in time a hit, done late a miss", () => {
  assert.equal(B.outcomeOf(copy("1", A, 5 * H), NOW)?.o, "open");
  assert.equal(B.outcomeOf(copy("1", A, 25 * H), NOW)?.o, "miss");
  assert.equal(B.outcomeOf(copy("1", A, 20 * H, true, 2 * H), NOW)?.o, "hit");
  assert.equal(B.outcomeOf(copy("1", A, 30 * H, true, 1 * H), NOW)?.o, "miss");
  assert.equal(B.outcomeOf({ x: false, s: "nonsense" }, NOW), null);
  assert.equal(B.outcomeOf({ x: false, s: iso(NOW + 3 * H) }, NOW), null, "a start from the future is not believed");
  assert.equal(B.outcomeOf({ x: true, s: iso(NOW - 30 * H) }, NOW), null, "done with no done time after the deadline: cannot tell");
});

ok("an ending is final, a vanished open P1 is dropped and never counted, a reopened P1 is a new entry", () => {
  let r = B.observeP1(null, [copy("1", A, 25 * H), copy("2", A, 3 * H)], NOW);
  assert.equal(r.changed, true);
  const missKey = Object.keys(r.log.e).find((k) => k.startsWith("1@"))!;
  assert.equal(r.log.e[missKey].o, "miss");
  // done late afterwards: still a miss
  r = B.observeP1(r.log, [copy("1", A, 25 * H, true, 0)], NOW + H);
  assert.equal(r.log.e[missKey].o, "miss");
  // nothing changes: same object back, nothing to save
  const again = B.observeP1(r.log, [copy("1", A, 25 * H, true, 0)], NOW + H);
  assert.equal(again.changed, false);
  assert.equal(again.log, r.log);
  // P1 "2" vanishes (hidden from the squad): dropped two days after its deadline, never a hit or a miss
  const later = B.observeP1(r.log, [], NOW + 3 * D);
  assert.ok(!Object.values(later.log.e).some((v) => v.id === "2"));
  assert.equal(B.p1Stats(later.log, A, NOW + 3 * D, "UTC").total, 1);
  // reopened: a new start, the old open entry of that copy goes
  const a = B.observeP1(null, [copy("3", A, 2 * H)], NOW);
  const b = B.observeP1(a.log, [copy("3", A, 0.5 * H)], NOW);
  assert.deepEqual(Object.values(b.log.e).map((v) => v.s), [iso(NOW - 0.5 * H)]);
  // daily copies and junk ids are ignored
  const j = B.observeP1(null, [{ ...copy("4", A, 25 * H), e: true }, { ...copy("bad id!", A, 25 * H) }], NOW);
  assert.equal(Object.keys(j.log.e).length, 0);
});

ok("the hit rate counts the last 30 days, or from when this PS started, and says which", () => {
  const log: B.P1Log = { since: iso(NOW - 60 * D), e: {} };
  const add = (id: string, o: "hit" | "miss", at: number) => { log.e[`${id}@x`] = { m: A, id, s: iso(at - H), o, at }; };
  for (let i = 0; i < 23; i++) add(`h${i}`, "hit", NOW - (i + 1) * H);
  add("m1", "miss", NOW - 2 * D); add("m2", "miss", NOW - 3 * D);
  add("old", "miss", NOW - 40 * D);   // outside the window
  const s = B.p1Stats(log, A, NOW, "UTC");
  assert.deepEqual([s.hits, s.total, s.rate], [23, 25, 92]);
  assert.equal(B.rateTip({ me: false, name: "Kit Doe", stats: s }, NOW, "UTC"), "92%: Kit finished 23 of 25 Priority 1 tasks inside 24 hours, last 30 days.");
  const young: B.P1Log = { since: iso(NOW - 2 * D), e: { "a@x": { m: A, id: "a", s: iso(NOW - 5 * H), o: "hit", at: NOW - H } } };
  const y = B.p1Stats(young, A, NOW, "UTC");
  assert.equal(B.rateTip({ me: true, name: "Me", stats: y }, NOW, "UTC"), "100%: You finished 1 of 1 Priority 1 task inside 24 hours, since 16 Nov (when this PS started counting).");
  const none = B.p1Stats(young, Bm, NOW, "UTC");
  assert.equal(none.rate, null);
  assert.match(B.rateTip({ me: false, name: "Sam", stats: none }, NOW, "UTC"), /^No hit rate yet: Sam has no Priority 1 task/);
});

ok("the streak: days in a row with every P1 in time, days with none do not break it, a miss does", () => {
  const log: B.P1Log = { since: iso(NOW - 30 * D), e: {} };
  const add = (id: string, o: "hit" | "miss", at: number) => { log.e[`${id}@x`] = { m: A, id, s: iso(at - H), o, at }; };
  add("t", "hit", NOW - H); add("y", "hit", NOW - D); add("y2", "hit", NOW - D - H);
  add("gap", "hit", NOW - 3 * D);   // day -2 had none: no break
  add("miss", "miss", NOW - 4 * D); add("hitSameDay", "hit", NOW - 4 * D + H);
  add("before", "hit", NOW - 5 * D);
  assert.equal(B.p1Stats(log, A, NOW, "UTC").streak, 3);
  assert.match(B.streakTip({ me: false, name: "Kit", stats: B.p1Stats(log, A, NOW, "UTC") }), /^3 day streak: every Priority 1 task done inside 24 hours, 3 days in a row\. Days with no Priority 1 task do not break it\.$/);
  add("todayMiss", "miss", NOW - 0.5 * H);
  assert.equal(B.p1Stats(log, A, NOW, "UTC").streak, 0);
  // the day boundary follows the person's own zone
  const z: B.P1Log = { since: iso(NOW - 30 * D), e: { "a@x": { m: A, id: "a", s: "2026-11-17T20:00:00.000Z", o: "miss", at: Date.parse("2026-11-17T22:30:00.000Z") },
    "b@x": { m: A, id: "b", s: "2026-11-18T00:00:00.000Z", o: "hit", at: Date.parse("2026-11-18T01:00:00.000Z") } } };
  assert.equal(B.p1Stats(z, A, NOW, "UTC").streak, 1, "UTC: the miss was the day before");
  assert.equal(B.p1Stats(z, A, NOW, "Asia/Dubai").streak, 0, "Dubai: the miss at 02:30 is the same day as the hit");
});

ok("the board: one row per person, ranked by hit rate then streak, under 3 counted not ranked, you included", () => {
  const log: B.P1Log = { since: iso(NOW - 30 * D), e: {} };
  const add = (m: string, id: string, o: "hit" | "miss", at: number) => { log.e[`${id}@x`] = { m, id, s: iso(at - H), o, at }; };
  for (let i = 0; i < 4; i++) add(A, `a${i}`, "hit", NOW - (i + 1) * D);
  for (let i = 0; i < 3; i++) add(Bm, `b${i}`, i ? "hit" : "miss", NOW - (i + 1) * D);
  add(C, "c0", "hit", NOW - D);
  const members = [{ id: "me", name: "Alex", me: true }, { id: A, name: "Ana Petrova", me: false }, { id: Bm, name: "Sam", me: false }, { id: C, name: "Kit", me: false }, { id: "quiet", name: "Lee", me: false }];
  const board = B.p1Board({ log, copies: [copy("o1", "me", 22 * H), copy("o2", Bm, 2 * H)], members, now: NOW, tz: "UTC" });
  assert.deepEqual(board.map((p) => [p.name, p.place]), [["Ana Petrova", 1], ["Sam", 2], ["Kit", null], ["You", null]]);
  assert.ok(!board.some((p) => p.member === "quiet"), "nobody with nothing at all");
  const me = board.find((p) => p.me)!;
  const lead = B.leadOf(me.rows, NOW);
  assert.equal(lead.kind, "open");
  assert.equal(lead.kind === "open" && B.leftWords(lead.left), "2h left");
  assert.equal(B.placeTip(board[2]), "Not ranked yet: needs 3 Priority 1 tasks finished or run out (has 1).");
  assert.equal(B.placeTip(board[0]), "Place 1: ranked by hit rate, then streak.");
});

ok("the time left: green, amber under 8 hours, red only in the last 2 hours (22h is never red)", () => {
  assert.equal(B.leftTone(22 * H), "ok");
  assert.equal(B.leftTone(8 * H + 1), "ok");
  assert.equal(B.leftTone(8 * H), "warn");
  assert.equal(B.leftTone(2 * H + 1), "warn");
  assert.equal(B.leftTone(2 * H), "bad");
  assert.equal(B.leftTone(0), "bad");
  assert.equal(B.leftTone(NaN), "bad");
});

ok("the people shown: default 5, 1 to 12, saved only on the Squad Priority 1 panel", () => {
  assert.equal(B.rowsOf(undefined), 5);
  assert.equal(B.rowsOf(0), 5);
  assert.equal(B.rowsOf(3.4), 3);
  assert.equal(B.rowsOf(40), 12);
  const l = setCfg(emptyLayout(), "squadp1", { rows: 9 }, "2026-11-18T00:00:00.000Z");
  assert.equal(l.cfg?.squadp1?.rows, 9);
  assert.equal(cleanLayout({ ...l, cfg: { squadp1: { rows: 40 } } }).cfg?.squadp1?.rows, undefined);
  assert.equal(cleanLayout({ ...l, cfg: { clocks: { rows: 4 } } }).cfg?.clocks, undefined, "not a setting of other panels");
});

ok("the log read back is checked, and kept under its cap", () => {
  assert.equal(B.cleanP1Log(null), null);
  assert.equal(B.cleanP1Log({ since: "x" }), null);
  const c = B.cleanP1Log({ since: iso(NOW), e: { a: { m: A, id: "1", s: iso(NOW - H), o: "hit", at: NOW }, b: { m: A, id: "2", s: iso(NOW), o: "hit" }, c: { m: "<x>", id: "3", s: iso(NOW), o: "open" } } })!;
  assert.deepEqual(Object.values(c.e).map((v) => v.id), ["1"]);
  const many = Array.from({ length: B.LOG_MAX + 50 }, (_, i) => copy(`c${i}`, A, 25 * H + i * 1000));
  assert.equal(Object.keys(B.observeP1(null, many, NOW).log.e).length, B.LOG_MAX);
});

ok("PS 1.72 (Jan): the panel opens The G Squad from its heading and from a double click on a person", () => {
  const v = src("views/SquadP1Panel.tsx");
  assert.match(v, /export const OPEN_SQUAD = "Open The G Squad";/);
  const open = v.slice(v.indexOf("function OpenSquad()"), v.indexOf("const Flame"));
  assert.match(open, /openGSquad\(true\)/, "the same action as the top right button");
  assert.match(open, /<TopIcon id="gsquad"/, "the top right button's own icon");
  assert.equal((v.match(/<span>Squad Priority 1<\/span><OpenSquad \/><\/header>/g) ?? []).length, 1, "the plain panel's heading");
  assert.equal((v.match(/>Squad Priority 1<\/span><OpenSquad \/><\/header>/g) ?? []).length, 2, "both headings");
  const row = v.slice(v.indexOf('className={`sqb-row'), v.indexOf('<span className="sqb-pl'));
  assert.match(row, /onClick=\{\(\) => \{ sfx\.click\(\); setOpenId\(isOpen \? null : p\.member\); \}\}/, "a single click still shows their Priority 1s");
  assert.match(row, /onDoubleClick=\{\(\) => \{ setOpenId\(isOpen \? p\.member : null\); openGSquad\(true, "leaderboard"\); \}\}/, "a double click opens it, the row as it was");
  assert.doesNotMatch(v.slice(v.indexOf('<section className="sqp1 sqb"'), v.indexOf("<ul ref={listRef}")), /<section[^>]*on(Double)?Click/, "nothing on the panel's empty space");
});
ok("wiring: the board is gated, keeps its log on this device only, the Tasks screen opens on All", () => {
  const eng = src("squad/engine.ts");
  assert.match(eng, /feature\(P1_FEATURE\) && feature\(BOARD_FEATURE\)/);
  assert.match(eng, /localStorage\.setItem\(P1_LOG_STORE/);
  assert.doesNotMatch(eng, /put\([^)]*p1Log|P1_LOG_STORE[^\n]*put\(/, "the log is never a vault record");
  const panel = src("views/SquadP1Panel.tsx");
  assert.match(panel, /feature\(BOARD_FEATURE\) && v\.p1b/);
  for (const w of ["rateTip", "streakTip", "placeTip", "leadTip"]) assert.match(panel, new RegExp(`data-tip-line=\\{${w}\\(`), `${w} on hover`);
  assert.match(src("views/GSquad.tsx"), /useState<"done" \| "open" \| "all">\("all"\)/);
  const reg = JSON.parse(readFileSync(new URL("../../features.json", import.meta.url), "utf8")) as { features: { id: string; since: string; owner: string; default: string }[] };
  const f = reg.features.find((x) => x.id === B.BOARD_FEATURE)!;
  assert.deepEqual([f.since, f.owner, f.default], ["1.68", "jan", "on"]);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message}`); }
}
console.log(`\n${tests.length - failed} of ${tests.length} passed`);
if (failed) process.exit(1);
