// Run: node --experimental-strip-types tests/keep-my-edits.test.ts
// PS 1.74 (21 Nov 2026): "When i make updates to my checklist, on update it sometimes deletes the updates i made
// recently", "I just titled these months and it got deleted" (the Map's Year view) and "I still cant delete mini tasks
// separately". Each loss is reproduced first with the old behaviour, then shown fixed (core/keepedits.ts, wired in
// core/vault.ts). FICTIONAL data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const K = await import("../src/core/keepedits.ts");
const Sub = await import("../src/core/subtasks.ts");

let n = 0;
const tests: [string, () => unknown][] = [];
const ok = (name: string, fn: () => unknown) => tests.push([name, fn]);
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------- a checklist task, as both devices had it ----------
const sub = (id: string, title: string, done = false) => ({ id, title, done, ...(done ? { doneAt: "2026-11-21T07:00:00.000Z" } : {}) });
const checklist = {
  title: "Evening routine", type: "daily", done: false, order: 3, notes: null,
  subtasks: [sub("s1", "Stretch"), sub("s2", "Read 10 pages"), sub("s3", "Plan tomorrow"), sub("s4", "Lights off")],
};

// ---------- a tiny model of core/vault.ts: records from the server (rows), unsent changes (outbox), the copy in memory
// (docs) that every edit starts from, put() and rebuildDocs(), the old way and the fixed way ----------
function model(fixed: boolean) {
  const rows = new Map<string, unknown>(), outbox = new Map<string, unknown>();
  let docs = new Map<string, any>();
  const watch = new K.WriteWatch(), lane = new K.IdLane();
  const decrypt = async (v: unknown) => { await tick(); return clone(v); };   // decrypting is async, a record at a time
  async function put(id: string, data: unknown) {
    if (!fixed) {   // the old put: encrypt first, then the new copy lands in memory
      const ct = await decrypt(data);
      outbox.set(id, ct); docs = new Map(docs).set(id, data);
      return;
    }
    docs = new Map(docs).set(id, data);
    watch.begin(id);
    try { await lane.run(id, async () => { outbox.set(id, await decrypt(data)); }); } finally { watch.end(id); }
  }
  async function rebuild() {   // after a download: every record decrypted again, then the whole list on screen
    const w = fixed ? watch.start() : new Set<string>();
    const built = new Map<string, any>();
    for (const [id, r] of [...rows]) built.set(id, await decrypt(outbox.get(id) ?? r));
    if (fixed) { watch.stop(w); docs = K.keepWritten(built, docs, w); } else docs = built;
  }
  // The app's edits (core/actions.ts updateTodo, subtaskOp): the copy in memory, changed, put back whole.
  const tickSub = (id: string, sid: string) => put(id, { ...docs.get(id), subtasks: Sub.applySubOp(docs.get(id).subtasks, { op: "tick", id: sid }, "2026-11-21T20:00:00.000Z", true) });
  const update = (id: string, patch: object) => put(id, { ...docs.get(id), ...patch });
  rows.set("chk", clone(checklist));   // read early in the rebuild, then 40 more records take their turn
  for (let i = 0; i < 40; i++) rows.set(`todo${i}`, { title: `Task ${i}`, type: "once", done: false, order: i });
  docs = new Map([...rows].map(([k, v]) => [k, clone(v)]));
  return { put, rebuild, tickSub, update, outbox, get docs() { return docs; } };
}
const ticked = (t: any) => t.subtasks.filter((s: any) => s.done).map((s: any) => s.id);

