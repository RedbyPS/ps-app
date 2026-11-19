// "What is new" walkthrough (core/walkthrough.ts, views/Walkthrough.tsx, V1.58): shown once per version, the developer never sees
// the 1Password and Signal step, Skip and Esc end it, Mac only, never two at once, the words in one place.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  WALK, WALK_158, WALK_IDS, WALK_TIMES, cleanWalkSeen, fillWalk, isLast, markWalkSeen, stepAfter, mergeWalkSeen, nextStep, skipAll, stepCount, stepSeen,
  stepsFor, stepsLeft, walkReady, type WalkFacts, type WalkStepId,
} from "../src/core/walkthrough.ts";
import { WALK_BUTTONS, WALK_MENU_ITEMS, WALK_WORDS } from "../src/core/walkwords.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const T0 = Date.parse("2026-11-14T12:00:00Z");

const facts = (o: Partial<WalkFacts> = {}): WalkFacts => ({
  seen: { at: {} }, synced: true, owner: true, mac: true, red: false, overProtected: true, off: {},
  enabled: true, gateOpen: true, otherShowing: false, block: null, ...o,
});

/** Walk it the way a person does: each time it shows, press Next (or the last step's Done). Returns the steps shown, in order. */
function clickThrough(f0: WalkFacts, rounds = 40): WalkStepId[] {
  let f = f0;
  const shown: WalkStepId[] = [];
  for (let i = 0; i < rounds; i++) {
    const s = nextStep({ ...f });
    if (!s) continue;
    shown.push(s.id);
    f = { ...f, seen: markWalkSeen(f.seen, [s.id], T0 + i * 1000) };
  }
  return shown;
}

ok("the order and the words (plain, no dashes, every step has words, all in the words file)", () => {
  assert.deepEqual([...WALK_IDS], ["158-menu", "158-settings", "158-topbar", "158-pomodoro", "158-standup", "158-meeting", "158-ai", "158-protected"]);
  assert.equal(WALK, WALK_158);
  for (const id of WALK_IDS) { assert.ok(WALK_WORDS[id].title.length > 5, id); assert.ok(WALK_WORDS[id].lines.length >= 1, id); }
  const all = [...Object.values(WALK_WORDS).flatMap((w) => [w.title, ...w.lines]), ...Object.values(WALK_BUTTONS), ...WALK_MENU_ITEMS];
  for (const t of all) { assert.doesNotMatch(t, /[–—]/, t); assert.ok(t.length < 220, `short: ${t}`); }
  for (const f of ["../src/core/walkwords.ts", "../src/core/walkthrough.ts", "../src/views/Walkthrough.tsx", "../src/views/walkthrough.css"]) {
    assert.doesNotMatch(read(f), /[–—]/, `no em or en dashes in ${f}`);
  }
  // The view draws no words of its own: only from walkwords.ts (the picture's little labels aside).
  const view = read("../src/views/Walkthrough.tsx");
  for (const w of Object.values(WALK_WORDS)) for (const l of [w.title, ...w.lines]) assert.ok(!view.includes(l), `the view repeats "${l}"`);
  assert.equal(fillWalk("{app} never reads", { app: "PS app" }), "PS app never reads");
  assert.equal(fillWalk(WALK_BUTTONS.count, { n: 2, total: 8 }), "2 of 8");
  assert.equal(WALK_BUTTONS.skip, "Skip");
});

ok("the words name the places the developer asked for", () => {
  const all = Object.values(WALK_WORDS).flatMap((w) => [w.title, ...w.lines]).join(" ");
  for (const must of ["grey bar", "Disappear for this meeting", "Disappear for 30 minutes", "Show it now", "Dynamic Island tab", "top bar", "corner",
    "In full screen, sit in the top bar", "Pomodoro", "Settings, Pomodoro timer", "15 seconds", "Settings, Stand-up reminders", "next meeting",
    "Join", "Settings, AI task API", "Connect your AI", "Send you messages", "Copy for your AI", "1Password", "Signal"]) assert.ok(all.includes(must), must);
});

ok("a friend sees every step once, in order, then never again", () => {
  const shown = clickThrough(facts());
  assert.deepEqual(shown, [...WALK_IDS]);
  const seen = WALK_IDS.reduce((s, id) => markWalkSeen(s, [id], T0), cleanWalkSeen(null));
  assert.equal(nextStep(facts({ seen })), null);
  assert.equal(walkReady(facts({ seen })), false);
});

