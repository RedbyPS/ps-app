// Run: node --experimental-strip-types tests/islandprivate.test.ts
// A friend's island read "Hidden (private mode)" and they took it for a task: private mode was on without them knowing
// (the mask on the Tab list, or Yes on "Start private mode?"). The hiding stays exactly as it was; the island now says
// "Private mode" with a mask and a Show button (ps-mac Island.swift privateLabel and privateBanner), and a click there
// comes back as {type:"islandAction", action:"privateOff"} and turns private mode off, the real task sent at once.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const I = await import("../src/core/island.ts");

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const base = { todos: [], today: "2026-11-12", mail: 0, leads: 0, event: null };
const S = (settings: unknown) => I.islandState({ ...base, settings: settings as never });
const src = (p: string) => readFileSync(p, "utf8");

ok("the hiding is unchanged: titles still read the private title and the state says private", () => {
  const todo = { id: "x", kind: "todo", data: { title: "Pay the rent", done: false } };
  const s = I.islandState({ ...base, todos: [todo] as never, settings: { workingIds: ["x"], privateMode: true } as never });
  assert.equal(s.private, true);
  assert.equal(s.task?.title, I.PRIVATE_TITLE);
  assert.ok(!JSON.stringify(s).includes("Pay the rent"));
});
ok("a click turns it off only while the island was told private and it is still on", () => {
  const priv = S({ privateMode: true }), open = S({});
  assert.equal(I.canPrivateOff(priv, true), true);
  assert.equal(I.canPrivateOff(priv, false), false);       // already off: nothing to do
  assert.equal(I.canPrivateOff(priv, undefined), false);
  assert.equal(I.canPrivateOff(open, true), false);        // an old click from before it was on never turns it off
  assert.equal(I.canPrivateOff(null, true), false);        // nothing shown yet (locked, signed out)
});
ok("the page handles the click before the task id check, saves privateMode false and resends at once", () => {
  const p = src("src/island.ts");
  const i = p.indexOf('m.action === "privateOff"'), id = p.indexOf('typeof m.id !== "string"');
  assert.ok(i > 0 && id > i, "privateOff handled before the id guard");
  assert.match(p, /canPrivateOff\(shown, settingsData\(s\)\.privateMode\)\) void saveSettings\(privatePatch\(false, Date\.now\(\)\)\)\.then\(\(\) => sync\(true\)\)/);
  // only for an unlocked owner, as ticks
  assert.ok(p.indexOf('s.status !== "unlocked" || s.role !== "owner") return true;') < i);
});
ok("no em or en dashes", () => {
  for (const f of ["src/island.ts", "src/core/island.ts"]) assert.ok(!/[–—]/.test(src(f)), f);
});
console.log(`${n} ok`);