// ---------- 1. a sync landing while you tick a checklist ----------
ok("reproduced: a mini task ticked while a sync rebuilds the list is unticked again by the next tick", async () => {
  const v = model(false);
  const sync = v.rebuild();          // another device wrote something: this device downloads it and rebuilds
  await tick(); await tick();
  await v.tickSub("chk", "s1");      // ticked during the rebuild
  await sync;                        // the rebuild puts its copy from before the tick on screen
  assert.deepEqual(ticked(v.docs.get("chk")), []);
  await v.tickSub("chk", "s2");      // the next tick starts from that old copy ...
  assert.deepEqual(ticked(v.outbox.get("chk")), ["s2"]);   // ... and saves over the first: s1 is lost for good
});
ok("fixed: the tick made during the rebuild stays, and the next tick builds on it", async () => {
  const v = model(true);
  const sync = v.rebuild();
  await tick(); await tick();
  await v.tickSub("chk", "s1");
  await sync;
  assert.deepEqual(ticked(v.docs.get("chk")), ["s1"]);
  await v.tickSub("chk", "s2");
  assert.deepEqual(ticked(v.outbox.get("chk")), ["s1", "s2"]);
  assert.deepEqual(ticked(v.docs.get("chk")), ["s1", "s2"]);
});
ok("fixed: an edit already being saved when the rebuild started is kept too", async () => {
  const v = model(true);
  const edit = v.update("chk", { title: "Evening routine (new)" });   // started first, still encrypting
  const sync = v.rebuild();
  await Promise.all([edit, sync]);
  assert.equal(v.docs.get("chk").title, "Evening routine (new)");
});
ok("fixed: a record deleted during the rebuild does not come back on screen", async () => {
  const v = model(true);
  const w = new K.WriteWatch();
  const set = w.start();
  w.begin("todo3"); w.end("todo3");
  const built = new Map([["todo3", { title: "old" }], ["todo4", { title: "x" }]]);
  const out = K.keepWritten(built, new Map([["todo4", { title: "x" }]]), set);
  assert.equal(out.has("todo3"), false);
  assert.equal(out.get("todo4")?.title, "x");
  void v;
});

// ---------- 2. two edits of one task back to back ----------
ok("reproduced: a title change and a note change sent together, the second saved over the first", async () => {
  const v = model(false);
  await Promise.all([v.update("chk", { title: "Night routine" }), v.update("chk", { notes: "Phone away by 22:00" })]);
  const t = v.outbox.get("chk") as any;
  assert.equal(t.notes, "Phone away by 22:00");
  assert.equal(t.title, "Evening routine");   // the title change is gone
});
ok("fixed: both edits are kept, and the saved copies arrive in the order they were made", async () => {
  const v = model(true);
  await Promise.all([v.update("chk", { title: "Night routine" }), v.update("chk", { notes: "Phone away by 22:00" })]);
  const t = v.outbox.get("chk") as any;
  assert.equal(t.title, "Night routine");
  assert.equal(t.notes, "Phone away by 22:00");
});
ok("IdLane: one id waits its turn, other ids never wait", async () => {
  const lane = new K.IdLane(), log: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const a = lane.run("a", async () => { await gate; log.push("a1"); });
  const b = lane.run("a", async () => { log.push("a2"); });
  const c = lane.run("b", async () => { log.push("b1"); });
  await c;
  assert.deepEqual(log, ["b1"]);
  open();
  await Promise.all([a, b]);
  assert.deepEqual(log, ["b1", "a1", "a2"]);
  const e = lane.run("a", async () => { throw new Error("x"); });
  await assert.rejects(e);
  await lane.run("a", async () => { log.push("after"); });   // a failed step never blocks the next
  assert.equal(log.at(-1), "after");
  await tick();
  assert.equal(lane.idle("a"), true);
});

