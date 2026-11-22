// Run: node --experimental-strip-types tests/keep-my-edits-doubt.test.ts
// PS 1.74 keep my edits, break-it round 3 (21 Nov 2026): sends in doubt (sent copies on the outbox row, inDoubtBase). Each
// case asserts the CORRECT outcome. The model copies put(), mergeInto(), pull and flush of core/vault.ts as in
// tests/keep-my-edits-sync.test.ts (fixed path only), with the send split into request and answer. FICTIONAL data only.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const K = await import("../src/core/keepedits.ts");
const { withSubOp } = await import("../src/core/subtasks.ts");

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Row = { id: string; ct: string; deleted: boolean; updated_at: string | null; sent?: string[]; past?: string[] };
type Doc = { id: string; kind: string; data: any; updatedAt: string | null; pending?: boolean };

function vault(opt: { dec?: number } = {}) {
  let n = 0, clock = 1;
  const stamp = () => `2026-11-21T10:00:${String(clock++).padStart(2, "0")}.000000+00:00`;
  const rows = new Map<string, Row>(), outbox = new Map<string, Row>(), server = new Map<string, Row>();
  let docs = new Map<string, Doc>();
  const lane = new K.IdLane(), writes = new K.WriteWatch();
  const encrypt = async (kind: string, data: unknown) => JSON.stringify({ n: n++, kind, data });
  const decryptRow = async (r: Row) => { await wait(opt.dec ?? 0); if (r.deleted) return null; const p = JSON.parse(r.ct); return { id: r.id, kind: p.kind, data: p.data, updatedAt: r.updated_at }; };
  const commit = (r: Row) => { const s = { id: r.id, ct: r.ct, deleted: r.deleted, updated_at: stamp() }; server.set(r.id, s); return s; };
  async function seed(id: string, kind: string, data: unknown) {
    const s = commit({ id, ct: await encrypt(kind, data), deleted: false, updated_at: null });
    rows.set(id, s); docs.set(id, { id, kind, data: clone(data), updatedAt: s.updated_at });
  }
  async function put(kind: string, id: string, data: any) {   // vault.ts put 1309-1320
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
        outbox.set(id, { id, ct, deleted: false, updated_at: made, ...K.carrySent(outbox.get(id)) });
        if (out !== data && docs.get(id) === shown) { docs = new Map(docs); docs.set(id, { ...shown, data: out, updatedAt: made }); }
      });
    } finally { writes.end(id); }
  }
  async function mergeInto(remote: Row, base?: Row) {   // vault.ts mergeInto 1687-1724
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
  async function pull() {   // vault.ts pullRecords inner loop
    for (const r of [...server.values()]) {
      const old = rows.get(r.id);
      if (old && old.updated_at === r.updated_at && old.deleted === r.deleted) continue;
      rows.set(r.id, r);
      const mine = outbox.get(r.id), kind = docs.get(r.id)?.kind;
      if (mine && K.staleEditGone(kind, false, { deleted: mine.deleted, base: mine.updated_at }, r)) outbox.delete(r.id);
      if ((outbox.has(r.id) || !lane.idle(r.id)) && !r.deleted && (!old || old.ct !== r.ct)) await mergeInto(r, old);
    }
  }
  // vault.ts flush send(): markSent, then the request. arrives=false: never reached the server (eg a flaky network).
  function request(arrives: boolean) {
    const out: Row[] = [];
    for (const r of [...outbox.values()]) { K.markSent(r); if (arrives) out.push(commit(r)); }
    return out;
  }
  function answer(list: Row[]) {   // vault.ts flush 1433-1441
    for (const s of list) {
      const o = outbox.get(s.id);
      if (o && o.ct === s.ct) outbox.delete(s.id);
      else if (o) K.settleSent(o, s.ct);
      rows.set(s.id, s);
      const d = docs.get(s.id); if (d) d.updatedAt = s.updated_at, d.pending = outbox.has(s.id);
    }
  }
  function flushAll() { answer(request(true)); }
  // Round 4: the request goes out now (markSent) and reaches the server later (the returned function commits it).
  function requestLater() {
    const list = [...outbox.values()];
    for (const r of list) K.markSent(r);
    return () => list.map((r) => commit(r));
  }
  const other = async (id: string, kind: string, data: unknown) => commit({ id, ct: await encrypt(kind, data), deleted: false, updated_at: null });
  const serverData = (id: string) => JSON.parse(server.get(id)!.ct).data;
  return { put, pull, request, requestLater, answer, flushAll, seed, other, serverData, outbox, rows, get docs() { return docs; } };
}

