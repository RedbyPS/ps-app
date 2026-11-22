// Run: node --experimental-strip-types tests/clients-order.test.ts
// PS 1.74 check: Clients saves from the Tab list go to the main page through main.swift sendCardAction, which retried
// each message on its own timer, one second after its own last try. Two saves made while the main page loads (an update
// reload, a wake) then arrive in the order their timers come up, not the order they were made. The main page drops an edit,
// tick or rename for a task or step it does not hold yet (core/clientsact.ts runClientsOp), so the second save is lost
// without a word. FICTIONAL data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const m = readFileSync(new URL("../../mac/Sources/main.swift", import.meta.url), "utf8");
const act = readFileSync(new URL("../src/core/clientsact.ts", import.meta.url), "utf8");
let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok", name); };

// The old sendCardAction, as written in main.swift: try now; not ready, try again in a second, up to 60 times. Fake clock.
function oldSchedule(sends: { at: number; op: string }[], readyAt: number): string[] {
  const jobs: { at: number; n: number; run: () => void }[] = []; let seq = 0, now = 0;
  const later = (at: number, run: () => void) => jobs.push({ at, n: seq++, run });
  const got: string[] = [];
  const send = (op: string, tries = 0) => { if (now >= readyAt) got.push(op); else if (tries < 60) later(now + 1, () => send(op, tries + 1)); };
  for (const s of sends) later(s.at, () => send(s.op));
  while (jobs.length) { jobs.sort((a, b) => a.at - b.at || a.n - b.n); const j = jobs.shift()!; now = j.at; j.run(); }
  return got;
}

ok("the old way: a task added at 0 s and renamed at 0.5 s while the page loads (ready at 1.2 s) arrive rename first", () => {
  assert.deepEqual(oldSchedule([{ at: 0, op: "addTodo" }, { at: 0.5, op: "editTodo" }], 1.2), ["editTodo", "addTodo"]);
  assert.deepEqual(oldSchedule([{ at: 0, op: "checkAdd" }, { at: 0.4, op: "notes" }, { at: 0.6, op: "stageRemove" }], 1.5), ["stageRemove", "checkAdd", "notes"]);
});
ok("the main page drops an edit or a tick for a task it does not hold yet, so the rename above is lost", () => {
  assert.match(act, /case "editTodo": return doc<Todo>\(o\.id\)\?\.kind === "todo" \? editClientTodo\(o\.id, o\.patch\) : undefined;/);
  assert.match(act, /case "tickTodo": return doc<Todo>\(o\.id\)\?\.kind === "todo" \?/);
});
ok("main.swift sends the main page's messages one at a time, in the order sent (no own timer per message)", () => {
  assert.doesNotMatch(m, /sendCardAction\(json, tries: tries \+ 1\)/, "each message still retries on its own timer");
  assert.match(m, /func sendCardAction\(_ json: String\) \{ cardSend\.send\(json\) \}/);
  const core = readFileSync(new URL("../../mac/Sources/InOrderSendCore.swift", import.meta.url), "utf8");
  assert.match(core, /final class InOrderSend/);
});
console.log(`${n} passed`);
