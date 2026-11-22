// Run: node --experimental-strip-types tests/keep-my-edits-sync.test.ts
// PS 1.74 keep my edits, break-it round 1 (21 Nov 2026). Each case asserts the CORRECT outcome. The vault model below copies
// put(), mergeInto() and the pull/flush steps of core/vault.ts line for line, with the real helpers from core/keepedits.ts
// and fake async crypto (no network, no Supabase). fixed=false is the first 1.73 cut (37ea776), so every loss is shown
// reproduced first. The last cases check that core/vault.ts really has the fixed lines. FICTIONAL data only.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const K = await import("../src/core/keepedits.ts");
const D = await import("../src/core/dimxmove.ts");

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Row = { id: string; ct: string; deleted: boolean; updated_at: string | null; sent?: string[]; past?: string[] };
type Doc = { id: string; kind: string; data: any; updatedAt: string | null; pending?: boolean };

let FIXED = true;   // the reproduction pass at the end runs the loss cases on the first cut
function vault(opt: { dec?: number; enc?: number; fixed?: boolean } = {}) {
  const fixed = opt.fixed ?? FIXED;
  let n = 0, clock = 1;
  const stamp = () => `2026-11-21T10:00:${String(clock++).padStart(2, "0")}.000000+00:00`;
  const rows = new Map<string, Row>(), outbox = new Map<string, Row>(), server = new Map<string, Row>();
  let docs = new Map<string, Doc>();
  const lane = new K.IdLane(), writes = new K.WriteWatch();
  const encrypt = async (kind: string, data: unknown) => { await wait(opt.enc ?? 0); return JSON.stringify({ n: n++, kind, data }); };
  const decryptRow = async (r: Row) => { await wait(opt.dec ?? 0); if (r.deleted) return null; const p = JSON.parse(r.ct); return { id: r.id, kind: p.kind, data: p.data, updatedAt: r.updated_at }; };
  // the server (Postgres now() on every write)
  const commit = (r: Row) => { const s = { ...r, updated_at: stamp() }; server.set(r.id, s); return s; };
  async function seed(id: string, kind: string, data: unknown) {
    const s = commit({ id, ct: await encrypt(kind, data), deleted: false, updated_at: null });
    rows.set(id, s); docs.set(id, { id, kind, data: clone(data), updatedAt: s.updated_at });
  }
  // core/vault.ts put(), 1291-1325
  async function put(kind: string, id: string, data: any) {
    const existing = docs.get(id), base = existing?.updatedAt ?? null;
    docs = new Map(docs);
    const shown: Doc = { id, kind, data, updatedAt: base, pending: true };
    docs.set(id, shown);
    writes.begin(id);
    try {
      await lane.run(id, async () => {
        let out: unknown = data, made = base;
        const prev = outbox.get(id), row = rows.get(id);
        const newer = (r: Row | undefined) => !!r && !r.deleted && r.updated_at !== null && (base === null || r.updated_at > base);
        const other = prev ? (newer(prev) ? prev : undefined) : newer(row) ? row : undefined;
        if (existing && other && K.checksFirst(kind)) {
          const o = await decryptRow(other);
          if (o && o.kind === kind) { out = K.mergeStale(existing.data, data, o.data); made = other.updated_at; }
        }
        const ct = await encrypt(kind, out);
        outbox.set(id, { id, ct, deleted: false, updated_at: made, ...(fixed ? K.carrySent(outbox.get(id)) : {}) });
        if (out !== data && docs.get(id) === shown) { docs = new Map(docs); docs.set(id, { ...shown, data: out, updatedAt: made }); }
      });
    } finally { writes.end(id); }
  }
  // core/vault.ts mergeInto() as fixed: in the record's lane, this device's own send never merged (no merger kinds)
  async function mergeInto(remote: Row, base?: Row) {
    if (!fixed) return mergeIntoOld(remote, base);
    await lane.run(remote.id, async () => {
      const mine = outbox.get(remote.id);
      if (!mine || mine.deleted || mine.ct === remote.ct) return;
      const inDoubt = [...(mine.sent ?? [])];
      const own = inDoubt.includes(remote.ct) || !!mine.past?.includes(remote.ct);
      const a = await decryptRow(mine);
      if (!a) return;
      if (own) {
        if (outbox.get(remote.id) === mine) outbox.set(a.id, { ...mine, updated_at: remote.updated_at, ...K.sentAfterOwn(mine, remote.ct) });
        return;
      }
      const b = await decryptRow(remote);
      if (!b || a.kind !== b.kind) return;
      if (!K.checksFirst(a.kind) || !base || base.deleted) return;
      const o = await decryptRow(base);
      if (!o || o.kind !== a.kind) return;
      const sent: unknown[] = [], seen: string[] = [];
      for (const ct of inDoubt) { const x = await decryptRow({ ...mine, ct }); if (x && x.kind === a.kind) { sent.push(x.data); if (K.landedIn(o.data, x.data, b.data)) seen.push(ct); } }
      const data = K.mergeStale(sent.length ? K.inDoubtBase(o.data, sent, b.data) : o.data, a.data, b.data);
      const ct = await encrypt(a.kind, data);
      if (outbox.get(remote.id) !== mine) return;
      outbox.set(a.id, { ...mine, ct, updated_at: remote.updated_at, ...K.sentAfterMerge(mine, seen) });
      const cur = writes.busyWith(a.id) ? undefined : docs.get(a.id);
      if (cur) { docs = new Map(docs); docs.set(a.id, { ...cur, data, updatedAt: remote.updated_at, pending: true }); }
    });
  }
  // the first 1.73 cut (37ea776)
  async function mergeIntoOld(remote: Row, base?: Row) {
    for (let tries = 0; tries < 3; tries++) {
      const mine = outbox.get(remote.id);
      if (!mine || mine.deleted || mine.ct === remote.ct) return;
      const a = await decryptRow(mine), b = await decryptRow(remote);
      if (!a || !b || a.kind !== b.kind) return;
      if (!K.checksFirst(a.kind) || !base || base.deleted) return;
      const o = await decryptRow(base);
      if (!o || o.kind !== a.kind) return;
      const data = K.mergeStale(o.data, a.data, b.data);
      const ct = await encrypt(a.kind, data);
      if (outbox.get(remote.id) !== mine) continue;
      outbox.set(a.id, { ...mine, ct, updated_at: remote.updated_at });
      const cur = lane.idle(a.id) ? docs.get(a.id) : undefined;
      if (cur) { docs = new Map(docs); docs.set(a.id, { ...cur, data, updatedAt: remote.updated_at, pending: true }); }
      return;
    }
  }
  // core/vault.ts pullRecords() inner loop, 1646-1659: fetch every server row that differs from rows
  async function pull() {
    for (const r of [...server.values()]) {
      const old = rows.get(r.id);
      if (old && old.updated_at === r.updated_at && old.deleted === r.deleted) continue;
      rows.set(r.id, r);
      const mine = outbox.get(r.id), kind = docs.get(r.id)?.kind;
      if (!fixed) {
        if (mine && D.staleEditOfDeleted(kind, { deleted: mine.deleted, base: mine.updated_at }, r)) outbox.delete(r.id);
        if (outbox.has(r.id) && !r.deleted && (!old || old.ct !== r.ct)) await mergeInto(r, old);
        continue;
      }
      if (mine && K.staleEditGone(kind, false, { deleted: mine.deleted, base: mine.updated_at }, r)) outbox.delete(r.id);
      if ((outbox.has(r.id) || !lane.idle(r.id)) && !r.deleted && (!old || old.ct !== r.ct)) await mergeInto(r, old);
    }
  }
  // core/vault.ts flush(): upsert, the answer has the server time; lost=true is a request past its limit (committed, no answer)
  // lost=true: committed, answer lost. fail=true: a network error before the server, nothing committed.
  function flush(lost = false, fail = false) {
    for (const r of [...outbox.values()]) {
      if (fixed) K.markSent(r);
      if (fail) continue;
      const s = commit({ ...r, sent: undefined });
      if (lost) continue;
      const o = outbox.get(r.id);
      if (o?.ct === r.ct) outbox.delete(r.id);
      else if (o && fixed) K.settleSent(o, r.ct);
      rows.set(r.id, s);
      const d = docs.get(r.id); if (d) d.updatedAt = s.updated_at, d.pending = outbox.has(r.id);
    }
  }
  const remote = async (id: string, kind: string, data: unknown, deleted = false) => commit({ id, ct: await encrypt(kind, data), deleted, updated_at: null });
  const reload = () => { for (const [k, r] of [...outbox]) outbox.set(k, clone(r)); };   // the outbox comes back from storage
  const remoteNow = (id: string, kind: string, data: unknown) => commit({ id, ct: JSON.stringify({ n: n++, kind, data }), deleted: false, updated_at: null });
  const serverData = (id: string) => { const s = server.get(id)!; return s.deleted ? null : JSON.parse(s.ct).data; };
  const outData = (id: string) => JSON.parse(outbox.get(id)!.ct).data;
  return { put, pull, flush, seed, remote, remoteNow, reload, serverData, outData, outbox, rows, get docs() { return docs; } };
}

