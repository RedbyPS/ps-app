// Run: node --experimental-strip-types tests/rebootwarn.test.ts
// The card on the main Mac before the other Mac's auto reboot (src/core/rebootwarn.ts, V1.28).
import assert from "node:assert/strict";
import { rebootWarnCard, WARN_BEFORE } from "../src/core/rebootwarn.ts";

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const NOW = 1_793_000_000_000, MIN = 60_000;
type T = { mode?: "off" | "watch" | "active"; deadline?: number | null; postpone?: boolean; safeMode?: boolean; hours?: number };
const view = (t: T | null, o: { role?: "primary" | "secondary" | "none"; online?: boolean; peer?: boolean } = {}) => ({
  role: o.role ?? "primary", online: o.online ?? true,
  peer: o.peer === false ? null : { device: "m1", name: "Dimension's MacBook Air", role: "secondary", pub: "p", at: 0, trusted: true, me: false, paired: true },
  machine: t ? { timer: { hours: t.hours ?? 18, mode: t.mode ?? "active", deadline: t.deadline === undefined ? (NOW + 8 * MIN) / 1000 : t.deadline, postpone: t.postpone ?? true, safeMode: t.safeMode } } : null,
}) as unknown as Parameters<typeof rebootWarnCard>[0];

ok("10 minutes before an Active restart: a card with Postpone and OK, kept until answered", () => {
  const c = rebootWarnCard(view({}), NOW)!;
  assert.equal(c.title, "Dimension's MacBook Air restarts in 8 min");
  assert.deepEqual(c.actions.map((a) => a.id), ["postpone", "ok"]);
  assert.equal(c.sticky, true);
  assert.match(c.body, /waits for your password/);
  assert.match(c.id, /^rw:\d+$/);
});
ok("not earlier than 10 minutes before", () => {
  assert.equal(rebootWarnCard(view({ deadline: (NOW + WARN_BEFORE + MIN) / 1000 }), NOW), null);
});
ok("Watch only, Off, Safe Mode, no countdown: no card (nothing will restart)", () => {
  for (const t of [{ mode: "watch" as const }, { mode: "off" as const }, { safeMode: true }, { deadline: null }]) assert.equal(rebootWarnCard(view(t), NOW), null, JSON.stringify(t));
  assert.equal(rebootWarnCard(view(null), NOW), null);
});
ok("only on the main Mac (only it can sign Postpone), and only with a paired other Mac", () => {
  assert.equal(rebootWarnCard(view({}, { role: "secondary" }), NOW), null);
  assert.equal(rebootWarnCard(view({}, { peer: false }), NOW), null);
});
ok("asleep or an older helper there: OK only, and it says it wakes itself", () => {
  const asleep = rebootWarnCard(view({}, { online: false }), NOW)!;
  assert.deepEqual(asleep.actions.map((a) => a.id), ["ok"]);
  assert.match(asleep.sub, /asleep and wakes itself/);
  assert.deepEqual(rebootWarnCard(view({ postpone: false }), NOW)!.actions.map((a) => a.id), ["ok"]);
});
ok("due now: says it is restarting", () => {
  assert.equal(rebootWarnCard(view({ deadline: (NOW - MIN) / 1000 }), NOW)!.title, "Dimension's MacBook Air is restarting");
});
ok("gone 5 minutes after the time (the restart happened), and a postponed time is a new card", () => {
  assert.equal(rebootWarnCard(view({ deadline: (NOW - 6 * MIN) / 1000 }), NOW), null);
  const a = rebootWarnCard(view({}), NOW)!, b = rebootWarnCard(view({ deadline: (NOW + 8 * MIN + 3_600_000) / 1000 }), NOW + 3_600_000)!;
  assert.notEqual(a.id, b.id);
});
console.log(`${n} passed`);
