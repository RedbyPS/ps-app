// Run: node --experimental-strip-types tests/soundboard.test.ts
// The Soundboard (src/core/soundboard.ts): what a file is, folder imports, the queue (mixed audio and video, shuffle,
// repeat, reorder), timed plays across days, midnight and daylight saving, and the sharing limits. FICTIONAL files only.
import assert from "node:assert/strict";
const S = await import("../src/core/soundboard.ts");

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const seq = (vals: number[]) => { let i = 0; return () => vals[i++ % vals.length]; };
const id = (c: string) => c.repeat(16).slice(0, 16);
const A = id("a"), B = id("b"), C = id("c"), D = id("d"), E = id("e");

// ---------- files ----------
ok("kinds by extension, any case", () => {
  assert.equal(S.kindOf("Song.MP3"), "audio");
  assert.equal(S.kindOf("clip.mov"), "video");
  assert.equal(S.kindOf("notes.txt"), null);
  assert.equal(S.kindOf("noext"), null);
  assert.equal(S.extOf("a/b/c.Flac"), "flac");
  assert.equal(S.baseName("Mix/Gym Pump.mp3"), "Gym Pump");
  assert.equal(S.baseName(".mp3"), ".mp3");
});
ok("an item from the shell is checked: bad ids, unknown kinds and dashes are dropped or cleaned", () => {
  const lib = S.cleanLib({ items: [
    { id: A, name: "Wake \u2014 up", ext: "MP3", size: 1000, folder: "Gym/../Old", added: 5 },
    { id: "nothex", name: "x", ext: "mp3", size: 1 },
    { id: B, name: "doc", ext: "pdf", size: 1 },
    { id: A, name: "twice", ext: "mp3", size: 1 },
    { id: C, name: "Clip", ext: "mp4", size: 9, folder: "", added: 9 },
  ], loc: { label: "Music > PS Soundboard", custom: false } });
  assert.deepEqual(lib.items.map((i) => i.id), [C, A]);   // newest first
  assert.equal(lib.items[1].name, "Wake up");
  assert.equal(lib.items[1].folder, "Gym/Old");
  assert.equal(lib.items[0].kind, "video");
  assert.equal(lib.loc.label, "Music > PS Soundboard");
});
ok("a free name: Song.mp3, then Song 2.mp3, Song 3.mp3 (case blind)", () => {
  const taken = new Set(["song.mp3", "song 2.mp3"]);
  assert.equal(S.freeName("Song.mp3", taken), "Song 3.mp3");
  assert.equal(S.freeName("Other.mp3", taken), "Other.mp3");
});

// ---------- folder import (with a fake folder) ----------
ok("Add folder: audio and video only, hidden skipped, 4 deep at most, sorted, the folder's name kept", () => {
  const fake: { path: string; size: number }[] = [
    { path: "b.mp3", size: 10 },
    { path: "a.MP4", size: 20 },
    { path: "cover.jpg", size: 5 },
    { path: ".DS_Store", size: 1 },
    { path: ".hidden/x.mp3", size: 1 },
    { path: "Old/c.wav", size: 3 },
    { path: "1/2/3/deep.mp3", size: 3 },
    { path: "1/2/3/4/too-deep.mp3", size: 3 },
    { path: "empty.mp3", size: 0 },
  ];
  const plan = S.planImport(fake, "Gym mix");
  assert.deepEqual(plan.take.map((t) => t.path), ["1/2/3/deep.mp3", "a.MP4", "b.mp3", "Old/c.wav"]);
  assert.deepEqual(plan.take.map((t) => t.folder), ["Gym mix/1/2/3", "Gym mix", "Gym mix", "Gym mix/Old"]);
  assert.equal(plan.take[1].kind, "video");
  assert.equal(plan.skipped, 5);
});
ok("Add files: no folder, and never past the Soundboard's limit", () => {
  const plan = S.planImport([{ path: "x.mp3", size: 1 }, { path: "y.mp3", size: 1 }], "", S.LIB_MAX - 1);
  assert.equal(plan.take.length, 1);
  assert.equal(plan.take[0].folder, "");
  assert.equal(plan.skipped, 1);
});
ok("a file over 4 GB is skipped", () => {
  assert.equal(S.planImport([{ path: "huge.mov", size: S.FILE_MAX + 1 }], "").skipped, 1);
});
ok("folders with their parents, filter by folder, kind and words", () => {
  const items = S.cleanLib({ items: [
    { id: A, name: "Wake up", ext: "mp3", size: 1, folder: "Gym/Old", added: 1 },
    { id: B, name: "Pump", ext: "mp4", size: 1, folder: "Gym", added: 2 },
    { id: C, name: "Rain", ext: "wav", size: 1, folder: "Sleep", added: 3 },
  ] }).items;
  assert.deepEqual(S.foldersOf(items), ["Gym", "Gym/Old", "Sleep"]);
  assert.deepEqual(S.filterItems(items, "", "Gym", "all").map((i) => i.id).sort(), [A, B]);
  assert.deepEqual(S.filterItems(items, "", "Gym", "video").map((i) => i.id), [B]);
  assert.deepEqual(S.filterItems(items, "wake", "", "all").map((i) => i.id), [A]);
  assert.deepEqual(S.filterItems(items, "sleep", "", "all").map((i) => i.id), [C]);   // folder words count
});
ok("sizes and clock words", () => {
  assert.equal(S.sizeWords(500), "1 KB");
  assert.equal(S.sizeWords(3.5 * 1024 ** 2), "3.5 MB");
  assert.equal(S.sizeWords(2 * 1024 ** 3), "2.0 GB");
  assert.equal(S.clock(75), "1:15");
  assert.equal(S.clock(3725), "1:02:05");
});