const sub = (id: string, title: string, done = false) => ({ id, title, done });
const task = () => ({ title: "Evening routine", done: false, notes: null as string | null, subtasks: [sub("s1", "Stretch"), sub("s2", "Read")] });
const tests: [string, () => unknown][] = [];
const ok = (name: string, fn: () => unknown) => tests.push([name, fn]);

// ---------- A. this device's own earlier save comes back as "the server's newer copy" ----------
ok("A1 tick then untick: the first save's answer was lost (request past its limit), the untick must survive", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...v.docs.get("t")!.data, subtasks: [sub("s1", "Stretch", true), sub("s2", "Read")] });   // tick s1
  v.flush(true);                                                                          // committed, answer lost
  await v.put("todo", "t", { ...v.docs.get("t")!.data, subtasks: [sub("s1", "Stretch"), sub("s2", "Read")] });       // untick s1
  await v.pull();                                     // the next sync downloads this device's own tick as a "newer copy"
  v.flush();
  assert.equal(v.serverData("t").subtasks[0].done, false, "the untick was undone by this device's own earlier save");
});
ok("A2 add a mini task then delete it, first save's answer lost: it must stay deleted", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...v.docs.get("t")!.data, subtasks: [...task().subtasks, sub("s9", "Typo task")] });
  v.flush(true);
  await v.put("todo", "t", { ...v.docs.get("t")!.data, subtasks: task().subtasks });
  await v.pull();
  v.flush();
  assert.deepEqual(v.serverData("t").subtasks.map((s: any) => s.id), ["s1", "s2"], "deleted mini task came back");
});
ok("A3 same for a note's text set back: an edit reverted to the old text must stay reverted", async () => {
  const v = vault();
  await v.seed("n", "note", { text: "draft one" });
  await v.put("note", "n", { text: "draft two" });
  v.flush(true);
  await v.put("note", "n", { text: "draft one" });
  await v.pull();
  v.flush();
  assert.equal(v.serverData("n").text, "draft one");
});