// ---------- 3. a device with an old copy (the phone after an update) ----------
// Since the phone last synced, the Mac renamed a mini task, added one, ticked one and wrote a note.
const macNow = {
  ...clone(checklist), notes: "Phone away by 22:00",
  subtasks: [sub("s1", "Stretch", true), sub("s2", "Read 20 pages"), sub("s3", "Plan tomorrow"), sub("s5", "Water the plants"), sub("s4", "Lights off")],
};
// The phone opens after the update, its reset unticks the task and starts a new round, from its old copy.
const phoneCopy = { ...clone(checklist), done: false, streak: 4, streakTicked: false };
ok("reproduced: the phone's whole old copy replaced the Mac's newer edits", () => {
  const sent = phoneCopy;   // the old way: whatever this device has goes up whole, the server keeps the last
  assert.equal((sent as any).notes, null);
  assert.deepEqual(sent.subtasks.map((s) => s.id), ["s1", "s2", "s3", "s4"]);   // s5 gone, s1 unticked, s2 renamed back
});
ok("fixed: only what the phone changed comes from its copy, the Mac's edits stay", () => {
  const out = K.mergeStale(checklist, phoneCopy, macNow) as any;
  assert.equal(out.streak, 4);
  assert.equal(out.notes, "Phone away by 22:00");
  assert.deepEqual(out.subtasks.map((s: any) => s.id), ["s1", "s2", "s3", "s5", "s4"]);
  assert.equal(out.subtasks[0].done, true);
  assert.equal(out.subtasks[1].title, "Read 20 pages");
});
ok("mergeStale: both changed the same mini task, each keeps its own field; the same field, this device wins", () => {
  const mac = { ...clone(checklist), subtasks: checklist.subtasks.map((s) => s.id === "s2" ? { ...s, title: "Read 30 pages" } : s) };
  const phone = { ...clone(checklist), subtasks: checklist.subtasks.map((s) => s.id === "s2" ? sub("s2", "Read 10 pages", true) : s) };
  const out = K.mergeStale(checklist, phone, mac) as any;
  assert.deepEqual(out.subtasks.find((s: any) => s.id === "s2"), { id: "s2", title: "Read 30 pages", done: true, doneAt: "2026-11-21T07:00:00.000Z" });
  const both = K.mergeStale({ a: 1 }, { a: 2 }, { a: 3 });
  assert.deepEqual(both, { a: 2 });
});
ok("mergeStale: a mini task deleted on one side stays deleted, even if the other side ticked it", () => {
  const mac = { ...clone(checklist), subtasks: checklist.subtasks.filter((s) => s.id !== "s3") };
  const phone = { ...clone(checklist), subtasks: checklist.subtasks.map((s) => s.id === "s3" ? sub("s3", "Plan tomorrow", true) : s) };
  assert.deepEqual((K.mergeStale(checklist, phone, mac) as any).subtasks.map((s: any) => s.id), ["s1", "s2", "s4"]);
  assert.deepEqual((K.mergeStale(checklist, mac, phone) as any).subtasks.map((s: any) => s.id), ["s1", "s2", "s4"]);
});
ok("mergeStale: added on both sides, both kept; this device's new order wins when it reordered", () => {
  const mac = { ...clone(checklist), subtasks: [...clone(checklist.subtasks), sub("m1", "Floss")] };
  const phone = { ...clone(checklist), subtasks: [sub("p1", "Tea"), ...clone(checklist.subtasks).reverse()] };
  const out = (K.mergeStale(checklist, phone, mac) as any).subtasks.map((s: any) => s.id);
  assert.deepEqual(out, ["p1", "s4", "m1", "s3", "s2", "s1"]);   // the Mac's new one right after the one it followed there
  const keep = (K.mergeStale(checklist, { ...clone(checklist), subtasks: [...clone(checklist.subtasks), sub("p2", "Tea")] }, mac) as any).subtasks.map((s: any) => s.id);
  assert.deepEqual(keep, ["s1", "s2", "s3", "s4", "p2", "m1"]);   // both kept, each after the one it followed
});
ok("mergeStale: a field this device cleared stays cleared, one the other device added is kept", () => {
  const base = { title: "A", due: "2026-11-22", est: 30 };
  const out = K.mergeStale(base, { title: "A", est: 30 }, { title: "A", due: "2026-11-22", est: 30, p1: true });
  assert.deepEqual(out, { title: "A", est: 30, p1: true });
});
ok("mergeStale: not an object anywhere, or no copy it was made on: this device's copy as before", () => {
  assert.deepEqual(K.mergeStale(null, { a: 1 }, { a: 2, b: 3 }), { a: 1 });
  assert.deepEqual(K.mergeStale({ a: 1 }, [1, 2], { a: 2 }), [1, 2]);
  assert.equal(K.mergeStale({ a: 1 }, "x", { a: 2 }), "x");
});
ok("mergeStale: the same data written in another key order counts as unchanged", () => {
  assert.equal(K.same({ a: 1, b: { c: [1, { d: 2, e: 3 }] } }, { b: { c: [1, { e: 3, d: 2 }] }, a: 1 }), true);
  assert.equal(K.same({ a: 1, b: undefined }, { a: 1 }), true);
  assert.equal(K.same([1, 2], [2, 1]), false);
  assert.equal(K.same(null, undefined), false);
  const out = K.mergeStale({ t: "x", r: { every: 2, unit: "day" } }, { t: "y", r: { unit: "day", every: 2 } }, { t: "x", r: { every: 3, unit: "day" } });
  assert.deepEqual(out, { t: "y", r: { every: 3, unit: "day" } });
});
ok("mergeStale: a list whose items have no ids, or repeated ids, is one value (this device's when both changed it)", () => {
  assert.deepEqual(K.mergeStale({ l: [1] }, { l: [1, 2] }, { l: [1, 3] }), { l: [1, 2] });
  const dup = [{ id: "a" }, { id: "a" }];
  assert.deepEqual(K.mergeStale({ l: [] }, { l: dup }, { l: [{ id: "b" }] }), { l: dup });
});
ok("the journal: a month title from one device and a note from another are both kept", () => {
  const base = { key: "m:2026-11", title: null, note: "Old note", updatedAt: "2026-11-01T10:00:00.000Z" };
  const out = K.mergeStale(base, { ...base, title: "The Comeback", updatedAt: "2026-11-21T10:00:00.000Z" }, { ...base, note: "New note", updatedAt: "2026-11-20T10:00:00.000Z" });
  assert.deepEqual(out, { key: "m:2026-11", title: "The Comeback", note: "New note", updatedAt: "2026-11-21T10:00:00.000Z" });
});
ok("checksFirst: every kind a person edits looks at the server first, machine written records never do", () => {
  for (const k of ["todo", "journal", "client", "note", "settings", "tablayout"]) assert.equal(K.checksFirst(k), true, k);
  for (const k of ["screentime", "stline", "calendar", "sjob", "sstat", "phonedev", undefined]) assert.equal(K.checksFirst(k), false, String(k));
});