const sub = (id: string, title: string, done = false) => ({ id, title, done });
const task = () => ({ title: "Evening routine", done: false, subtasks: [sub("s1", "Stretch"), sub("s2", "Read")] });
const tests: [string, () => unknown][] = [];
const ok = (name: string, fn: () => unknown) => tests.push([name, fn]);

ok("X1 a mini task added on a flaky send that never arrived is lost when another device ticks another one", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...task(), subtasks: [...task().subtasks, sub("s3", "Journal")] });
  v.request(false);                                                  // network error: marked in doubt, never committed
  await v.other("t", "todo", { ...task(), subtasks: [sub("s1", "Stretch", true), sub("s2", "Read")] });
  await v.pull();
  v.flushAll();
  assert.deepEqual(v.serverData("t").subtasks.map((s: any) => s.id), ["s1", "s2", "s3"], "s3 added on this device was dropped");
});
ok("X2 a mini task deleted on a send that never arrived comes back when another device ticks it", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...task(), subtasks: [sub("s1", "Stretch")] });     // delete s2
  v.request(false);
  await v.other("t", "todo", { ...task(), subtasks: [sub("s1", "Stretch"), sub("s2", "Read", true)] });
  await v.pull();
  v.flushAll();
  assert.deepEqual(v.serverData("t").subtasks.map((s: any) => s.id), ["s1"], "deleted s2 came back");
});
ok("X3 two sends in doubt, the server built on the older one: the newest title is dropped (only the last sent copy is used)", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...task(), title: "Morning routine" });
  const c1 = v.request(true);                                         // committed, answer lost
  await v.put("todo", "t", { ...task(), title: "Night routine" });
  v.request(false);                                                    // never arrived
  void c1;
  await v.other("t", "todo", { ...task(), title: "Morning routine", done: true });   // other device built on c1
  await v.pull();
  v.flushAll();
  const s = v.serverData("t");
  assert.equal(s.done, true);
  assert.equal(s.title, "Night routine", "this device's newest title was set back to the older in-doubt one");
});
ok("X4 a title changed on a send that never arrived is kept against a concurrent change (this device wins, as before)", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...task(), title: "Mine" });
  v.request(false);
  await v.other("t", "todo", { ...task(), title: "Theirs" });
  await v.pull();
  v.flushAll();
  assert.equal(v.serverData("t").title, "Mine");
});
ok("X5 the answer lands while a merge is in its lane: delete sent.sent makes it merge from the stale base, the untick is undone", async () => {
  const v = vault({ dec: 4 });
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...task(), subtasks: [sub("s1", "Stretch", true), sub("s2", "Read")] });   // tick
  const inflight = v.request(true);                                   // committed, answer still on its way
  await v.put("todo", "t", { ...task(), subtasks: task().subtasks });                                 // untick, carries sent
  await v.other("t", "todo", { ...task(), title: "Evening routine 2", subtasks: [sub("s1", "Stretch", true), sub("s2", "Read")] });
  const p = v.pull();
  await wait(6);                                                      // the merge is decrypting
  v.answer(inflight);                                                 // flush's answer: delete o.sent in place
  await p;
  v.flushAll();
  const s = v.serverData("t");
  assert.equal(s.title, "Evening routine 2");
  assert.equal(s.subtasks[0].done, false, "the untick was undone");
});

