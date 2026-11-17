// Run: node --experimental-strip-types tests/typedprio.test.ts
// Typed priority (core/typedprio.ts, V1.40): P1, P2 or P3 typed in an add box sets the priority.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { backspaceDismisses, findPrioTokens, parsePrio, prioDismiss, prioOffer, prioOnAdd, prioPicked, prioStart, prioTyped, stripTokens, typedPlace, typedOrder,
  type PrioState } from "../src/core/typedprio.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
// Typing letter by letter, as the box does.
const type = (text: string, st: PrioState = prioStart(), from = "") => { for (let i = 1; i <= text.length; i++) st = prioTyped(st, from + text.slice(0, i)); return st; };

ok("Email QLA p1: P1, the word leaves the title", () => {
  const p = parsePrio("Email QLA p1")!;
  assert.equal(p.prio, 1);
  assert.equal(p.title, "Email QLA");
  assert.deepEqual([p.token.start, p.token.end, p.token.raw], [10, 12, "p1"]);
});
ok("P2 call Alex: P2 at the start", () => {
  const p = parsePrio("P2 call Alex")!;
  assert.equal(p.prio, 2);
  assert.equal(p.title, "call Alex");
});
ok("mp3 files, P10, p1x and AP2P are not priorities", () => {
  for (const s of ["mp3 files", "P10", "fix P10 bug", "p1x", "AP2P", "P4 later", "P0", "p_1", "SP3 deck", "2P1"]) assert.equal(parsePrio(s), null, s);
});
ok("p1 then p3: the last one wins and both leave the title", () => {
  const p = parsePrio("p1 then p3")!;
  assert.equal(p.prio, 3);
  assert.equal(p.tokens.length, 2);
  assert.equal(p.title, "then");
});
ok("any case, anywhere, with punctuation round it", () => {
  assert.equal(parsePrio("Call P3 Alex")!.title, "Call Alex");
  assert.equal(parsePrio("Call mum, P1")!.title, "Call mum");
  assert.equal(parsePrio("Call mum (p2)")!.title, "Call mum");
  assert.equal(parsePrio("P1: send invoice")!.title, "send invoice");
  assert.equal(parsePrio("Send invoice - p1")!.title, "Send invoice");
  assert.equal(parsePrio("Pay rent p2.")!.title, "Pay rent.");
  assert.equal(parsePrio("Book the gym P1, then stretch")!.title, "Book the gym, then stretch");
  assert.equal(parsePrio("  Email   QLA   p1   today ")!.title, "Email QLA today");
  assert.equal(parsePrio("P1")!.title, "", "only the word: nothing left to add");
});
ok("finds every word, first to last, with its place", () => {
  assert.deepEqual(findPrioTokens("P1 and p2 and MP3 and P3").map((t) => [t.prio, t.start]), [[1, 0], [2, 7], [3, 22]]);
  assert.equal(stripTokens("a P1 b", findPrioTokens("a P1 b")), "a b");
});
ok("typing offers it; adding takes it", () => {
  const st = type("Email QLA p1");
  assert.equal(prioOffer(st, "Email QLA p1")?.prio, 1);
  assert.equal(prioOnAdd(st, "Email QLA p1")?.title, "Email QLA");
  assert.equal(prioOffer(type("Email QLA"), "Email QLA"), null);
});
ok("saying no keeps the text as written and the normal priority", () => {
  let st = prioDismiss(type("Email QLA p1"));
  assert.equal(prioOffer(st, "Email QLA p1"), null);
  assert.equal(prioOnAdd(st, "Email QLA p1"), null, "Add uses the title as written");
  st = type(" now", st, "Email QLA p1"); // typing more after it does not bring it back
  assert.equal(prioOffer(st, "Email QLA p1 now"), null);
  st = prioTyped(st, "Email QLA p1 now p2"); // a new word is a new suggestion
  assert.equal(prioOffer(st, "Email QLA p1 now p2")?.prio, 2);
});
ok("no thanks is forgotten once the word is gone", () => {
  let st = prioDismiss(type("Call p1"));
  st = prioTyped(st, "Call p"); st = prioTyped(st, "Call ");
  st = prioTyped(st, "Call p"); st = prioTyped(st, "Call p1");
  assert.equal(prioOffer(st, "Call p1")?.prio, 1);
});
ok("Backspace right after the word says no; anywhere else it deletes", () => {
  const st = type("Email QLA p1");
  assert.equal(backspaceDismisses(st, "Email QLA p1", 12, 12), true);
  assert.equal(backspaceDismisses(st, "Email QLA p1", 11, 11), false, "inside the word");
  assert.equal(backspaceDismisses(st, "Email QLA p1", 10, 12), false, "with a selection");
  assert.equal(backspaceDismisses(prioDismiss(st), "Email QLA p1", 12, 12), false, "already said no: the second press deletes");
  assert.equal(backspaceDismisses(st, "Email QLA", 9, 9), false, "no word");
});
ok("a priority clicked after typing wins; typed after clicking wins", () => {
  let st = prioPicked(type("Email QLA p1"));
  assert.equal(prioOnAdd(st, "Email QLA p1"), null, "clicked last: the controls win and the text stays");
  assert.equal(backspaceDismisses(st, "Email QLA p1", 12, 12), false, "nothing on offer: Backspace deletes as usual");
  st = prioTyped(st, "Email QLA p1 p2");
  assert.equal(prioOnAdd(st, "Email QLA p1 p2")?.prio, 2, "typed last: the word wins");
  st = prioPicked(prioStart());
  st = type("Email QLA p1", st);
  assert.equal(prioOnAdd(st, "Email QLA p1")?.prio, 1);
});
ok("where P1, P2 and P3 go", () => {
  assert.deepEqual(typedPlace(1, 5), { p1: true, index: 0 });
  assert.deepEqual(typedPlace(2, 5), { p1: false, index: 0 }, "P2: first after the P1 group");
  assert.deepEqual(typedPlace(3, 5), { p1: false, index: 1 });
  assert.deepEqual(typedPlace(3, 0), { p1: false, index: 0 }, "shorter list: at the end");
});
ok("the order a typed priority saves", () => {
  const ranked = [{ order: 1, p1: true }, { order: 5, p1: true }, { order: 2 }, { order: 4 }, { order: 9, unranked: true }];
  assert.deepEqual(typedOrder(ranked, 1), { p1: true, order: 6 }, "P1: end of the group");
  assert.deepEqual(typedOrder(ranked, 2), { p1: false, order: 1 }, "P2: before the first numbered task");
  assert.deepEqual(typedOrder(ranked, 3), { p1: false, order: 3 }, "P3: between the first and second numbered task");
  assert.deepEqual(typedOrder([{ order: 2 }], 3), { p1: false, order: 3 }, "P3 on a one task list: at the end");
  assert.deepEqual(typedOrder([], 2), { p1: false, order: 0 });
  assert.deepEqual(typedOrder([{ order: 7, p1: true }], 2), { p1: false, order: 8 }, "only a P1 group: just after it");
});
ok("every add box with a priority uses it, and its switch is in Settings", () => {
  const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  for (const f of ["views/TaskMap.tsx", "views/DimensionX.tsx"]) assert.match(src(f), /<PrioInput\b/, f);
  assert.match(src("views/SettingsGroups.tsx"), /<TypedPrioSwitch\b/);   // V1.43: Settings, Your list, More
  assert.match(src("core/model.ts"), /tmTypedPrio\?: boolean/);
  assert.match(src("ps.ts"), /tmTypedPrio/);
});
ok("no em or en dashes in the new code", () => {
  for (const f of ["../src/core/typedprio.ts", "../src/views/TypedPrio.tsx", "../src/views/typedprio.css"]) {
    assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), "utf8"), /[–—]/, f);
  }
});

console.log(`\n${n} passed`);
