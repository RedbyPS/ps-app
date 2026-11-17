// Run: node --experimental-strip-types tests/voicecapture.test.ts
// Voice capture (core/voicecapture.ts, PS 1.65): splitting a spoken ramble into tasks (with and without the model), the review
// list (nothing is added without the Add all click), the capture flow with a fake Mac shell (permissions, hold or click, the
// 1Password and Signal stop, late answers), with a fake model.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TOUR_STEPS } from "../src/core/tour.ts";
import { SETTINGS } from "../src/core/settingsindex.ts";
import {
  checkModelTasks, VOICE_TONES, cleanSpoken, clock, HOLD_MS, meterBars, parseModelText, reviewCount, reviewRow, reviewStart, reviewStep, splitRamble, SPLIT_RULES, tasksFrom,
  voiceHoldsEsc, voiceStart, voiceStep, VOICE_WORDS, type VoiceEvent, type VoiceOut, type VoiceState, type VoiceStatus,
} from "../src/core/voicecapture.ts";

let n = 0;
const fails: string[] = [];
const ok = (name: string, fn: () => void) => { try { fn(); n++; } catch (e) { fails.push(`${name}: ${(e as Error).message.split("\n")[0]}`); } };

// Tuesday 17 November 2026, 10:00 in Dubai (06:00 UTC), as the dates parser's tests.
const NOW = Date.UTC(2026, 10, 17, 6, 0);
const TZ = "Asia/Dubai";
const split = (s: string) => splitRamble(s, NOW, TZ);

// ---------- the split without the model: many rambles ----------
const SAMPLES: [string, string[]][] = [
  ["call Alex tomorrow at 10, send Sam the invoice, gym every day at 8", ["Call Alex tomorrow at 10", "Send Sam the invoice", "Gym every day at 8"]],
  ["Call Alex tomorrow at 10. Send Sam the invoice. Gym every day at 8.", ["Call Alex tomorrow at 10", "Send Sam the invoice", "Gym every day at 8"]],
  ["I need to call the bank and then email the landlord", ["Call the bank", "Email the landlord"]],
  ["buy milk and eggs", ["Buy milk and eggs"]],
  ["buy milk, eggs and bread", ["Buy milk, eggs and bread"]],
  ["call mum and send the photos", ["Call mum", "Send the photos"]],
  ["um so I have to uh renew the passport next week", ["Renew the passport next week"]],
  ["remind me to water the plants every Monday, then take the bins out tonight", ["Water the plants every Monday", "Take the bins out tonight"]],
  ["don't forget to pay rent on the 1st and after that book the dentist", ["Pay rent on the 1st", "Book the dentist"]],
  ["okay so first of all finish the report by Friday; also order printer ink", ["Finish the report by Friday", "Order printer ink"]],
  ["call Alex, tomorrow at 10", ["Call Alex tomorrow at 10"]],
  ["tomorrow at 9, call the plumber", ["Call the plumber tomorrow at 9"]],
  ["pay the 1,000 dirham deposit", ["Pay the 1,000 dirham deposit"]],
  ["write the newsletter. ", ["Write the newsletter"]],
  ["", []],
  ["um uh", []],
  ["tomorrow at 10", []],
  ["Pick up the kids at 3:30 on Friday and then cook dinner", ["Pick up the kids at 3:30 on Friday", "Cook dinner"]],
  ["text Sam happy birthday\nemail the team the slides", ["Text Sam happy birthday", "Email the team the slides"]],
  ["read chapter four, review the contract and sign it", ["Read chapter four", "Review the contract and sign it"]],
  ["gym every weekday at 7am and also stretch every evening", ["Gym every weekday at 7am", "Stretch every evening"]],
  ["Clean the kitchen. Then hoover. Then mop.", ["Clean the kitchen", "Hoover", "Mop"]],
  ["update my iPhone", ["Update my iPhone"]],
  ["iPhone backup tonight", ["iPhone backup tonight"]],
  ["call the bank and the insurance company", ["Call the bank and the insurance company"]],
];
for (const [said, want] of SAMPLES) ok(`split: ${JSON.stringify(said)}`, () => assert.deepEqual(split(said), want));