ok("the 1Password and Signal step follows the BUILD (PS 1.71): never in the developer's own build, for every account in the G Squad build", () => {
  // The developer's own build: the Mac says the list does not open over them, whoever is signed in.
  for (const red of [true, false]) {
    const own = clickThrough(facts({ red, overProtected: false }));
    assert.ok(!own.includes("158-protected"));
    assert.equal(own.length, WALK_IDS.length - 1);
    assert.equal(stepCount(facts({ red, overProtected: false }), "158-ai").total, WALK_IDS.length - 1);
    assert.ok(!skipAll(facts({ red, overProtected: false })).includes("158-protected"));
  }
  // The G Squad build: the Mac says it does, for the developer's account too (before 1.71 his account never got it there).
  assert.ok(clickThrough(facts({ red: true, overProtected: true })).includes("158-protected"));
  assert.ok(clickThrough(facts({ red: false, overProtected: true })).includes("158-protected"));
  // An older Mac that does not say: the per account answer (a friend gets it, the developer does not).
  assert.ok(clickThrough(facts({ overProtected: null })).includes("158-protected"));
  assert.ok(!clickThrough(facts({ red: true, overProtected: null })).includes("158-protected"));
  // The view really asks the vault whether this is the developer's account.
  const view = read("../src/views/Walkthrough.tsx");
  assert.match(view, /red: isRedAccount\(snap\)/);
  assert.match(view, /shortcuts\?\.overProtected/);
  assert.match(read("../src/core/walkthrough.ts"), /s\.notRed && \(f\.overProtected === false \|\| \(f\.overProtected === null && f\.red\)\)/);
});