// ---------- the wiring in core/vault.ts ----------
const vault = src("../src/core/vault.ts");
ok("vault.ts: put shows the new copy at once and queues the encrypted copies per record", () => {
  const put = vault.slice(vault.indexOf("export async function put<T>"), vault.indexOf("export async function remove("));
  assert.ok(put.indexOf("emit({ docs: docsMap })") < put.indexOf("C.encryptJson"), "memory first, then encrypt");
  assert.match(put, /putLane\.run\(id,/);
  assert.match(put, /writes\.begin\(id\)/);
  assert.match(put, /writes\.end\(id\)/);
  assert.match(put, /mergeStale\(existing\.data, data, o\.data\)/);
  const rm = vault.slice(vault.indexOf("export async function remove("), vault.indexOf("// ---------- sync ----------"));
  assert.match(rm, /putLane\.run\(id,/);
  assert.ok(rm.indexOf("docsMap.delete(id)") < rm.indexOf("C.encryptJson"));
});
ok("vault.ts: a rebuild keeps what was written while it ran, and an older rebuild never wins", () => {
  const rb = vault.slice(vault.indexOf("async function rebuildDocs()"), vault.indexOf("// ---------- unlock / lock ----------"));
  assert.match(rb, /writes\.start\(\)/);
  assert.match(rb, /keepWritten\(docs, snap\.docs, written\)/);
  assert.match(rb, /if \(seq < rebuiltSeq\) return;/);
});
ok("vault.ts: a newer server copy is merged into every unsent change that has the copy it was made on", () => {
  assert.match(vault, /await mergeInto\(r, old\);/);
  assert.doesNotMatch(vault, /if \(mergers\.size && outbox\.has\(r\.id\)/);
  const mi = vault.slice(vault.indexOf("async function mergeInto("), vault.indexOf("let pulling = false"));
  assert.match(mi, /mergeStale\(sent\.length \? inDoubtBase\(o\.data, sent, b\.data\) : o\.data, a\.data, b\.data\)/);
  assert.match(mi, /updated_at: remote\.updated_at/);
  assert.match(mi, /if \(outbox\.get\(remote\.id\) !== mine\) return;/);
  assert.match(vault, /mergers\.has\(k\) \|\| \(!r\.deleted && r\.updated_at !== null && checksFirst\(k\)\)/);
});

// ---------- the Year view's month titles ----------
ok("the Tab list's Map gets the journal: a title typed there no longer looks deleted when the map opens again", () => {
  const ps = src("../src/ps.ts");
  const send = ps.slice(ps.indexOf("const send = () => {"), ps.indexOf("if (cal) docs.push(cal);"));
  assert.match(send, /d\.kind === "journal"/);
});
ok("journalByKey: two records for one month, the newest wins (never whichever came last)", () => {
  const d = (id: string, title: string | null, at: string) => ({ id, ws: null, kind: "journal", author: null, updatedAt: at, data: { key: "m:2026-03", title, note: null, updatedAt: at } }) as any;
  const newest = d("jb", "Spring", "2026-11-21T10:00:00.000Z"), old = d("ja", null, "2026-11-20T10:00:00.000Z");
  assert.equal(K.journalByKey([newest, old]).get("m:2026-03")?.id, "jb");
  assert.equal(K.journalByKey([old, newest]).get("m:2026-03")?.id, "jb");
  assert.equal(K.journalByKey([{ ...old, data: null } as any, newest]).size, 1);
});
ok("setJournal: one save at a time, a second record for the same key folded in without losing its words", () => {
  const a = src("../src/core/actions.ts");
  const sj = a.slice(a.indexOf("let journalLane"), a.indexOf("// ---------- screen time"));
  assert.match(sj, /journalLane\.then\(run, run\)/);
  assert.match(sj, /for \(const d of extra\) await remove\(d\.id\)/);
  assert.match(sj, /extra\.map\(\(d\) => d\.data\[f\]\)/);
});
ok("the map: Esc saves what is being typed first, and a saved copy coming back never replaces typing", () => {
  const m = src("../src/views/SeriesMap.tsx");
  const esc = m.slice(m.indexOf("const key = (e: KeyboardEvent)"), m.indexOf("document.addEventListener(\"keydown\", key)"));
  assert.ok(esc.indexOf(".blur?.()") > -1 && esc.indexOf(".blur?.()") < esc.indexOf("onClose()"));
  assert.match(m, /if \(!typing\.current\) setV\(saved\)/);
  assert.match(m, /if \(!typing\.current \|\| shownKey\.current !== k\) setV\(saved\)/);
});

// ---------- mini tasks one by one ----------
ok("removing one mini task keeps every other one, and Undo puts it back in its place", () => {
  const list = clone(checklist.subtasks);
  const out = Sub.applySubOp(list, { op: "remove", id: "s2" }, "2026-11-21T20:00:00.000Z");
  assert.deepEqual(out.map((s) => s.id), ["s1", "s3", "s4"]);
  const back = Sub.applySubOp(out, { op: "restore", item: list[1], index: 1 }, "2026-11-21T20:00:00.000Z");
  assert.deepEqual(back.map((s) => s.id), ["s1", "s2", "s3", "s4"]);
  assert.deepEqual(Sub.cleanSubOp({ op: "remove", id: "s2" }), { op: "remove", id: "s2" });
});
// The mini task's own right click menu is PS 1.73's (Red, tests/mini-delete.test.ts).

for (const [name, fn] of tests) { await fn(); n++; console.log("ok -", name); }
console.log(`\n${n} passed`);
