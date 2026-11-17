// Run: node --experimental-strip-types tests/afkask.test.ts
// The AFK timer asks once (src/core/afkask.ts, PS 1.66): the words, when it is due, what an answer saves, and that the island state
// carries the words only while it is due. FICTIONAL data only.
import assert from "node:assert/strict";
const A = await import("../src/core/afkask.ts");
const P = await import("../src/core/posture.ts");

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };

ok("the words are the posture reminder's question with the AFK timer's name", () => {
  assert.equal(A.AFK_ASK_WORDS.title, "Do you want to turn the AFK timer off?");
  assert.equal(A.AFK_ASK_WORDS.off, P.POSTURE_ASK_WORDS.off);
  assert.equal(A.AFK_ASK_WORDS.keep, P.POSTURE_ASK_WORDS.keep);
  for (const w of Object.values(A.AFK_ASK_WORDS)) assert.ok(!/[\u2013\u2014]/.test(w), "no em or en dashes");
});
ok("due for everyone who never answered (new people and everyone updating to 1.66)", () => {
  assert.equal(A.afkAskDue({}), true);
  assert.equal(A.afkAskDue({ afkAsk: undefined }), true);
  assert.equal(A.afkAskDue({ afkAsk: true }), false);
});
ok("the island state carries the words only while due", () => {
  assert.deepEqual(A.afkAskIsland({}), A.AFK_ASK_WORDS);
  assert.equal(A.afkAskIsland({ afkAsk: true }), null);
});
ok("Turn off and Keep it on both mark it answered; anything else (Esc, junk) saves nothing", () => {
  assert.deepEqual(A.afkAskPatch("off"), { afkAsk: true });
  assert.deepEqual(A.afkAskPatch("keep"), { afkAsk: true });
  for (const bad of ["esc", "seen", "", null, undefined, 1, {}]) assert.equal(A.afkAskPatch(bad), null);
});
console.log(`\n${n} passed`);