// ---------- B. mergeInto and a put of the same record overlap ----------
ok("B1 a put that starts while mergeInto encrypts overwrites the merge: the other device's note is lost", async () => {
  const v = vault({ dec: 5, enc: 20 });
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...v.docs.get("t")!.data, title: "Night routine" });     // pending edit, base V1
  await v.remote("t", "todo", { ...task(), notes: "Phone away by 22:00" });            // the Mac wrote a note
  const p = v.pull();                                  // mergeInto: 3 decrypts (15 ms), then encrypt (20 ms)
  await wait(20);
  const q = v.put("todo", "t", { ...v.docs.get("t")!.data, done: true });             // ticked meanwhile
  await Promise.all([p, q]);
  await v.pull();                                      // nothing new on the server: no second chance to merge
  v.flush();
  const s = v.serverData("t");
  assert.equal(s.done, true);
  assert.equal(s.title, "Night routine");
  assert.equal(s.notes, "Phone away by 22:00", "the other device's note was overwritten by the whole local copy");
});

// ---------- C. deletes ----------
ok("C1 a note deleted on another device while this one has an unsent edit must not come back", async () => {
  const v = vault();
  await v.seed("n", "note", { text: "old" });
  await v.put("note", "n", { text: "edited here" });
  await v.remote("n", "note", null, true);
  await v.pull();
  v.flush();
  assert.equal(v.serverData("n"), null, "the deleted note was brought back (staleEditOfDeleted is todo only)");
});