ok("X6 a tick that arrived (answer lost), then an untick; another device built on the tick and ticks another mini task: both stay", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...task(), subtasks: [sub("s1", "Stretch", true), sub("s2", "Read")] });
  v.request(true);                                                    // committed, answer lost
  await v.put("todo", "t", { ...task(), subtasks: task().subtasks });  // untick s1
  await v.other("t", "todo", { ...task(), subtasks: [sub("s1", "Stretch", true), sub("s2", "Read", true)] });
  await v.pull();
  v.flushAll();
  assert.deepEqual(v.serverData("t").subtasks.map((x: any) => x.done), [false, true]);
});

ok("X7 a send in flight while another device's copy is merged, landing after it with its answer lost: the other device's tick stays", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...task(), title: "Morning routine" });
  const land = v.requestLater();                                      // S1 on its way
  await v.other("t", "todo", { ...task(), subtasks: [sub("s1", "Stretch", true), sub("s2", "Read")] });   // B lands first
  await v.pull();                                                     // B merged into the unsent copy
  land();                                                             // S1 reaches the server after B, its answer is lost
  await v.pull();                                                     // S1 comes down: this device's own send, not another's
  v.flushAll();
  const s = v.serverData("t");
  assert.equal(s.title, "Morning routine");
  assert.equal(s.subtasks[0].done, true, "the other device's tick was undone by this device's own in-flight send");
});
ok("X8 same, but S1 reached the server before B: both changes stay", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...task(), title: "Morning routine" });
  const land = v.requestLater();
  land();                                                             // S1 first, answer lost
  await v.other("t", "todo", { ...task(), title: "Morning routine", subtasks: [sub("s1", "Stretch", true), sub("s2", "Read")] });
  await v.pull();
  await v.put("todo", "t", { ...v.docs.get("t")!.data, done: true });
  await v.pull();
  v.flushAll();
  const s = v.serverData("t");
  assert.deepEqual([s.title, s.subtasks[0].done, s.done], ["Morning routine", true, true]);
});

