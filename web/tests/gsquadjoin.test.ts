// Run: node --experimental-strip-types tests/gsquadjoin.test.ts
// Join The G Squad ask (src/core/gsquadjoin.ts, PS 1.66): who gets the card, that it never shows for the developer's account or anyone in or
// waiting, and that it is a two answer intro from the island (core/featureintro.ts INTROS). FICTIONAL data only.
import assert from "node:assert/strict";
const J = await import("../src/core/gsquadjoin.ts");
const F = await import("../src/core/featureintro.ts");

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const base = { red: false, owner: true, loaded: true, inSquad: false, stage: "off" as const, updater: "open" as const };
const probe = (o: Partial<Parameters<typeof J.joinAskProbe>[0]> = {}) => J.joinAskProbe({ ...base, ...o });

ok("the words", () => {
  assert.equal(J.JOIN_ASK_WORDS.headline, "Join The G Squad?");
  assert.equal(J.JOIN_ASK_WORDS.ask, "Share your progress with friends on PS. The admin lets you in.");
  assert.equal(J.JOIN_ASK_WORDS.join, "Join");
  assert.equal(J.JOIN_ASK_WORDS.notNow, "Not now");
  for (const w of Object.values(J.JOIN_ASK_WORDS)) assert.ok(!/[\u2013\u2014]/.test(w), "no em or en dashes");
});
ok("shown to an updater not in The G Squad who switched joining off or left", () => {
  assert.equal(probe({ stage: "off" }), "open");
  assert.equal(probe({ stage: "left" }), "open");
});
ok("never for the developer's own account, whatever else", () => {
  for (const stage of ["off", "left", "joining", "asked", "removed", "full", "error"] as const) assert.equal(probe({ red: true, stage }), "done");
  assert.equal(probe({ red: true, owner: false, loaded: false }), "done");
});
ok("in The G Squad: done for good", () => { assert.equal(probe({ inSquad: true }), "done"); });
ok("waiting to be let in, a problem, or taken out by the admin: no card, looks again later", () => {
  for (const stage of ["joining", "asked", "full", "error", "removed"] as const) assert.equal(probe({ stage }), "unknown");
  assert.equal(probe({ stage: null }), "unknown");
});
ok("not loaded yet, or not the owner: waits", () => {
  assert.equal(probe({ loaded: false }), "unknown");
  assert.equal(probe({ owner: false }), "unknown");
});
ok("only after an update, once: a first install or an answer already given is done", () => {
  assert.equal(probe({ updater: "done" }), "done");
  assert.equal(probe({ updater: "unknown" }), "unknown");
});
ok("it is a two answer island intro for updaters (Join is yes, Not now is no)", () => {
  const d = F.INTROS.find((x) => x.id === J.JOIN_ASK_ID);
  assert.ok(d);
  assert.equal(d!.choice, true);
  assert.equal(d!.updatersOnly, true);
  assert.equal(d!.headline, J.JOIN_ASK_WORDS.headline);
  assert.equal(d!.ask, J.JOIN_ASK_WORDS.ask);
  assert.equal(d!.show, "Join");
  assert.equal(d!.later, "Not now");
  assert.equal(new Set(F.INTROS.map((x) => x.id)).size, F.INTROS.length, "ids never repeat");
});
console.log(`\n${n} passed`);