// ---------- the queue ----------
const ids = (q: import("../src/core/soundboard.ts").Queue) => q.items.map((e) => e.media);
ok("add to queue mixes audio and video; the first added is current", () => {
  let q = S.enqueue(S.emptyQueue(), [A, C]);   // A audio, C video
  assert.deepEqual(ids(q), [A, C]);
  assert.equal(q.at, 0);
  q = S.enqueue(q, [B]);
  assert.deepEqual(ids(q), [A, C, B]);
  assert.equal(q.at, 0);
});
ok("play now goes right after the current one and plays; play next waits", () => {
  let q = S.enqueue(S.emptyQueue(), [A, B, C]);
  q = S.playNow(q, D);
  assert.deepEqual(ids(q), [A, D, B, C]);
  assert.equal(S.current(q)?.media, D);
  q = S.playNext(q, E);
  assert.deepEqual(ids(q), [A, D, E, B, C]);
  assert.equal(S.current(q)?.media, D);
});
ok("next and previous; at the end with repeat off it stops", () => {
  let q = S.enqueue(S.emptyQueue(), [A, B]);
  let r = S.step(q, 1); q = r.q;
  assert.equal(S.current(q)?.media, B); assert.equal(r.play, true);
  r = S.step(q, 1);
  assert.equal(r.play, false); assert.equal(S.current(r.q)?.media, B);
  r = S.step(q, -1);
  assert.equal(S.current(r.q)?.media, A);
  assert.equal(S.step(r.q, -1).play, false);   // nothing before the first
});
ok("repeat all goes round; repeat one plays the same file again when it ends, Next still moves on", () => {
  let q = { ...S.enqueue(S.emptyQueue(), [A, B]), repeat: "all" as const, at: 1 };
  assert.equal(S.current(S.step(q, 1).q)?.media, A);
  assert.equal(S.current(S.step({ ...q, at: 0 }, -1).q)?.media, B);
  q = { ...q, repeat: "one" as const };
  assert.equal(S.current(S.step(q, 1, true).q)?.media, B);    // ended by itself
  assert.equal(S.current(S.step(q, 1, false).q)?.media, A);   // Next at the end goes round, like repeat all
  assert.equal(S.nextRepeat("off"), "all"); assert.equal(S.nextRepeat("all"), "one"); assert.equal(S.nextRepeat("one"), "off");
});
ok("shuffle walks a shuffled order with the playing one first, and the list order stays as you see it", () => {
  let q = S.enqueue(S.emptyQueue(), [A, B, C, D]);
  q = S.setShuffle(q, true, seq([0.9, 0.1, 0.5]));
  assert.deepEqual(ids(q), [A, B, C, D]);
  assert.equal(q.order[0], 0);
  assert.equal(new Set(q.order).size, 4);
  const seen = [S.current(q)!.media];
  for (let i = 0; i < 3; i++) { q = S.step(q, 1).q; seen.push(S.current(q)!.media); }
  assert.deepEqual([...seen].sort(), [A, B, C, D]);   // every one once
  assert.equal(S.step(q, 1).play, false);              // repeat off: the end
  q = S.setShuffle(q, false);
  assert.deepEqual(q.order, []);
});
ok("shuffle with repeat all reshuffles at the end, never the same file twice in a row", () => {
  let q = { ...S.setShuffle(S.enqueue(S.emptyQueue(), [A, B, C]), true, seq([0.3, 0.7])), repeat: "all" as const };
  q = { ...q, at: q.order[2] };
  const last = q.at;
  const r = S.step(q, 1, false, seq([0.99, 0.99]));
  assert.equal(r.play, true);
  assert.notEqual(r.q.at, last);
  assert.equal(new Set(r.q.order).size, 3);
});
ok("drag to reorder keeps the playing one playing", () => {
  let q = S.enqueue(S.emptyQueue(), [A, B, C, D]);
  q = S.step(q, 1).q;   // B playing
  const keyD = q.items[3].key;
  q = S.moveTo(q, keyD, 0);
  assert.deepEqual(ids(q), [D, A, B, C]);
  assert.equal(S.current(q)?.media, B);
  assert.deepEqual(S.upNext(q).map((e) => e.media), [C]);
});
ok("remove: the playing one moves to the next, the rest shift; clear keeps only the playing one", () => {
  let q = S.enqueue(S.emptyQueue(), [A, B, C]);
  q = S.step(q, 1).q;   // B
  q = S.removeAt(q, q.items[1].key);
  assert.deepEqual(ids(q), [A, C]);
  assert.equal(S.current(q)?.media, C);
  q = S.removeAt(q, q.items[0].key);
  assert.equal(S.current(q)?.media, C); assert.equal(q.at, 0);
  q = S.clearQueue(S.enqueue(q, [A, B]));
  assert.deepEqual(ids(q), [C]);
  assert.deepEqual(S.removeAt(q, q.items[0].key), { ...q, items: [], at: -1, order: [] });
});
ok("files taken out of the Soundboard leave the queue", () => {
  const q = S.dropGone(S.enqueue(S.emptyQueue(), [A, B, A, C]), new Set([A, C]));
  assert.deepEqual(ids(q), [A, A, C]);
});
ok("play a whole folder from a file in it", () => {
  const q = S.playList(S.emptyQueue(), [A, B, C], 1);
  assert.equal(S.current(q)?.media, B);
  assert.deepEqual(S.upNext(q).map((e) => e.media), [C]);
});
ok("a saved queue is checked: bad entries go, a broken shuffle order is rebuilt", () => {
  const q = S.cleanQueue({ items: [{ key: "k1", media: A }, { key: "k1", media: B }, { key: "k2", media: "zz" }, { key: "k3", media: C }], at: 7, shuffle: true, repeat: "all", order: [0, 0] });
  assert.deepEqual(ids(q), [A, C]);
  assert.equal(q.at, -1);
  assert.deepEqual(q.order, [0, 1]);
  assert.equal(q.repeat, "all");
});