// Round 4: Red's PS 1.73 writes (delete one mini task and its Undo, p1Since, the Clients checklist) through the merge.
const T0 = "2026-11-21T09:00:00.000Z";
const ids = (v: ReturnType<typeof vault>) => v.serverData("t").subtasks.map((x: any) => `${x.id}${x.done ? "+" : ""}:${x.title}`).join(" ");
ok("R1 a mini task deleted here, ticked and renamed on another device: it stays deleted, the rest of the task is kept", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  await v.put("todo", "t", withSubOp(v.docs.get("t")!.data, { op: "remove", id: "s2" }, T0));
  await v.other("t", "todo", { ...task(), title: "Evening", subtasks: [sub("s1", "Stretch"), sub("s2", "Read a book", true)] });
  await v.pull();
  v.flushAll();
  assert.equal(ids(v), "s1:Stretch");
  assert.equal(v.serverData("t").title, "Evening");
});
ok("R2 delete then Undo while the delete's send is in doubt (it arrived, answer lost), another device ticks s1 on the deleted copy: s1 ticked, s2 back", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  const item = task().subtasks[1];
  await v.put("todo", "t", withSubOp(v.docs.get("t")!.data, { op: "remove", id: "s2" }, T0));
  v.request(true);                                                    // arrived, answer lost
  await v.put("todo", "t", withSubOp(v.docs.get("t")!.data, { op: "restore", item, index: 1 }, T0));
  await v.other("t", "todo", { ...task(), subtasks: [sub("s1", "Stretch", true)] });
  await v.pull();
  v.flushAll();
  assert.equal(ids(v), "s1+:Stretch s2:Read");
});
ok("R3 delete on its way, Undo while it is in flight, another device ticks s1 on the old copy first, the delete lands after it with its answer lost", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  const item = task().subtasks[1];
  await v.put("todo", "t", withSubOp(v.docs.get("t")!.data, { op: "remove", id: "s2" }, T0));
  const land = v.requestLater();
  await v.put("todo", "t", withSubOp(v.docs.get("t")!.data, { op: "restore", item, index: 1 }, T0));
  await v.other("t", "todo", { ...task(), subtasks: [sub("s1", "Stretch", true), sub("s2", "Read")] });
  await v.pull();
  land();
  await v.pull();
  v.flushAll();
  assert.equal(ids(v), "s1+:Stretch s2:Read");
});
ok("R4 delete, Undo, both sent; then an old device (copy from before both) renames the task: s2 stays", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  const old = v.rows.get("t")!;
  const item = task().subtasks[1];
  await v.put("todo", "t", withSubOp(v.docs.get("t")!.data, { op: "remove", id: "s2" }, T0));
  v.flushAll();
  await v.put("todo", "t", withSubOp(v.docs.get("t")!.data, { op: "restore", item, index: 1 }, T0));
  v.flushAll();
  // The old device's change, merged the way it would be there (mergeStale against its own old copy).
  const merged = K.mergeStale(JSON.parse(old.ct).data, { ...task(), title: "Night" }, v.serverData("t"));
  assert.equal((merged as any).subtasks.map((x: any) => x.id).join(), "s1,s2");
  assert.equal((merged as any).title, "Night");
});
ok("R5 an old device stamps p1Since on its old copy (core/duealerts.ts p1OwnStamps): the other device's title and tick are kept", async () => {
  const v = vault();
  await v.seed("t", "todo", { ...task(), p1: true });
  await v.other("t", "todo", { ...task(), p1: true, title: "Evening 2", subtasks: [sub("s1", "Stretch", true), sub("s2", "Read")] });
  await v.put("todo", "t", { ...v.docs.get("t")!.data, p1Since: T0 });   // updateTodo on the old copy
  await v.pull();
  v.flushAll();
  const s = v.serverData("t");
  assert.deepEqual([s.title, s.subtasks[0].done, s.p1Since], ["Evening 2", true, T0]);
});
ok("R6 the Clients checklist (pprivate) merges item by item: a tick here, an edit and a new item on another device", async () => {
  const v = vault();
  const c = (id: string, text: string, done = false) => ({ id, text, done, at: null });
  const pp = { projectId: "p", history: [], checklist: [c("c1", "Brief"), c("c2", "Mockup")] };
  await v.seed("t", "pprivate", pp);
  await v.put("pprivate", "t", { ...pp, checklist: [c("c1", "Brief", true), c("c2", "Mockup")] });
  await v.other("t", "pprivate", { ...pp, checklist: [c("c1", "Brief"), c("c2", "Mockups v2"), c("c3", "Invoice")] });
  await v.pull();
  v.flushAll();
  assert.deepEqual(v.serverData("t").checklist.map((x: any) => `${x.id}${x.done ? "+" : ""}:${x.text}`), ["c1+:Brief", "c2:Mockups v2", "c3:Invoice"]);
});
ok("R7 a project's history (newest first, no ids): a line added on an old device keeps the lines added since on another", async () => {
  const v = vault();
  const h = (text: string) => ({ date: "2026-11-21", text });
  const pp = { projectId: "p", history: [h("Project created")] };
  await v.seed("t", "pprivate", pp);
  await v.put("pprivate", "t", { ...pp, nextStep: "Send mockups", history: [h("Moved to design"), ...pp.history] });
  await v.other("t", "pprivate", { ...pp, history: [h("Moved to build"), h("Invoice sent"), ...pp.history] });
  await v.pull();
  v.flushAll();
  const s = v.serverData("t");
  assert.equal(s.nextStep, "Send mockups");
  assert.deepEqual(s.history.map((x: any) => x.text), ["Moved to design", "Moved to build", "Invoice sent", "Project created"]);
});
ok("R8 lists of entries without ids: added at the end on both sides keeps both; a removal, plain values or an empty start stay one value (this device's)", () => {
  const e = (n: number) => ({ n });
  assert.deepEqual((K.mergeStale({ l: [e(1), e(2)] }, { l: [e(1), e(2), e(3)] }, { l: [e(1), e(2), e(4)] }) as any).l, [e(1), e(2), e(4), e(3)]);
  assert.deepEqual((K.mergeStale({ l: [e(1), e(2)] }, { l: [e(1)] }, { l: [e(1), e(2), e(4)] }) as any).l, [e(1)]);
  assert.deepEqual((K.mergeStale({ l: [1, 2] }, { l: [1, 2, 3] }, { l: [1, 2, 4] }) as any).l, [1, 2, 3]);
  assert.deepEqual((K.mergeStale({ l: [] }, { l: [e(1)] }, { l: [e(2)] }) as any).l, [e(1)]);
  assert.deepEqual((K.mergeStale({ l: [e(0)] }, { l: [e(1), e(0)] }, { l: [e(1), e(0)] }) as any).l, [e(1), e(0)], "the same line added on both is kept once");
});