ok("split: at most 20 tasks", () => {
  const s = Array.from({ length: 30 }, (_, i) => `call person ${i + 1}`).join(". ");
  assert.equal(split(s).length, 20);
});
ok("split: one task never longer than 200 characters", () => {
  const t = split(`write ${"a very long thing ".repeat(40)}`);
  assert.equal(t.length, 1);
  assert.ok(t[0].length <= 200);
});
ok("split: a huge transcript is cut, never slow", () => {
  const t0 = Date.now();
  split("call the bank and then ".repeat(2000));
  assert.ok(Date.now() - t0 < 2000);
});

// ---------- each task's dates through parseTaskText (the sample from the request) ----------
ok("the request's sample: three tasks with their dates and repeats", () => {
  const rows = reviewStart(split("call Alex tomorrow at 10, send Sam the invoice, gym every day at 8")).items.map((it) => reviewRow(it, NOW, TZ));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, "Call Alex");
  assert.equal(rows[0].parsed?.due, "2026-11-18");
  assert.equal(rows[0].parsed?.time, "10:00");
  assert.equal(rows[1].title, "Send Sam the invoice");
  assert.equal(rows[1].parsed, null);
  assert.equal(rows[2].title, "Gym");
  assert.equal(rows[2].parsed?.kind, "daily");
  assert.equal(rows[2].parsed?.time, "08:00");
});

// ---------- cleaning one spoken task ----------
ok("clean: lead ins, fillers and end punctuation go", () => {
  assert.equal(cleanSpoken("  so um I need to call the bank.  "), "Call the bank");
  assert.equal(cleanSpoken("and then also remember to email Kim!"), "Email Kim");
  assert.equal(cleanSpoken("to"), "");
  assert.equal(cleanSpoken("uh"), "");
  assert.equal(cleanSpoken("first aid kit for the car"), "First aid kit for the car");   // "first" is not a lead in alone
  assert.equal(cleanSpoken("add milk to the list"), "Add milk to the list");
});