// ---------- timed plays (fake clocks, fictional days) ----------
const TB = "Asia/Dubai", LDN = "Europe/London";
const tb = (day: string, hm: string) => Date.parse(`${day}T${hm}:00+04:00`);
const play = (p: Partial<import("../src/core/soundboard.ts").TimedPlay> = {}) => ({ id: "p1", media: A, name: "Wake up", at: "07:07", days: S.ALL_DAYS, vol: 0.8, loop: false, on: true, ...p });
ok("7:07am, typed any way the developer types it", () => {
  for (const t of ["7:07am", "7.07 am", "07:07", "0707", "7:07 AM"]) assert.equal(S.parseTime(t), "07:07", t);
  assert.equal(S.parseTime("7pm"), "19:00");
  assert.equal(S.parseTime("12am"), "00:00");
  assert.equal(S.parseTime("12:30pm"), "12:30");
  assert.equal(S.parseTime("25:00"), null);
  assert.equal(S.parseTime("13pm"), null);
  // Break-it 1.75: a comma, a closing dot and p.m. read too; 22.60, 25.10 and 1,5 are still not times.
  for (const [t, v] of [["22,15", "22:15"], ["22.15.", "22:15"], ["9,30pm", "21:30"], ["9.30 p.m.", "21:30"], ["22.15", "22:15"]]) assert.equal(S.parseTime(t), v, t);
  for (const t of ["22.60", "25.10", "1,5", "7,"]) assert.equal(S.parseTime(t), null, t);
  assert.equal(S.timeWords("07:07"), "7:07am");
  assert.equal(S.timeWords("19:30"), "7:30pm");
  assert.equal(S.timeWords("00:00"), "12:00am");
});
ok("every day at 7:07am: today if still to come, else tomorrow", () => {
  assert.equal(S.nextFire(play(), tb("2026-11-10", "06:00"), TB), tb("2026-11-10", "07:07"));
  assert.equal(S.nextFire(play(), tb("2026-11-10", "07:07"), TB), tb("2026-11-11", "07:07"));   // strictly after now
});
ok("weekdays only: Friday evening waits for Monday", () => {
  assert.equal(S.nextFire(play({ days: [1, 2, 3, 4, 5] }), tb("2026-11-13", "20:00"), TB), tb("2026-11-16", "07:07"));
  assert.equal(S.daysWords([1, 2, 3, 4, 5]), "Weekdays");
  assert.equal(S.daysWords([0, 6]), "Weekends");
  assert.equal(S.daysWords([1, 3]), "Mon, Wed");
  assert.equal(S.daysWords(S.ALL_DAYS), "Every day");
});
ok("off, or no days: never", () => {
  assert.equal(S.nextFire(play({ on: false }), 0, TB), -1);
  assert.equal(S.nextFire(play({ days: [] }), 0, TB), -1);
});
ok("a time just after midnight", () => {
  assert.equal(S.nextFire(play({ at: "00:05" }), tb("2026-11-10", "23:59"), TB), tb("2026-11-11", "00:05"));
});
ok("daylight saving in London: 7:07 stays 7:07 on the wall across the change", () => {
  const before = Date.parse("2026-10-24T12:00:00+01:00");   // Saturday, summer time
  const t = S.nextFire(play({ days: [0] }), before, LDN);     // Sunday 25 Oct, the clocks went back at 02:00
  assert.equal(t, Date.parse("2026-10-25T07:07:00+00:00"));
});
ok("due between two moments: once each, and nothing from hours ago after a long sleep", () => {
  const plays = [play(), play({ id: "p2", at: "07:08" }), play({ id: "p3", at: "03:00" })];
  const due = S.dueBetween(plays, tb("2026-11-10", "07:00"), tb("2026-11-10", "07:08"), TB);
  assert.deepEqual(due.map((d) => d.play.id), ["p1", "p2"]);
  const late = S.dueBetween(plays, tb("2026-11-10", "00:00"), tb("2026-11-10", "09:00"), TB);
  assert.deepEqual(late, []);
  assert.equal(S.soonest(plays, tb("2026-11-10", "07:07"), TB), tb("2026-11-10", "07:08"));
});
ok("the plan for the shell: only plays that are on with their file still here", () => {
  const plan = S.planFor([play(), play({ id: "p2", media: B }), play({ id: "p3", on: false })], new Set([A]));
  assert.deepEqual(plan.map((p) => p.id), ["p1"]);
  assert.deepEqual(Object.keys(plan[0]).sort(), ["at", "days", "id", "loop", "media", "name", "vol"]);
});
ok("saved plays are checked", () => {
  const p = S.cleanPlays([play({ vol: 5, days: [9, 1, 1] }), { id: "x", media: A, at: "7:07" }, play()]);
  assert.equal(p.length, 1);
  assert.equal(p[0].vol, 1);
  assert.deepEqual(p[0].days, [1]);
});

// ---------- sharing ----------
ok("share: small audio only, with a plain reason", () => {
  assert.equal(S.canShare({ kind: "audio", size: 2 * 1024 ** 2 }).ok, true);
  assert.equal(S.canShare({ kind: "audio", size: 11 * 1024 ** 2 }).ok, false);
  assert.match(S.canShare({ kind: "video", size: 1000 }).why, /Only audio/);
  assert.equal(S.partsFor(S.SHARE_PART * 2 + 1), 3);
  assert.equal(S.partsFor(0), 1);
});
ok("prefs: full screen never comes back by itself; bad values reset", () => {
  const p = S.cleanPrefs({ view: "full", vol: 3, kind: "nope", keep: true });
  assert.equal(p.view, "wide"); assert.equal(p.vol, 1); assert.equal(p.kind, "all"); assert.equal(p.keep, true);
});
ok("no dashes in any words the Soundboard shows", () => {
  const words = [S.canShare({ kind: "video", size: 1 }).why, S.canShare({ kind: "audio", size: 99 * 1024 ** 2 }).why, S.daysWords([1]), S.timeWords("07:07")];
  for (const w of words) assert.doesNotMatch(w, /[\u2013\u2014]/);
});

console.log(`\n${n} soundboard checks passed`);
