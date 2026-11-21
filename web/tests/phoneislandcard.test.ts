// Run: node --experimental-strip-types tests/phoneislandcard.test.ts
// PS 1.72 (the developer, 21 Nov 2026): the island inside PS on the phone works like the Mac's. The task by default, a reminder comes
// OUT for a few seconds and goes back in (a bell while it waits), a tap opens the card with the reminder's real buttons.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { POP_MS, cardOf, islandLook, remOut, remSeen, remTurn, tapDoes, type IslandIn, type RemIn } from "../src/core/phoneisland.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const tsx = read("src/gos/PhoneIsland.tsx"), css = read("src/gos/phoneisland.css"), layer = read("src/gos/GosLayer.tsx");
const NOW = Date.parse("2026-11-21T09:57:00Z");
const MIN = 60_000;
const task: IslandIn = { task: { id: "t1", title: "Setup Fireflies video option" } };
const rem: RemIn = { id: "r1", text: "Clean and use retainers", task: "", snooze: 15 };

ok("a reminder is out for POP_MS when it comes, then back in, then out again every snooze length", () => {
  assert.equal(remOut(NOW, 15, NOW), true);
  assert.equal(remOut(NOW, 15, NOW + POP_MS - 1), true);
  assert.equal(remOut(NOW, 15, NOW + POP_MS), false);
  assert.equal(remOut(NOW, 15, NOW + 14 * MIN), false);
  assert.equal(remOut(NOW, 15, NOW + 15 * MIN), true);
  assert.equal(remOut(NOW, 15, NOW + 15 * MIN + POP_MS), false);
  assert.equal(remOut(NOW, 5, NOW + 5 * MIN + 10), true);
  assert.equal(remOut(undefined, 15, NOW), false);
  assert.equal(remOut(NOW + 1000, 15, NOW), false);
  assert.equal(remOut(NOW, Number.NaN, NOW + 15 * MIN), true);   // a broken length: 15 minutes
});
ok("seen: a new reminder starts now, a waiting one keeps its time, an answered one drops out", () => {
  const a = remSeen({}, [rem], NOW);
  assert.deepEqual(a, { r1: NOW });
  const b = remSeen(a, [rem, { id: "r2", text: "x", task: "" }], NOW + 5000);
  assert.deepEqual(b, { r1: NOW, r2: NOW + 5000 });
  assert.deepEqual(remSeen(b, [], NOW + 6000), {});
});
ok("the next turn: when it goes back in, then when it comes out again", () => {
  const seen = { r1: NOW };
  assert.equal(remTurn([rem], seen, NOW + 1000), NOW + POP_MS);
  assert.equal(remTurn([rem], seen, NOW + POP_MS + 10), NOW + 15 * MIN);
  assert.equal(remTurn([], seen, NOW), null);
  assert.equal(remTurn([rem], {}, NOW), null);
});
ok("by default the island shows the task being worked on", () => {
  const l = islandLook(task, [], [], {}, NOW);
  assert.equal(l.face?.kind, "task"); assert.equal(l.face?.big, false); assert.equal(l.out, false); assert.deepEqual(l.waiting, []);
});
ok("The developer's case: the reminder comes out big, then the island goes back to the task with the reminder waiting", () => {
  const seen = remSeen({}, [rem], NOW);
  const out = islandLook(task, [], [rem], seen, NOW + 1000);
  assert.equal(out.face?.kind, "rem"); assert.equal(out.face?.big, true); assert.equal(out.out, true);
  assert.equal(out.face?.title, "Clean and use retainers"); assert.deepEqual(out.waiting, []);
  const back = islandLook(task, [], [rem], seen, NOW + POP_MS + 1);
  assert.equal(back.face?.kind, "task"); assert.equal(back.out, false); assert.deepEqual(back.waiting, [rem]);
});
ok("with no task, the waiting reminder stays as a small pill so a tap still reaches its buttons", () => {
  const l = islandLook({}, [], [rem], { r1: NOW }, NOW + POP_MS + 1);
  assert.equal(l.face?.kind, "rem"); assert.equal(l.face?.big, false); assert.equal(l.out, false);
  assert.equal(tapDoes(l, {}), "card");
});
ok("a timer that shows stays on the island while a reminder waits; the reminder still comes out over it", () => {
  const st: IslandIn = { ...task, pomo: { id: "p", phase: "work", endsAt: NOW + 20 * MIN, wait: false } };
  const seen = { r1: NOW };
  assert.equal(islandLook(st, [], [rem], seen, NOW + 2000).face?.kind, "rem");
  const l = islandLook(st, [], [rem], seen, NOW + POP_MS + 1);
  assert.equal(l.face?.kind, "pomo"); assert.deepEqual(l.waiting, [rem]);
});
ok("a tap opens the card for the task, a reminder and the timers; messages, emails and Fitness open their screen", () => {
  const seen = { r1: NOW };
  assert.equal(tapDoes(islandLook(task, [], [], {}, NOW), task), "card");
  assert.equal(tapDoes(islandLook(task, [], [rem], seen, NOW + 1000), task), "card");
  assert.equal(tapDoes(islandLook({ meet: { id: "m", title: "Call", start: NOW + MIN, end: NOW + 30 * MIN } }, [], [], {}, NOW), {}), "card");
  const mail: IslandIn = { ...task, event: { id: "e", kind: "mail", title: "From Alex", sub: "Hi" } };
  assert.equal(tapDoes(islandLook(mail, [], [], {}, NOW), mail), "open");
  const note = [{ id: "g:1", title: "Alex", body: "Gym?", at: new Date(NOW - 1000).toISOString() }];
  assert.equal(tapDoes(islandLook(task, note, [], {}, NOW), task), "open");
  const fit: IslandIn = { ...task, fit: { moment: { id: "f", title: "Found", sub: "x", until: NOW + 5000 }, rest: null } };
  assert.equal(tapDoes(islandLook(fit, [], [], {}, NOW), fit), "open");
  assert.equal(tapDoes({ face: null, waiting: [], out: false }, null), "open");
});
ok("private mode: a tap on the task's private pill goes to the list as before (no name to show in a card)", () => {
  const st: IslandIn = { private: true, task: { id: "t1", title: "Secret" } };
  const l = islandLook(st, [], [], {}, NOW);
  assert.equal(tapDoes(l, st), "open");
  assert.equal(cardOf(l, st, null, []).task, null);
});
ok("the card: the reminder on the face, else the first waiting one, else the one the GrapheneOS island asked for", () => {
  const r2: RemIn = { id: "r2", text: "Stretch", task: "t9", snooze: 30 };
  const seen = { r1: NOW, r2: NOW - 20 * MIN };
  const outLook = islandLook(task, [], [rem, r2], seen, NOW + 1000);
  assert.equal(outLook.face?.id, "r:r1");
  const c = cardOf(outLook, task, null, [rem, r2]);
  assert.equal(c.rem?.id, "r1"); assert.deepEqual(c.task, { id: "t1", title: "Setup Fireflies video option", dim: false }); assert.equal(c.moment, null);
  const inLook = islandLook(task, [], [rem, r2], seen, NOW + POP_MS + 1);
  assert.equal(cardOf(inLook, task, null, [rem, r2]).rem?.id, "r1");
  assert.equal(cardOf(inLook, task, "r2", [rem, r2]).rem?.id, "r2");
  assert.equal(cardOf(inLook, task, "gone", [rem, r2]).rem?.id, "r1");   // answered meanwhile: the next one
  assert.equal(cardOf(islandLook(task, [], [], {}, NOW), task, "r1", []).rem, null);
});
ok("the next Priority 1 task (nothing marked as working) comes dim, so the card does not say Working on over it", () => {
  const st: IslandIn = { task: { id: "t2", title: "Send the checklist", dim: true } };
  assert.equal(cardOf(islandLook(st, [], [], {}, NOW), st, null, []).task?.dim, true);
  assert.match(tsx, /\{!showTask\.dim && <em>\{ISL_WORDS\.working\}<\/em>\}/);
});
ok("the card carries the timer that shows, so a tap on it opens its screen", () => {
  const st: IslandIn = { ...task, fit: { moment: null, rest: { endsAt: NOW + 60_000, exercise: "Squat", set: 2, of: 4, over: false, overAt: 0 } } };
  const c = cardOf(islandLook(st, [], [], {}, NOW), st, null, []);
  assert.equal(c.moment?.kind, "rest"); assert.equal(c.moment?.open, "gym"); assert.equal(c.task?.id, "t1");
});