// ---------- the model's split, checked (fake model) ----------
const RAMBLE = "call Alex tomorrow at 10, send Sam the invoice, gym every day at 8";
ok("model: good JSON is used", () => {
  const r = tasksFrom(RAMBLE, '{"tasks": ["Call Alex tomorrow at 10", "Send Sam the invoice", "Gym every day at 8"]}', NOW, TZ);
  assert.equal(r.via, "model");
  assert.deepEqual(r.tasks, ["Call Alex tomorrow at 10", "Send Sam the invoice", "Gym every day at 8"]);
});
ok("model: JSON inside a code fence or chatter is read", () => {
  assert.deepEqual(parseModelText('Sure! ```json\n{"tasks":["a","b"]}\n```'), ["a", "b"]);
  assert.deepEqual(parseModelText('["one", "two"]'), ["one", "two"]);
  assert.equal(parseModelText("no json here"), null);
  assert.equal(parseModelText('{"tasks": [1, 2]}'), null);
  assert.equal(parseModelText(null), null);
  assert.equal(parseModelText({ tasks: ["x"] }), null);
});
ok("model: a made up task makes the plain split win", () => {
  const r = tasksFrom(RAMBLE, '{"tasks": ["Call Alex tomorrow at 10", "Send Sam the invoice", "Gym every day at 8", "Buy a new laptop for the office"]}', NOW, TZ);
  assert.equal(r.via, "split");
  assert.equal(r.tasks.length, 3);
});
ok("model: a lost task makes the plain split win", () => {
  assert.equal(tasksFrom(RAMBLE, '{"tasks": ["Call Alex tomorrow at 10"]}', NOW, TZ).via, "split");
});
ok("model: a date it reworded makes the plain split win (the parser must see the words said)", () => {
  assert.equal(tasksFrom(RAMBLE, '{"tasks": ["Call Alex on 18 November at 10:00", "Send Sam the invoice", "Gym daily 8"]}', NOW, TZ).via, "split");
});
ok("model: a date moved to the wrong task makes the plain split win", () => {
  // "tomorrow at 10" kept word for word, but "every day at 8" dropped
  assert.equal(tasksFrom(RAMBLE, '{"tasks": ["Call Alex tomorrow at 10", "Send Sam the invoice", "Gym"]}', NOW, TZ).via, "split");
});
ok("model: small added words are fine (go to the gym)", () => {
  const r = tasksFrom("um gym every day at 8 and then call the bank", '{"tasks": ["Go to the gym every day at 8", "Call the bank"]}', NOW, TZ);
  assert.equal(r.via, "model");
});
ok("model: no model at all (null) uses the plain split", () => {
  assert.deepEqual(tasksFrom(RAMBLE, null, NOW, TZ), { tasks: split(RAMBLE), via: "split" });
});
ok("model: garbage, too many or empty lists fall back", () => {
  assert.equal(checkModelTasks("I could not do that", RAMBLE, NOW, TZ), null);
  assert.equal(checkModelTasks('{"tasks": []}', RAMBLE, NOW, TZ), null);
  assert.equal(checkModelTasks(JSON.stringify({ tasks: Array.from({ length: 25 }, () => "call Alex") }), RAMBLE, NOW, TZ), null);
  assert.equal(checkModelTasks('{"tasks": ["call"]}', "", NOW, TZ), null);
});
ok("model: the model's split into more tasks than the plain one is accepted", () => {
  const said = "pick up the dry cleaning and the parcel from the post office";
  const r = tasksFrom(said, '{"tasks": ["Pick up the dry cleaning", "Pick up the parcel from the post office"]}', NOW, TZ);
  assert.equal(r.via, "model");
  assert.equal(r.tasks.length, 2);
});
ok("the Mac's instructions say the same rules (VoiceCaptureCore.swift)", () => {
  const swift = readFileSync(new URL("../../mac/Sources/VoiceCaptureCore.swift", import.meta.url), "utf8");
  for (const line of SPLIT_RULES) assert.ok(swift.includes(JSON.stringify(line).slice(1, -1)), `missing in Swift: ${line}`);
});

// ---------- the review list: nothing is added without the click ----------
const ST = () => reviewStart(["Call Alex tomorrow at 10", "Send Sam the invoice", "Gym every day at 8"]);
ok("review: Enter, a key or anything automatic adds nothing", () => {
  for (const by of ["enter", "key", "auto"] as const) {
    const r = reviewStep(ST(), { type: "addAll", by }, NOW, TZ);
    assert.equal(r.add.length, 0, by);
    assert.equal(r.st.done, false, by);
  }
});
ok("review: the Add all click adds every row, once", () => {
  const r = reviewStep(ST(), { type: "addAll", by: "click" }, NOW, TZ);
  assert.equal(r.add.length, 3);
  assert.deepEqual(r.add.map((x) => x.title), ["Call Alex", "Send Sam the invoice", "Gym"]);
  const again = reviewStep(r.st, { type: "addAll", by: "click" }, NOW, TZ);
  assert.equal(again.add.length, 0, "a double click adds nothing more");
});
ok("review: edit changes the row and its date chip", () => {
  let st = ST();
  st = reviewStep(st, { type: "edit", id: "v2", text: "Send Sam the invoice on Friday" }, NOW, TZ).st;
  const row = reviewRow(st.items[1], NOW, TZ);
  assert.equal(row.title, "Send Sam the invoice");
  assert.equal(row.parsed?.due, "2026-11-20");
});
ok("review: remove takes the row out, and it is not added", () => {
  let st = ST();
  st = reviewStep(st, { type: "remove", id: "v1" }, NOW, TZ).st;
  const r = reviewStep(st, { type: "addAll", by: "click" }, NOW, TZ);
  assert.deepEqual(r.add.map((x) => x.title), ["Send Sam the invoice", "Gym"]);
});
ok("review: removing every row leaves nothing to add", () => {
  let st = ST();
  for (const id of ["v1", "v2", "v3"]) st = reviewStep(st, { type: "remove", id }, NOW, TZ).st;
  assert.equal(reviewCount(st, NOW, TZ), 0);
  assert.equal(reviewStep(st, { type: "addAll", by: "click" }, NOW, TZ).add.length, 0);
});
ok("review: the chip click keeps the words as text (Friday deck)", () => {
  let st = reviewStart(["Friday deck"]);
  assert.equal(reviewRow(st.items[0], NOW, TZ).parsed?.due, "2026-11-20");
  st = reviewStep(st, { type: "keepWords", id: "v1" }, NOW, TZ).st;
  const row = reviewRow(st.items[0], NOW, TZ);
  assert.equal(row.parsed, null);
  assert.equal(row.title, "Friday deck");
});
ok("review: a row emptied by editing is left out, the count says so", () => {
  let st = ST();
  st = reviewStep(st, { type: "edit", id: "v3", text: "  " }, NOW, TZ).st;
  assert.equal(reviewCount(st, NOW, TZ), 2);
  assert.equal(reviewStep(st, { type: "addAll", by: "click" }, NOW, TZ).add.length, 2);
});
ok("review: a row that is only a date keeps its words as the title", () => {
  const row = reviewRow(reviewStart(["Tomorrow"]).items[0], NOW, TZ);
  assert.equal(row.parsed, null);
  assert.equal(row.title, "Tomorrow");
});
ok("review: after Add all, edits and removes do nothing", () => {
  const done = reviewStep(ST(), { type: "addAll", by: "click" }, NOW, TZ).st;
  assert.equal(reviewStep(done, { type: "remove", id: "v1" }, NOW, TZ).st.items.length, 3);
});