// Break-it 1.74 round 2: a send whose answer came back, or one a merge already used, is no longer in doubt.
ok("Y1 a merge's old sends never make a later revert look like this device's own: another device unticks again, it stays unticked", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...task(), title: "Morning routine" });
  v.request(true);                                                    // S1 arrived (done: false in it), answer lost
  await v.other("t", "todo", { ...task(), title: "Morning routine", done: true });   // B ticks the task, on top of S1
  await v.pull();                                                     // merged: Morning and ticked
  await v.put("todo", "t", { ...v.docs.get("t")!.data, subtasks: [sub("s1", "Stretch", true), sub("s2", "Read")] });
  await v.other("t", "todo", { ...task(), title: "Morning routine", done: false });  // C unticks the task, on top of B
  await v.pull();
  v.flushAll();
  const s = v.serverData("t");
  assert.equal(s.subtasks[0].done, true);
  assert.equal(s.done, false, "the other device's untick was undone (an old send held done: false)");
});
ok("Y2 an answered send left on a newer unsent copy never makes another device's rename back look like this device's own", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...task(), title: "Morning routine" });
  const a1 = v.request(true);                                         // S1 on its way
  await v.put("todo", "t", { ...task(), title: "Night routine" });     // typed on while it went
  v.answer(a1);                                                        // answered, the newer copy stays
  const a2 = v.request(true);
  await v.put("todo", "t", { ...task(), title: "Night routine", done: true });
  v.answer(a2);
  await v.other("t", "todo", { ...task(), title: "Morning routine" });  // another device sets the title back
  await v.pull();
  v.flushAll();
  const s = v.serverData("t");
  assert.equal(s.done, true);
  assert.equal(s.title, "Morning routine", "the other device's rename was undone by an answered send still listed");
});