ok("B2 a download landing while a put is still encrypting is merged once the put is in the outbox", async () => {
  const v = vault({ enc: 20 });
  await v.seed("t", "todo", task());
  const q = v.put("todo", "t", { ...v.docs.get("t")!.data, title: "Night routine" });   // reads rows, then encrypts
  await wait(2);
  v.remoteNow("t", "todo", { ...task(), notes: "Phone away by 22:00" });               // the Mac wrote a note
  await Promise.all([q, v.pull()]);                                                    // downloaded while the put encrypts
  v.flush();
  const s = v.serverData("t");
  assert.equal(s.title, "Night routine");
  assert.equal(s.notes, "Phone away by 22:00", "the note was replaced by the copy the put started from");
});
ok("C2 a task deleted elsewhere still drops this device's stale edit; an edit with no server copy (Undo of a delete) stays", () => {
  assert.equal(K.staleEditGone("todo", false, { deleted: false, base: "a" }, { deleted: true, updated_at: "b" }), true);
  assert.equal(K.staleEditGone("note", false, { deleted: false, base: "a" }, { deleted: true, updated_at: "b" }), true);
  assert.equal(K.staleEditGone("note", false, { deleted: false, base: null }, { deleted: true, updated_at: "b" }), false);
  assert.equal(K.staleEditGone("settings", true, { deleted: false, base: "a" }, { deleted: true, updated_at: "b" }), false, "own merger: as before");
  assert.equal(K.staleEditGone("screentime", false, { deleted: false, base: "a" }, { deleted: true, updated_at: "b" }), false, "machine kinds: as before");
  assert.equal(K.staleEditGone("note", false, { deleted: false, base: "b" }, { deleted: true, updated_at: "b" }), false, "this device's own delete answer");
});
ok("S1 tick (answer lost), untick, another device writes notes on top of the tick, pull: the untick and the notes both stay", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...v.docs.get("t")!.data, done: true });
  v.flush(true);
  await v.put("todo", "t", { ...v.docs.get("t")!.data, done: false });
  await v.remote("t", "todo", { ...task(), done: true, notes: "from phone" });   // the phone built on the tick
  await v.pull(); v.flush();
  assert.deepEqual([v.serverData("t").done, v.serverData("t").notes], [false, "from phone"]);
});
ok("S2 tick (answer lost), untick whose send fails offline, pull: the untick stays (every sent copy is known)", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...v.docs.get("t")!.data, done: true });
  v.flush(true);
  await v.put("todo", "t", { ...v.docs.get("t")!.data, done: false });
  v.flush(false, true);
  await v.pull(); v.flush();
  assert.equal(v.serverData("t").done, false);
});
ok("S3 tick (answer lost), untick, PS reloads, pull: the untick stays (kept with the outbox)", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...v.docs.get("t")!.data, done: true });
  v.flush(true);
  await v.put("todo", "t", { ...v.docs.get("t")!.data, done: false });
  v.reload();
  await v.pull(); v.flush();
  assert.equal(v.serverData("t").done, false);
});
ok("S5 a send that never arrived (network error), then another device edits: this device's change is kept", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...v.docs.get("t")!.data, title: "Night routine" });
  v.flush(false, true);                                                          // never reached the server
  await v.remote("t", "todo", { ...task(), notes: "from phone" });               // built on the old copy
  await v.pull(); v.flush();
  assert.deepEqual([v.serverData("t").title, v.serverData("t").notes], ["Night routine", "from phone"]);
});
ok("inDoubtBase and markSent: field by field, every copy kept in order, at most 8", () => {
  const old = { a: 1, b: 1, c: 1 }, sent = { a: 2, b: 2, c: 1 }, remote = { a: 1, b: 3, c: 4 };
  assert.deepEqual(K.inDoubtBase(old, [sent], { a: 1, b: 2, c: 4 }), { a: 1, b: 2, c: 1 });
  assert.deepEqual(K.inDoubtBase(old, [sent], remote), old, "the server has none of what was sent: the old copy");
  assert.equal(K.inDoubtBase(null, [sent], remote), null);
  assert.deepEqual(K.inDoubtBase(old, [], remote), old);
  const r: { ct: string; sent?: string[] } = { ct: "x1" };
  K.markSent(r); K.markSent(r); r.ct = "x2"; K.markSent(r);
  assert.deepEqual(r.sent, ["x1", "x2"]);
  assert.equal(K.isOwnSent(r, "x1"), true);
  assert.equal(K.isOwnSent(r, "x3"), false);
  assert.equal(K.isOwnSent(undefined, "x1"), false);
  for (let i = 3; i < 20; i++) { r.ct = `x${i}`; K.markSent(r); }
  assert.equal(r.sent!.length, 8);
});
ok("J1 a journal record folded away on another device keeps this device's newer unsent title (newest wins on screen)", () => {
  assert.equal(K.staleEditGone("journal", false, { deleted: false, base: "a" }, { deleted: true, updated_at: "b" }), false);
});
ok("core/vault.ts has the fixed lines (mergeInto in the lane, own sends recognised, every kind's deletes, probe only when sendable)", () => {
  const v = readFileSync(new URL("../src/core/vault.ts", import.meta.url), "utf8");
  for (const line of [
    "await putLane.run(remote.id, async () => {",
    "if (!fn && own) {",
    "const own = inDoubt.includes(remote.ct) || !!mine.past?.includes(remote.ct);",
    "inDoubtBase(o.data, sent, b.data)",
    "updated_at: remote.updated_at, ...sentAfterMerge(mine, seen) });",
    "else if (sent) settleSent(sent, r.ct);",
    "if ((outbox.has(r.id) || !putLane.idle(r.id)) && !r.deleted && (!old || old.ct !== r.ct)) await mergeInto(r, old);",
    "staleEditGone(kind, !!kind && mergers.has(kind)",
    "for (const r of list) if (outbox.get(r.id) === r) markSent(r);",
    "...carrySent(outbox.get(id)) });",
    "&& sendable(outbox.values(), held, Date.now()).length) await pull();",
  ]) assert.ok(v.includes(line), line);
  assert.ok(!v.includes("for (let tries = 0; tries < 3; tries++)"), "the retry loop that gave up silently is gone");
  assert.ok(!/[\u2013\u2014]/.test(v));
});