// ---------- the capture flow with a fake Mac shell ----------
const READY: VoiceStatus = { supported: true, perm: "ready", onDevice: true, lang: "English (US)" };
const ctx = (extra: Partial<{ protectedFront: boolean }> = {}) => ({ now: NOW, tz: TZ, ...extra });
function run(events: VoiceEvent[], from: VoiceState = voiceStart(), extra: Partial<{ protectedFront: boolean }> = {}) {
  let st = from;
  const out: VoiceOut[] = [];
  const added: string[] = [];
  for (const e of events) {
    const r = voiceStep(st, e, ctx(extra));
    st = r.st; out.push(...r.out); added.push(...r.add.map((x) => x.title));
  }
  return { st, out, added };
}
const status = (s: Partial<VoiceStatus> = {}, featureOn = true): VoiceEvent => ({ type: "status", status: { ...READY, ...s }, featureOn });

ok("flow: off until the Mac says it can (website, phone, an older Mac)", () => {
  assert.equal(voiceStart().phase, "off");
  assert.equal(run([status({ supported: false })]).st.phase, "off");
  assert.equal(run([status({}, false)]).st.phase, "off", "the switch is off");
  assert.equal(run([{ type: "down", at: 1 }]).out.length, 0, "a press before the status does nothing");
});
ok("flow: first click asks, with the one plain line why; nothing records", () => {
  const r = run([status({ perm: "ask" }), { type: "down", at: 1 }]);
  assert.equal(r.st.phase, "asking");
  assert.equal(r.st.note, VOICE_WORDS.why);
  assert.deepEqual(r.out, [{ type: "voice:ask" }]);
});
ok("flow: allowed: ready, and the next press records", () => {
  const r = run([status({ perm: "ask" }), { type: "down", at: 1 }, { type: "up", at: 900 }, { type: "perm", perm: "ready", onDevice: true }]);
  assert.equal(r.st.phase, "idle");
  assert.equal(r.st.note, VOICE_WORDS.ready);
  assert.ok(!r.out.some((o) => o.type === "voice:start"), "never starts by itself after the ask");
  const r2 = run([{ type: "down", at: 2000 }], r.st);
  assert.deepEqual(r2.out, [{ type: "voice:start" }]);
});
ok("flow: said no: the plain line and the System Settings button, never asks again", () => {
  const r = run([status({ perm: "ask" }), { type: "down", at: 1 }, { type: "perm", perm: "denied", onDevice: true }]);
  assert.equal(r.st.note, VOICE_WORDS.denied);
  const r2 = run([{ type: "down", at: 5 }], r.st);
  assert.equal(r2.out.length, 0);
  assert.equal(r2.st.note, VOICE_WORDS.denied);
  assert.deepEqual(run([{ type: "settingsClick" }], r.st).out, [{ type: "voice:settings" }]);
});
ok("flow: restricted Mac: says so, does nothing", () => {
  const r = run([status({ perm: "restricted" }), { type: "down", at: 1 }]);
  assert.equal(r.out.length, 0);
  assert.equal(r.st.note, VOICE_WORDS.restricted);
});
ok("flow: no on-device speech for the language: says so plainly, does nothing", () => {
  const r = run([status({ onDevice: false, lang: "Welsh" }), { type: "down", at: 1 }]);
  assert.equal(r.out.length, 0);
  assert.ok(r.st.note.includes("Welsh"));
  assert.ok(r.st.note.includes("will not listen"));
});
ok("flow: hold to talk: letting go after a hold stops", () => {
  const r = run([status(), { type: "down", at: 1000 }, { type: "started", at: 1100 }, { type: "up", at: 1000 + HOLD_MS + 300 }]);
  assert.deepEqual(r.out, [{ type: "voice:start" }, { type: "voice:stop" }]);
});
ok("flow: a short click keeps listening until Stop", () => {
  const r = run([status(), { type: "down", at: 1000 }, { type: "started", at: 1050 }, { type: "up", at: 1120 }]);
  assert.equal(r.st.phase, "recording");
  assert.deepEqual(r.out, [{ type: "voice:start" }]);
  assert.deepEqual(run([{ type: "stopClick" }], r.st).out, [{ type: "voice:stop" }]);
  assert.deepEqual(run([{ type: "down", at: 5000 }], r.st).out, [{ type: "voice:stop" }], "the microphone button again also stops");
});
ok("flow: 1Password or Signal in front: never starts", () => {
  const r = run([status(), { type: "down", at: 1 }], voiceStart(), { protectedFront: true });
  assert.equal(r.out.length, 0);
  assert.equal(r.st.note, VOICE_WORDS.protectedFront);
  const b = run([status(), { type: "down", at: 1 }, { type: "blocked", why: "protected" }]);
  assert.equal(b.st.phase, "idle");
  assert.equal(b.st.note, VOICE_WORDS.protectedFront);
});
ok("flow: 1Password or Signal comes to the front while listening: stopped, what came before is kept", () => {
  const r = run([status(), { type: "down", at: 1 }, { type: "started", at: 2 }, { type: "partial", text: "call the bank" }, { type: "stopped", reason: "protected", text: "call the bank", at: 3 }]);
  assert.equal(r.st.phase, "thinking");
  assert.equal(r.st.note, VOICE_WORDS.protectedStop);
  const r0 = run([status(), { type: "down", at: 1 }, { type: "started", at: 2 }, { type: "stopped", reason: "protected", text: "", at: 3 }]);
  assert.equal(r0.st.phase, "idle");
  assert.equal(r0.st.note, VOICE_WORDS.protectedStop);
});
ok("flow: the level meter and words follow only while listening", () => {
  const r = run([status(), { type: "down", at: 1 }, { type: "level", v: 0.9 }, { type: "started", at: 2 }, { type: "level", v: 7 }, { type: "partial", text: "call" }]);
  assert.equal(r.st.level, 1);
  assert.equal(r.st.partial, "call");
});
ok("flow: stopped with words: thinking, the split is asked of the Mac", () => {
  const r = run([status(), { type: "down", at: 1 }, { type: "started", at: 2 }, { type: "stopClick" }, { type: "stopped", reason: "user", text: RAMBLE, at: 99 }]);
  assert.equal(r.st.phase, "thinking");
  assert.deepEqual(r.out.at(-1), { type: "voice:split", id: "s99", text: RAMBLE });
});
ok("flow: the fake model answers: the review list, and nothing is added yet", () => {
  const base = run([status(), { type: "down", at: 1 }, { type: "started", at: 2 }, { type: "stopped", reason: "user", text: RAMBLE, at: 99 }]).st;
  const r = run([{ type: "tasks", id: "s99", tasks: '{"tasks": ["Call Alex tomorrow at 10", "Send Sam the invoice", "Gym every day at 8"]}' }], base);
  assert.equal(r.st.phase, "review");
  assert.equal(r.st.via, "model");
  assert.equal(r.st.review?.items.length, 3);
  assert.equal(r.added.length, 0);
});
ok("flow: no answer in time: the plain split", () => {
  const base = run([status(), { type: "down", at: 1 }, { type: "started", at: 2 }, { type: "stopped", reason: "user", text: RAMBLE, at: 99 }]).st;
  const r = run([{ type: "splitTimeout", id: "s99" }], base);
  assert.equal(r.st.phase, "review");
  assert.equal(r.st.via, "split");
  assert.equal(run([{ type: "tasks", id: "s99", tasks: '["late"]' }], r.st).st.review?.items.length, 3, "a late answer changes nothing");
});
ok("flow: an answer to an older recording is ignored", () => {
  const base = run([status(), { type: "down", at: 1 }, { type: "started", at: 2 }, { type: "stopped", reason: "user", text: RAMBLE, at: 99 }]).st;
  assert.equal(run([{ type: "tasks", id: "s1", tasks: null }], base).st.phase, "thinking");
});
ok("flow: Add all only by its click; Esc in the review adds nothing", () => {
  const base = run([status(), { type: "down", at: 1 }, { type: "started", at: 2 }, { type: "stopped", reason: "user", text: RAMBLE, at: 99 }, { type: "tasks", id: "s99", tasks: null }]).st;
  assert.equal(run([{ type: "review", a: { type: "addAll", by: "enter" } }], base).added.length, 0);
  const esc = run([{ type: "esc" }], base);
  assert.equal(esc.added.length, 0);
  assert.equal(esc.st.phase, "idle");
  const r = run([{ type: "review", a: { type: "remove", id: "v2" } }, { type: "review", a: { type: "addAll", by: "click" } }], base);
  assert.deepEqual(r.added, ["Call Alex", "Gym"]);
  assert.equal(r.st.phase, "idle");
  assert.equal(r.st.note, VOICE_WORDS.added(2));
});
ok("flow: Esc while listening cancels, nothing kept", () => {
  const r = run([status(), { type: "down", at: 1 }, { type: "started", at: 2 }, { type: "partial", text: "call" }, { type: "esc" }]);
  assert.equal(r.st.phase, "idle");
  assert.deepEqual(r.out.at(-1), { type: "voice:cancel" });
  assert.equal(run([{ type: "stopped", reason: "user", text: "call", at: 5 }], r.st).st.phase, "idle", "the shell's late stop is ignored");
});
ok("flow: started after an Esc: the Mac is told to cancel at once", () => {
  const r = run([status(), { type: "down", at: 1 }, { type: "esc" }, { type: "started", at: 2 }]);
  assert.deepEqual(r.out.at(-1), { type: "voice:cancel" });
  assert.equal(r.st.phase, "idle");
  assert.ok(!r.out.some((o) => o.type === "voice:split"));
});
ok("flow: nothing heard, the limit, an error", () => {
  const go = [status(), { type: "down", at: 1 }, { type: "started", at: 2 }] as VoiceEvent[];
  assert.equal(run([...go, { type: "stopped", reason: "user", text: "  ", at: 3 }]).st.note, VOICE_WORDS.nothing);
  assert.equal(run([...go, { type: "stopped", reason: "limit", text: "call the bank", at: 3 }]).st.note, VOICE_WORDS.limit);
  assert.equal(run([...go, { type: "stopped", reason: "error", text: "", at: 3 }]).st.note, VOICE_WORDS.failed);
});
ok("flow: Esc closes the voice part first, then the window", () => {
  const rec = run([status(), { type: "down", at: 1 }, { type: "started", at: 2 }]).st;
  assert.equal(voiceHoldsEsc(rec), true);
  const idle = run([status()]).st;
  assert.equal(voiceHoldsEsc(idle), false);
  const noted = run([status({ perm: "denied" }), { type: "down", at: 1 }]).st;
  assert.equal(voiceHoldsEsc(noted), true);
  assert.equal(voiceHoldsEsc(run([{ type: "esc" }], noted).st), false);
});
ok("flow: the switch turned off mid way stops it all", () => {
  const rec = run([status(), { type: "down", at: 1 }, { type: "started", at: 2 }]).st;
  assert.equal(run([{ type: "blocked", why: "off" }], rec).st.phase, "off");
});