ok("Y3 a send the merged copy does not show arrived stays in doubt: it lands late, another device writes on it, the tick merged here stays", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...task(), title: "Morning routine" });
  const land = v.requestLater();                                      // S1 on its way
  await v.other("t", "todo", { ...task(), subtasks: [sub("s1", "Stretch", true), sub("s2", "Read")] });   // B ticks s1
  await v.pull();                                                     // merged: Morning and the tick
  land();                                                             // S1 lands after B (s1 unticked in it), answer lost
  await v.other("t", "todo", { ...task(), title: "Morning routine", done: true });   // C writes on S1's copy
  await v.pull();
  v.flushAll();
  const s = v.serverData("t");
  assert.deepEqual([s.title, s.subtasks[0].done, s.done], ["Morning routine", true, true]);
});
ok("Y4 landedIn: a changed field the server has now, or one changed mini task, shows the send arrived; old values alone never do", () => {
  const o = task(), snd = { ...task(), title: "Morning routine" };
  assert.equal(K.landedIn(o, snd, { ...task(), title: "Morning routine", done: true }), true);
  assert.equal(K.landedIn(o, snd, { ...task(), done: true }), false, "only values the send left as they were match");
  const tick = { ...task(), subtasks: [sub("s1", "Stretch", true), sub("s2", "Read")] };
  assert.equal(K.landedIn(o, tick, { ...task(), subtasks: [sub("s1", "Stretch", true), sub("s2", "Read", true)] }), true);
  assert.equal(K.landedIn(o, o, o), false, "a send that changed nothing never counts as seen");
});
ok("Y5 two sends in doubt, the merged copy shows only the later: the earlier settles too, another device renaming back to it wins", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...task(), title: "Morning routine" });
  v.request(true);                                                    // S1 arrived, answer lost
  await v.put("todo", "t", { ...task(), title: "Night routine" });
  v.request(true);                                                    // S2 arrived, answer lost
  await v.put("todo", "t", { ...task(), title: "Night routine", done: true });
  await v.other("t", "todo", { ...task(), title: "Night routine", subtasks: [sub("s1", "Stretch", true), sub("s2", "Read")] });
  await v.pull();                                                     // shows S2 only (S1's title was changed again)
  await v.other("t", "todo", { ...task(), title: "Morning routine", subtasks: [sub("s1", "Stretch", true), sub("s2", "Read")] });
  await v.pull();                                                     // renamed back on purpose
  v.flushAll();
  const s = v.serverData("t");
  assert.deepEqual([s.title, s.done, s.subtasks[0].done], ["Morning routine", true, true], "the rename back was undone by S1 still in doubt");
});
ok("Y6 a send the server's copy seemed to show (the same rename there) really lands after it: it comes down as this device's own, the tick stays", async () => {
  const v = vault();
  await v.seed("t", "todo", task());
  await v.put("todo", "t", { ...task(), title: "Morning routine" });
  const land = v.requestLater();
  await v.other("t", "todo", { ...task(), title: "Morning routine", subtasks: [sub("s1", "Stretch", true), sub("s2", "Read")] });
  await v.pull();
  assert.ok(v.outbox.get("t")!.past?.length, "settled by the merge");
  land();
  await v.pull();
  v.flushAll();
  const s = v.serverData("t");
  assert.deepEqual([s.title, s.subtasks[0].done], ["Morning routine", true]);
});
ok("Y7 sentAfterMerge: sends before the newest one seen settle with it, later ones stay in doubt, past never lists one twice", () => {
  assert.deepEqual(K.sentAfterMerge({ ct: "x", sent: ["a", "b", "c"], past: ["z"] }, ["b"]), { sent: ["c"], past: ["z", "a", "b"] });
  assert.deepEqual(K.sentAfterMerge({ ct: "x", sent: ["a", "b"] }, []), { sent: ["a", "b"], past: undefined });
  assert.deepEqual(K.sentAfterMerge({ ct: "x", sent: ["b"], past: ["a"] }, ["a", "b"]), { sent: undefined, past: ["a", "b"] });
});
// Static checks on what goes to the server or storage
const vsrc = readFileSync(new URL("../src/core/vault.ts", import.meta.url), "utf8");
ok("S1 the records upsert body lists its fields (no sent)", () => {
  assert.match(vsrc, /const body = list\.map\(\(r\) => \(\{ id: r\.id, workspace_id: r\.workspace_id, ct: r\.ct, deleted: r\.deleted \}\)\)/);
});
ok("S2 the answer never clears the in-doubt list in place, and the list is stored before the request", () => {
  assert.ok(!vsrc.includes("delete sent.sent"));
  assert.ok(vsrc.includes("const inDoubt = [...(mine.sent ?? [])];"));
  assert.match(vsrc, /markSent\(r\);   \/\/ in place, kept with the outbox\n\s+await persist\(\);/);
  assert.ok(vsrc.includes("inDoubtBase(o.data, sent, b.data)"));
  assert.ok(vsrc.includes("else if (sent) settleSent(sent, r.ct);"), "an answer settles the sends up to it on a newer copy");
  assert.ok(vsrc.includes("updated_at: remote.updated_at, ...sentAfterMerge(mine, seen) });"), "a merge settles every send so far");
});
ok("S3 the one by one retry never sends a row the outbox no longer holds (dropped for a delete, or replaced)", () => {
  assert.match(vsrc, /for \(const row of batch\) \{\n(\s+\/\/.*\n)+\s+if \(outbox\.get\(row\.id\) !== row\) continue;\n\s+try \{ data\.push\(\.\.\.await send\(\[row\]\)\); \}/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("ok  ", name); }
  catch (e) { failed++; console.log("FAIL", name, "|", (e as Error).message.split("\n")[0]); }
}
console.log(failed ? `${failed} failing` : "all pass");
if (failed) process.exitCode = 1;
