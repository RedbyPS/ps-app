// Run: node --experimental-strip-types tests/phoneisland.test.ts
// PS 1.66: the island inside PS on the phone (core/phoneisland.ts), the round Add task button and the swipe guard.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ISL_WORDS, NOTE_MS, countdown, nextLook, pickMoment, type IslandIn } from "../src/core/phoneisland.ts";
import { PANEL_LAYERS, covers, shown } from "../src/core/phonepanels.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const NOW = Date.parse("2026-11-17T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

ok("nothing to show: no island", () => {
  assert.equal(pickMoment(null, [], [], NOW), null);
  assert.equal(pickMoment({}, [], [], NOW), null);
});
ok("the task being worked on shows small when nothing is live, and opens that task", () => {
  const m = pickMoment({ task: { id: "t1", title: "Write the proposal" } }, [], [], NOW)!;
  assert.equal(m.kind, "task"); assert.equal(m.big, false); assert.equal(m.title, "Write the proposal"); assert.equal(m.open, "task:t1");
});
ok("private mode never shows a task's title or a message's words", () => {
  const st: IslandIn = { private: true, task: { id: "t1", title: "Secret" }, event: { id: "e", kind: "mail", title: "From Alex", sub: "Hello" } };
  const m = pickMoment(st, [], [], NOW)!;
  assert.equal(m.title, ISL_WORDS.mail); assert.equal(m.sub, "");
  const t = pickMoment({ private: true, task: { id: "t1", title: "Secret" } }, [], [], NOW)!;
  assert.equal(t.title, ISL_WORDS.privateTask); assert.equal(t.open, "list");
  const q = pickMoment({ private: true }, [{ id: "g:1", title: "Alex", body: "hi there", at: iso(NOW - 1000) }], [], NOW)!;
  assert.equal(q.title, ISL_WORDS.squad); assert.equal(q.sub, ISL_WORDS.squadPrivate);
});
ok("a new squad message comes first and leaves after its time", () => {
  const notes = [{ id: "g:1", title: "Alex", body: "Gym at 7?", at: iso(NOW - 2000) }];
  const st: IslandIn = { task: { id: "t", title: "x" }, meet: { id: "m", title: "Call", start: NOW + 60_000, end: NOW + 3_600_000 } };
  const m = pickMoment(st, notes, [], NOW)!;
  assert.equal(m.kind, "squad"); assert.equal(m.big, true); assert.equal(m.open, "gsquad"); assert.equal(m.sub, "Gym at 7?");
  assert.equal(pickMoment(st, notes, [], NOW + NOTE_MS)!.kind, "meet");
});
ok("order: email, reminder, Fitness, rest, meeting, stand-up, Pomodoro, task", () => {
  const full: IslandIn = {
    task: { id: "t", title: "Task" },
    event: { id: "e", kind: "lead", title: "Reply", sub: "Yes" },
    fit: { moment: { id: "f", title: "Found", sub: "Bench", until: NOW + 5000 }, rest: { endsAt: NOW + 30_000, exercise: "Squat", set: 2, of: 4, over: false, overAt: 0 } },
    meet: { id: "m", title: "Call", start: NOW + 120_000, end: NOW + 3_600_000 },
    stand: { at: NOW + 30_000, len: 120_000 },
    pomo: { id: "p", phase: "work", endsAt: NOW + 600_000, wait: false },
  };
  const rems = [{ id: "r", text: "Drink water", task: "" }];
  const kinds: string[] = [];
  let st: IslandIn = { ...full }, rs = rems;
  for (;;) {
    const m = pickMoment(st, [], rs, NOW);
    if (!m) break;
    kinds.push(m.kind);
    if (m.kind === "lead") st = { ...st, event: null };
    else if (m.kind === "rem") rs = [];
    else if (m.kind === "fit") st = { ...st, fit: { moment: null, rest: st.fit!.rest } };
    else if (m.kind === "rest") st = { ...st, fit: null };
    else if (m.kind === "meet") st = { ...st, meet: null };
    else if (m.kind === "stand") st = { ...st, stand: null };
    else if (m.kind === "pomo") st = { ...st, pomo: null };
    else if (m.kind === "task") st = { ...st, task: null };
  }
  assert.deepEqual(kinds, ["lead", "rem", "fit", "rest", "meet", "stand", "pomo", "task"]);
});
ok("a meeting counts down to its start, then to its end, then goes", () => {
  const st: IslandIn = { meet: { id: "m", title: "Weekly call", start: NOW + 240_000, end: NOW + 1_800_000 } };
  const a = pickMoment(st, [], [], NOW)!;
  assert.equal(a.sub, ISL_WORDS.startsIn); assert.equal(a.to, NOW + 240_000); assert.equal(a.open, "plan");
  const b = pickMoment(st, [], [], NOW + 300_000)!;
  assert.equal(b.sub, ISL_WORDS.endsIn); assert.equal(b.to, NOW + 1_800_000);
  assert.equal(pickMoment(st, [], [], NOW + 1_800_000), null);
});
ok("a reminder on a task opens that task", () => {
  const m = pickMoment({}, [], [{ id: "r", text: "Did you send it?", task: "t9" }], NOW)!;
  assert.equal(m.kind, "rem"); assert.equal(m.open, "task:t9"); assert.equal(m.title, "Did you send it?");
});
ok("rest: counts down, says Rest over for a moment, then goes", () => {
  const rest = { endsAt: NOW + 45_000, exercise: "Squat", set: 2, of: 4, over: false, overAt: 0 };
  const a = pickMoment({ fit: { moment: null, rest } }, [], [], NOW)!;
  assert.equal(a.title, ISL_WORDS.rest); assert.equal(a.sub, "Squat, Set 2 of 4"); assert.equal(a.to, NOW + 45_000); assert.equal(a.open, "gym");
  const over = { ...rest, over: true, overAt: NOW };
  assert.equal(pickMoment({ fit: { moment: null, rest: over } }, [], [], NOW + 1000)!.title, ISL_WORDS.restOver);
  assert.equal(pickMoment({ fit: { moment: null, rest: over } }, [], [], NOW + 4000), null);
});
ok("a Pomodoro break waiting has no countdown", () => {
  const m = pickMoment({ pomo: { id: "p", phase: "short", endsAt: NOW - 1, wait: true } }, [], [], NOW)!;
  assert.equal(m.title, ISL_WORDS.breakWait); assert.equal(m.to, undefined);
});
ok("countdown words", () => {
  assert.equal(countdown(NOW + 45_000, NOW), "45");
  assert.equal(countdown(NOW + 245_000, NOW), "4:05");
  assert.equal(countdown(NOW + 3_723_000, NOW), "1:02:03");
  assert.equal(countdown(NOW - 5000, NOW), "0");
});
ok("it looks again each second only while a countdown shows, never more than 30 s apart", () => {
  const st: IslandIn = { pomo: { id: "p", phase: "work", endsAt: NOW + 600_000, wait: false } };
  const m = pickMoment(st, [], [], NOW + 250)!;
  assert.ok(nextLook(m, st, [], NOW + 250) <= 1000);
  assert.equal(nextLook(null, {}, [], NOW), 30_000);
  assert.ok(nextLook(null, {}, [{ id: "g", title: "a", body: "b", at: iso(NOW) }], NOW) <= NOTE_MS + 20);
});
ok("no dashes in the island's words", () => {
  for (const v of Object.values(ISL_WORDS)) { const w = typeof v === "function" ? v(1, 2) : v; assert.ok(!/[\u2013\u2014]/.test(w), w); }
});