ok("Skip and Esc end it: every step this person has counts as seen, so nothing comes back", () => {
  const f = facts();
  const first = nextStep(f)!;
  assert.equal(first.id, "158-menu");
  const after = { ...f, seen: markWalkSeen(f.seen, skipAll(f), T0) };
  assert.equal(nextStep(after), null);
  for (const id of WALK_IDS) assert.ok(stepSeen(after.seen, id), id);
  // Esc: a capture listener that marks the key as used and calls the same skip.
  const view = read("../src/views/Walkthrough.tsx");
  assert.match(view, /if \(e\.key !== "Escape"\) return;\s*e\.preventDefault\(\); e\.stopImmediatePropagation\(\);\s*act\.skip\(\);/);
  assert.match(view, /addEventListener\("keydown", k, true\)/);
  // Skip is on every step but the last (the last one's Done ends it the same way).
  assert.match(view, /\{!last && <button[^>]*np-later[^>]*onClick=\{click\(act\.skip\)\}>\{WALK_BUTTONS\.skip\}/);
  assert.match(read("esc-always.test.ts"), /views\/Walkthrough\.tsx/);
});

ok("put away before a button: it comes back at the same step; the count and Done follow the person's own steps", () => {
  const f = facts({ seen: markWalkSeen(null, ["158-menu", "158-settings"], T0) });
  assert.equal(nextStep(f)!.id, "158-topbar");
  assert.deepEqual(stepCount(f, "158-topbar"), { n: 3, total: 8 });
  assert.equal(isLast(f, "158-topbar"), false);
  const nearly = facts({ seen: markWalkSeen(null, WALK_IDS.filter((id) => id !== "158-protected"), T0) });
  assert.equal(isLast(nearly, "158-protected"), true);
  // The last step says Done even if an earlier one was never seen (it would come back later on its own).
  assert.equal(isLast(facts(), "158-protected"), true);
  assert.equal(isLast(facts({ red: true, overProtected: false }), "158-ai"), true, "The developer's own build: the AI step is the last");
  assert.equal(isLast(facts({ red: true, overProtected: true }), "158-ai"), false, "the G Squad build on the developer's account: the protected step comes after it");
  assert.equal(stepAfter(facts(), "158-topbar")!.id, "158-pomodoro");
  assert.equal(stepAfter(facts({ seen: markWalkSeen(null, ["158-pomodoro", "158-standup"], T0) }), "158-topbar")!.id, "158-meeting");
  assert.equal(stepAfter(facts({ red: true, overProtected: false }), "158-ai"), null);
  const redNearly = facts({ red: true, overProtected: false, seen: markWalkSeen(null, WALK_IDS.filter((id) => id !== "158-ai" && id !== "158-protected"), T0) });
  assert.equal(isLast(redNearly, "158-ai"), true, "In the developer's own build the last step is the AI one, so it says Done");
  assert.ok(WALK_TIMES.seenAfterMs >= 8_000, "long enough to read a step before it counts by itself");
});

ok("Mac app only: the website and the phone never show it, and never mark it seen", () => {
  assert.deepEqual(stepsFor(facts({ mac: false })), []);
  assert.equal(nextStep(facts({ mac: false })), null);
  assert.deepEqual(skipAll(facts({ mac: false })), []);
  assert.match(read("../src/views/PsApp.tsx"), /<WalkthroughHost \/>/);
  assert.doesNotMatch(read("../src/App.tsx"), /WalkthroughHost/);
  assert.doesNotMatch(read("../src/gos/GosLayer.tsx"), /WalkthroughHost/);
});

ok("waits for its moment: synced, owner, switched on, after What's new, nothing else showing, nothing in the way", () => {
  assert.equal(nextStep(facts({ synced: false })), null);
  assert.equal(nextStep(facts({ owner: false })), null);
  assert.equal(nextStep(facts({ enabled: false })), null);
  assert.equal(nextStep(facts({ gateOpen: false })), null);
  assert.equal(nextStep(facts({ otherShowing: true })), null);
  for (const b of ["meeting", "sleep", "sentry", "dnd", "screen", "setup", "typing", "keys", "settling", "protected", "list"] as const) assert.equal(nextStep(facts({ block: b })), null, b);
  // walkReady ignores the moment (so the V1.56 pop-ups let it go first even while it waits for calm).
  assert.equal(walkReady(facts({ block: "settling" })), true);
  assert.equal(walkReady(facts({ gateOpen: false })), false);
});

ok("the Pomodoro step is left out when the person switched Pomodoro off", () => {
  assert.ok(!clickThrough(facts({ off: { "158-pomodoro": true } })).includes("158-pomodoro"));
  assert.match(read("../src/views/Walkthrough.tsx"), /"158-pomodoro": \(st as \{ pomodoro\?: \{ on\?: unknown \} \}\)\.pomodoro\?\.on === false/);
});

ok("seen is saved per step, synced, and two devices never undo each other", () => {
  const a = markWalkSeen(null, ["158-menu"], T0);
  const b = markWalkSeen(null, ["158-settings"], T0 + 5000);
  const m = mergeWalkSeen(a, b);
  assert.ok(stepSeen(m, "158-menu") && stepSeen(m, "158-settings"));
  assert.deepEqual(mergeWalkSeen(b, a), m);
  // The earlier time stays.
  assert.equal(markWalkSeen(a, ["158-menu"], T0 + 99_000).at["158-menu"], a.at["158-menu"]);
  // Junk is dropped.
  assert.deepEqual(cleanWalkSeen({ at: { "158-menu": "yesterday", nope: new Date(T0).toISOString(), "158-ai": 5 } }), { at: {} });
  assert.deepEqual(cleanWalkSeen("x"), { at: {} });
  assert.match(read("../src/core/model.ts"), /walkSeen\?: import\("\.\/walkthrough"\)\.WalkSeen;/);
  assert.match(read("../src/ps.ts"), /o\.walkSeen = mergeWalkSeen\(settingsData\(vaultStore\.get\(\)\)\.walkSeen, p\.walkSeen\)/);
});

ok("never two at once: the tips and the V1.56 pop-ups wait for it, it waits for them", () => {
  const view = read("../src/views/Walkthrough.tsx");
  assert.match(view, /otherShowing: tipOn\(\) \|\| popupOn\(\)/);
  assert.match(view, /setWalkWaiting\(walkReady\(f\)\)/);
  assert.match(read("../src/views/Tips.tsx"), /if \(popupOn\(\) \|\| walkOn\(\)\) return;/);
  assert.match(read("../src/views/NewPopups.tsx"), /pf\.tipShowing = tipOn\(\) \|\| walkOn\(\) \|\| walkWaitingNow\(\);/);
});

ok("gentle like the tips: no focus taken, only inside the page, the same quiet rules, its own once per device gate", () => {
  const view = read("../src/views/Walkthrough.tsx");
  for (const m of view.matchAll(/<button\b[^>]*>/g)) assert.match(m[0], /tabIndex=\{-1\}/, m[0]);
  assert.doesNotMatch(view, /\.focus\(/);
  assert.match(view, /onMouseDown=\{\(e\) => \{ e\.preventDefault\(\); e\.stopPropagation\(\); \}\}/);
  assert.match(view, /createPortal\(<WalkCard/);
  assert.doesNotMatch(view, /psPost\(/, "no native window or notification");
  assert.match(view, /const block = blocker\(bf\)/);
  assert.match(view, /hidesShowing\(block\)/);
  assert.match(view, /protectedFront: frontIsProtected\(\)/);
  assert.match(view, /const GATE_KEY = "ps\.walkGate\.158"/);
  assert.match(view, /else if \(wasSetup\) \{ wasSetup = false; if \(!gate\.current\)/);
  // The Pomodoro step points at the real button; Show me only where the Settings group exists.
  assert.equal(WALK.find((s) => s.id === "158-pomodoro")!.target, ".pm-tab-btn");
  assert.match(view, /hasGroup\(step\.settings\) && <button/);
  // The names other 1.58 chats ship (checked against pomodoro-158 a80f2eb and island-move-158 7f87443).
  const by = (id: string) => WALK.find((s) => s.id === id)!;
  assert.equal(by("158-settings").settings, "island");
  assert.equal(by("158-pomodoro").settings, "pomodoro");
  assert.equal(by("158-standup").settings, "standup");
  assert.deepEqual([by("158-meeting").settings, by("158-meeting").jump], ["notify", "meet-bubble"]);
  assert.deepEqual([by("158-ai").settings, by("158-ai").jump], ["api", "api-connect"]);   // ai-message-158 101b24a
  assert.match(view, /openSettings\(step\.settings, step\.jump \? \{ jump: step\.jump \} : \{\}\)/);
  assert.match(read("../src/views/walkthrough.css"), /prefers-reduced-motion: reduce/);
});

console.log(`\n${n} passed`);