// ---------- controls: the same steps without the trigger pass (so the failures above are the trigger) ----------
ok("control A: tick then untick with the answer received keeps the untick", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...v.docs.get("t")!.data, subtasks: [sub("s1", "Stretch", true), sub("s2", "Read")] });
  v.flush();
  await v.put("todo", "t", { ...v.docs.get("t")!.data, subtasks: [sub("s1", "Stretch"), sub("s2", "Read")] });
  await v.pull(); v.flush();
  assert.equal(v.serverData("t").subtasks[0].done, false);
});
ok("control B: the same merge with no put overlapping keeps the other device's note", async () => {
  const v = vault({ dec: 5, enc: 20 });
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...v.docs.get("t")!.data, title: "Night routine" });
  await v.remote("t", "todo", { ...task(), notes: "Phone away by 22:00" });
  await v.pull();
  await v.put("todo", "t", { ...v.docs.get("t")!.data, done: true });
  v.flush();
  assert.equal(v.serverData("t").notes, "Phone away by 22:00");
});

// ---------- reproduced: the same loss cases on the first 1.73 cut (37ea776) fail ----------
const LOSS = ["A1", "A2", "A3", "B1", "B2", "C1", "S1", "S2", "S3"];
for (const [name, fn] of [...tests].filter(([n]) => LOSS.some((x) => n.startsWith(x + " ")))) {
  ok(`reproduced on the first cut: ${name.slice(0, 2)}`, async () => {
    FIXED = false;
    try { await assert.rejects(async () => { await fn(); }); } finally { FIXED = true; }
  });
}

let pass = 0; const fails: string[] = [];
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log("ok -", name); }
  catch (e) { fails.push(name); console.log("FAIL -", name, "::", (e as Error).message.split("\n")[0]); }
}
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) process.exitCode = 1;