ok("a layer counts as open only when it is drawn and covers something", () => {
  assert.ok(shown(400, 800, "block", "visible", "1"));
  assert.ok(!shown(400, 800, "none", "visible", "1"));
  assert.ok(!shown(400, 800, "block", "hidden", "1"));
  assert.ok(!shown(400, 800, "block", "visible", "0"));
  assert.ok(!shown(20, 800, "block", "visible", "1"));
  assert.ok(covers(400, 800, 400, 800)); assert.ok(!covers(120, 60, 400, 800));
});
ok("Numerology, Purchases and the other full screen panels are in the list; the tour card is not", () => {
  for (const c of [".nu-layer", ".pc-layer", ".gs-win", ".gsw", ".fit-pop-layer", ".tm-add-layer", ".sb-layer"]) assert.ok((PANEL_LAYERS as readonly string[]).includes(c), c);
  assert.ok(!(PANEL_LAYERS as readonly string[]).includes(".fi-layer"));
});
ok("every page swipe asks first (Plan, List and Inbox, the pages of panels, the list's own pages)", () => {
  assert.match(read("src/gos/GosLayer.tsx"), /const start = \(e: TouchEvent\) => \{\n\s+if \(panelOpen\(\)\)/);
  assert.match(read("src/gos/PhonePages.tsx"), /const start = \(e: TouchEvent\) => \{\n\s+if \(panelOpen\(\)\)/);
  assert.match(read("src/views/ListPager.tsx"), /if \(panelOpen\(\)\) return;/);
});
ok("the round Add task button: on every page, opens Quick add, away while typing or with a camera open", () => {
  const css = read("src/gos/gos.css"), tsx = read("src/gos/GosLayer.tsx");
  assert.match(tsx, /className="gos-fab".*onClick=\{addNow\}/);
  assert.match(tsx, /openAddTask\("tab"\)/);
  assert.match(css, /html\.gos\.gos-kb-up \.gos-fab/);
  assert.match(css, /\.rs-cam, \.fg-scanhost, \.tm-add-layer/);
  assert.match(css, /\.gos-fab \{\n\s+position: fixed; z-index: 2147482700;/);
  assert.match(css, /html\.gos body > \.tm-add-layer \{ z-index: 2147482800; \}/);   // the sheet opens above the button and any panel
  assert.match(read("src/views/TaskMap.tsx"), /docked \|\| document\.documentElement\.classList\.contains\("gos"\) \? document\.body/);
});
ok("the island sits below the status bar, under full screen panels, and steps aside for the tour card", () => {
  const css = read("src/gos/phoneisland.css");
  assert.match(css, /top: calc\(var\(--gos-top, 0px\) \+ 8px\)/);
  assert.match(css, /z-index: 44;/);
  assert.match(css, /body:has\(\.fi-layer,/);
});
ok("both new switches are in Settings, This phone, on both phone shells", () => {
  const idx = read("src/core/settingsindex.ts"), rows = read("src/gos/PhoneRows.tsx");
  for (const id of ["phone-inapp-island", "phone-add-button"]) {
    assert.match(idx, new RegExp(`id: "${id}", group: "phone",[^\\n]*on: PHONE,`));
    assert.match(rows, new RegExp(`"${id}": function`));
  }
});
ok("the safe area: no panel asks for env(safe-area-inset-top) alone (0 in the phone's WebView)", () => {
  for (const f of ["src/views/purchases.css", "src/views/featureintro.css", "src/views/webtodo.css", "src/views/clients.css", "src/mobile/remcard.css"]) {
    const css = read(f);
    assert.ok(!/(?<!--sat, )(?<!--gos-inset-top, )(?<!--gos-top, )env\(safe-area-inset-top/.test(css), f);
  }
  const g = read("src/gos/gos.css");
  assert.match(g, /html\.gos \.pc-head \.pc-x \{ order: 1; width: 44px; height: 44px;/);
  assert.match(g, /\.chk-layer, \.wn-layer, \.af-layer, \.gc-modal/);
});
console.log(`${n} passed`);
