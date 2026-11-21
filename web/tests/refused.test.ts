// Run: node --experimental-strip-types tests/refused.test.ts
// PS 1.72 (Jan, 21 Nov 2026: lists separate on the Mac, all in one on the phone): a change the server refuses for the
// account's storage limit is kept, waits longer before each try, never holds up the other changes, and says so in the
// sync status. FICTIONAL ids and words only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HOLD_MIN, errText, heldLog, heldWords, isQuotaRefusal, nextTry, refusedAgain, sendable, waiting, type Held } from "../src/core/refused.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const T0 = Date.parse("2026-11-21T20:00:00Z");
const MIN = 60_000;
const quota = { code: "P0001", message: "Storage limit reached for this account" };

ok("the server's quota words are a quota refusal; other errors are not", () => {
  assert.equal(isQuotaRefusal(quota), true);
  assert.equal(isQuotaRefusal({ message: "Too large to store" }), true);
  assert.equal(isQuotaRefusal({ code: "42501", message: "new row violates row-level security policy" }), false);
  assert.equal(isQuotaRefusal(new Error("Failed to fetch")), false);
  assert.equal(isQuotaRefusal(null), false);
  assert.equal(errText({ message: "a", details: "b" }), "a b");
});

ok("each refusal waits longer, up to an hour", () => {
  let h: Held | undefined;
  const waits: number[] = [];
  for (let i = 0; i < 10; i++) { h = refusedAgain(h, quota, T0); waits.push((h.until - T0) / MIN); }
  assert.deepEqual(waits, [1, 2, 4, 8, 15, 30, 60, 60, 60, 60]);
  assert.equal(h!.tries, 10);
  assert.equal(HOLD_MIN.at(-1), 60);
});

ok("a refused change is kept and waits; the other changes still go", () => {
  const outbox = [{ id: "settingsrec1" }, { id: "todo00000001" }, { id: "todo00000002" }];
  const held = new Map<string, Held>([["settingsrec1", refusedAgain(undefined, quota, T0)]]);
  assert.deepEqual(sendable(outbox, held, T0 + 30_000).map((r) => r.id), ["todo00000001", "todo00000002"]);
  assert.equal(outbox.length, 3, "nothing is dropped from the outbox");
  assert.equal(waiting(held.get("settingsrec1"), T0 + 30_000), true);
  // After the wait it is tried again with the rest.
  assert.deepEqual(sendable(outbox, held, T0 + MIN).map((r) => r.id), ["settingsrec1", "todo00000001", "todo00000002"]);
  assert.equal(nextTry(held), T0 + MIN);
  assert.equal(nextTry(new Map()), null);
});

ok("the sync status carries the server's own words while a change waits, and clears after", () => {
  const held = new Map<string, Held>([["settingsrec1", refusedAgain(undefined, quota, T0)]]);
  assert.equal(heldWords(held), "Storage limit reached for this account");
  held.delete("settingsrec1");   // it went up
  assert.equal(heldWords(held), null);
});

ok("the log line names the change and the wait, never its content", () => {
  const h = refusedAgain(undefined, quota, T0);
  assert.equal(heldLog("settingsrec1", h, T0), "vault: the server refused change settings (Storage limit reached for this account); kept on this device, try 2 in 1 min");
});

ok("vault.ts flush holds quota refusals and keeps them in the outbox", () => {
  const v = readFileSync(new URL("../src/core/vault.ts", import.meta.url), "utf8");
  const flush = v.slice(v.indexOf("async function flush()"), v.indexOf("// Local first: what the server would do on a save"));
  assert.match(flush, /sendable\(outbox\.values\(\), held, now0\)/);
  assert.match(flush, /else if \(isQuotaRefusal\(e2\)\) \{[^}]*held\.set\(row\.id, h\)/);
  assert.doesNotMatch(flush.slice(flush.indexOf("isQuotaRefusal(e2)"), flush.indexOf("isQuotaRefusal(e2)") + 200), /outbox\.delete/);
  assert.match(flush, /syncError: heldWords\(held\)/);
  assert.doesNotMatch(flush, /emit\(\{ pendingCount: outbox\.size, syncError: null \}\)/, "a refusal is never cleared from the status by a later flush");
});

console.log(`refused: ${n} ok`);