// The card's wiring (gos/PhoneIsland.tsx): the reminder's own rules and the shared answer path, no new words.
ok("the reminder's buttons use the same rules as the ring card and the Mac card", () => {
  assert.match(tsx, /if \(!confirms\(r, typed\)\) \{ haptic\("reject"\); setWrong\(true\); return; \}/);   // the word must be typed unless one tap
  assert.match(tsx, /remAnswer\(doneAct\(r, Date\.now\(\), DEVICE_TZ, by\)\)/);
  assert.match(tsx, /remAnswer\(snoozeAct\(r, Date\.now\(\), by\)\)/);
  assert.match(tsx, /\{!item\.click && \(/);
  assert.match(tsx, /`Only \$\{item\.word\} clears this`/);
  assert.match(tsx, /placeholder=\{`Type \$\{item\.word\}`\}/);
  assert.match(tsx, /remPlan\(rec, !!s\.red,/);   // the words come from the same plan the shells get
});
ok("the task row ticks through the island's own action, with its Undo", () => {
  assert.match(tsx, /islandMessage\(\{ type: "islandAction", action: "tick", id: task\.id \}\)/);
  assert.match(tsx, /islandMessage\(\{ type: "islandAction", action: "untick", id: ticked\.id \}\)/);
  assert.match(tsx, /aria-label=\{`Tick off: \$\{showTask\.title\}`\}/);
});
ok("it closes on a tap outside, a swipe up, Esc and Back", () => {
  assert.match(tsx, /className=\{`gos-isl-dim\$\{leaving \? " out" : ""\}`\} onClick=\{shut\}/);
  assert.match(tsx, /if \(moved < -48\)/);
  assert.match(tsx, /e\.key === "Escape" && onTop\(\)/);
  assert.match(tsx, /const back = \(e: Event\) => \{ if \(!onTop\(\)\) return;/);   // Sleep and Sentry mode over it keep their own Esc
  assert.match(tsx, /window\.addEventListener\("gos-back", back, true\)/);
});
ok("a tap on a reminder on the GrapheneOS island opens this card", () => {
  assert.match(layer, /m\.what\.startsWith\("rem:"\)/);
  assert.match(layer, /openIslandCard\(id\)/);
});
ok("Reduce Motion: the pop, the bell, the card and the dim do not move", () => {
  const rm = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  for (const sel of [".gos-isl.pop .gos-isl-b", ".gos-isl-bell", ".gos-isl-card", ".gos-isl-card.out", ".gos-isl-dim"]) assert.ok(rm.includes(sel), sel);
});
ok("no dashes in the new code's words", () => {
  for (const f of [tsx, css]) assert.ok(!/[\u2013\u2014]/.test(f));
});
console.log(`${n} passed`);