// ---------- small pieces ----------
ok("meter: calm, bounded, middle tallest; reduced motion still", () => {
  assert.deepEqual(meterBars(0), [0.15, 0.15, 0.15, 0.15, 0.15]);
  const b = meterBars(1);
  assert.equal(b[2], 1);
  assert.ok(b[0] < b[1] && b[1] < b[2]);
  assert.deepEqual(meterBars(5), meterBars(1));
  assert.deepEqual(meterBars(Number.NaN), meterBars(0));
  assert.deepEqual(meterBars(0.7, true), [0.5, 0.5, 0.5, 0.5, 0.5]);
});
ok("clock", () => { assert.equal(clock(0), "0:00"); assert.equal(clock(7400), "0:07"); assert.equal(clock(102000), "1:42"); assert.equal(clock(-5), "0:00"); });
ok("words: no dashes in the new words", () => {
  const all = JSON.stringify(VOICE_WORDS) + [VOICE_WORDS.noOnDevice("x"), VOICE_WORDS.addAll(3), VOICE_WORDS.reviewHead(2), VOICE_WORDS.added(1)].join("");
  assert.ok(!/[–—]/.test(all));
});


// ---------- wiring: the switch, the registry, the tour, the Mac's sounds ----------
ok("features.json: voice-capture, jan, shared, 1.65, on, web and mac", () => {
  const f = JSON.parse(readFileSync(new URL("../../features.json", import.meta.url), "utf8")) as { features: { id: string; owner: string; scope: string; since: string; default: string; parts: string[] }[] };
  const e = f.features.find((x) => x.id === "voice-capture");
  assert.ok(e);
  assert.deepEqual([e!.owner, e!.scope, e!.since, e!.default], ["jan", "shared", "1.65", "on"]);
  assert.deepEqual(e!.parts, ["web", "mac"]);
});
ok("Settings: Speak your tasks, Your list, the Mac only", () => {
  const e = SETTINGS.find((x) => x.id === "voice-capture");
  assert.equal(e?.group, "list");
  assert.deepEqual(e?.on, ["mac"]);
});
ok("the 1.65 tour has its step, on the Mac", () => {
  const t = TOUR_STEPS.find((x) => x.ids.includes("voice-capture"));
  assert.ok(t);
  assert.deepEqual(t!.on, ["mac"]);
});
ok("the Mac plays the same two sounds (Sfx.swift)", () => {
  const swift = readFileSync(new URL("../../mac/Sources/Sfx.swift", import.meta.url), "utf8");
  for (const k of ["start", "stop"] as const) {
    const line = swift.split("\n").find((l) => l.includes(`"voice-${k}"`)) ?? "";
    for (const t of VOICE_TONES[k]) assert.ok(line.includes(`f: ${t.f},`) && line.includes(`dur: ${t.dur},`), `voice-${k} ${t.f}`);
  }
});
ok("the Mac page asks for speech on this Mac only (VoiceCapture.swift)", () => {
  const swift = readFileSync(new URL("../../mac/Sources/VoiceCapture.swift", import.meta.url), "utf8");
  assert.ok(swift.includes("requiresOnDeviceRecognition = true"));
  assert.ok(swift.includes("Protected.matches"));
});

if (fails.length) { console.error(fails.join("\n")); console.error(`${fails.length} failed, ${n} passed`); process.exit(1); }
console.log(`voicecapture: ${n} passed`);
