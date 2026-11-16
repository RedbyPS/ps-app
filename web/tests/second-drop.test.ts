// Run: node --experimental-strip-types tests/second-drop.test.ts
// Second Computer drag and drop (protocol v1.2, 2 Nov 2026, the developer: "make it so it can actually drag and drop files as
// well. yeah, make it very compatible"), end to end through the real page code (src/second/store.ts, view.ts,
// views/SecondWindow.tsx). Two Macs in one process, each its own copy of the page, one shared made up vault with a
// blob store, and a stand-in for each Mac's PS that answers the bridge the way ps-mac Second.swift and
// SecondDrop.swift do (the outbox, second:read, second:landAt, second:chunk with chunkOk, acks). FICTIONAL data.
// Cases: a 130 MB file streams through a vault that holds 100 MB at most, while the other Mac is away and after it
// comes back; the other Mac's page restarts halfway and carries on from its disk; an older other Mac gets plain
// words (50 MB, folders as a zip); the month's budget; a note's attachments wait for the note; Finder's drag out
// asks the other Mac; the window marks its drop places.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { dropTargetOk, fmtSize, monthKey, sendRefusal, MB } from "../src/core/second.ts";

const root = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "ps-second-drop-"));
const entry = join(dir, "entry.tsx"), out = join(dir, "mac.mjs"), vaultShim = join(dir, "vault-shim.ts");

type Doc = { id: string; ws: null; kind: string; data: unknown; author: string; updatedAt: string };
const V = { docs: [] as Doc[], subs: new Set<() => void>(), pokes: new Set<(k: string) => void>(), n: 0, blobs: new Map<string, Uint8Array>(), bytes: 0, maxBytes: 0, killed: new Set<number>(), inst: 0 };
(globalThis as unknown as { __fv: typeof V }).__fv = V;
(globalThis as unknown as { window: unknown }).window = globalThis;
writeFileSync(vaultShim, `
const V = globalThis.__fv;
export const inst = ++V.inst;
const alive = () => { if (V.killed.has(inst)) throw new Error("this page is gone"); };
const wake = () => setTimeout(() => { V.subs.forEach((l) => l()); }, 0);
export const vaultStore = { get: () => ({ status: "unlocked", docs: new Map(V.docs.map((d) => [d.id, d])) }), subscribe: (l) => { const f = () => { if (!V.killed.has(inst)) l(); }; V.subs.add(f); return () => V.subs.delete(f); } };
export function docs(kind) { return V.docs.filter((d) => d.kind === kind); }
export async function put(kind, data, opts = {}) {
  alive();
  const id = opts.id ?? "r" + (++V.n);
  V.docs = V.docs.filter((d) => d.id !== id).concat([{ id, ws: null, kind, data, author: "test", updatedAt: new Date().toISOString() }]);
  wake(); return id;
}
export async function remove(id) { V.docs = V.docs.filter((d) => d.id !== id); wake(); }
export function setSecondChannel() {}
export function onSecondPoke(f) { const g = (k) => { if (!V.killed.has(inst)) f(k); }; V.pokes.add(g); return () => V.pokes.delete(g); }
export async function pokeSecond(k) { setTimeout(() => V.pokes.forEach((f) => f(k)), 0); }
export async function putBlob(_ws, bytes) {
  alive();
  const id = "b" + (++V.n); V.blobs.set(id, bytes.slice()); V.bytes += bytes.length; V.maxBytes = Math.max(V.maxBytes, V.bytes); return id;
}
export async function getBlob(id) { alive(); const b = V.blobs.get(id); if (!b) throw new Error("no blob " + id); return b; }
export async function deleteBlob(id) { const b = V.blobs.get(id); if (b) { V.bytes -= b.length; V.blobs.delete(id); } }
export type Snapshot = any;
`);
writeFileSync(entry, `
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SecondWindow } from ${JSON.stringify(root + "src/views/SecondWindow.tsx")};
import * as st from ${JSON.stringify(root + "src/second/store.ts")};
import { inst as shimInst } from ${JSON.stringify(vaultShim)};
export const store = st;
export const inst = shimInst;
export function render(initial) {
  const s = { docs: new Map(globalThis.__fv.docs.map((d) => [d.id, d])), status: "unlocked" };
  return renderToStaticMarkup(createElement(SecondWindow, { s, initial }));
}
`);
const shim = join(dir, "react-shim.cjs");
writeFileSync(shim, `const R = require(${JSON.stringify(join(root, "node_modules/react/index.js"))});
module.exports = { ...R, useSyncExternalStore: (s, g, gs) => R.useSyncExternalStore(s, g, gs || g) };`);
await build({
  plugins: [{ name: "shims", setup(b) {
    b.onResolve({ filter: /^react$/ }, (a) => a.importer.startsWith(join(root, "src")) ? { path: shim } : undefined);
    b.onResolve({ filter: /core\/vault(\.ts)?$/ }, (a) => a.importer.endsWith(join("src", "second", "store.ts")) ? { path: vaultShim } : undefined);
  } }],
  entryPoints: [entry], outfile: out, bundle: true, format: "esm", platform: "node", jsx: "automatic", logLevel: "silent",
  loader: { ".css": "empty", ".svg": "empty", ".png": "empty", ".woff2": "empty" },
  nodePaths: [join(root, "node_modules")],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  define: { "import.meta.env": JSON.stringify({ MODE: "test", DEV: false, PROD: true, BASE_URL: "/client/", VITE_SUPABASE_URL: "https://example.invalid", VITE_SUPABASE_KEY: "test" }) },
});

type Store = typeof import("../src/second/store.ts");
type Mac = { name: string; store: Store; render: (t?: string) => string; native: Native; inst: number };
const CHUNK = 4 * MB;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

/** A stand-in for one Mac's PS: Second.swift's answers, the outbox (SecondOutbox) and the landing (SecondLanding). */
class Native {
  device: string; name: string; chip: string; role: string; pub: string; streams: boolean;
  trusted: { device: string; name: string; pub: string; role: string; at: number }[] = [];
  outbox = new Map<string, { m: Record<string, unknown>; data: Uint8Array }>();
  disk = new Map<string, { body: Record<string, any>; parts: Uint8Array[] }>();   // half files, survive a page restart
  landed = new Map<string, { name: string; bytes: Uint8Array; body: Record<string, any> }>();
  chunksIn: { id: string; i: number }[] = [];
  got: Record<string, any>[] = [];
  page: (m: Record<string, unknown>) => void = () => {};
  constructor(device: string, name: string, chip: string, role: string, streams = true) {
    this.device = device; this.name = name; this.chip = chip; this.role = role; this.pub = "PUB-" + device; this.streams = streams;
  }
  private say(m: Record<string, unknown>) { setTimeout(() => this.page(m), 2); }
  env(b: Record<string, unknown>) { return { body: JSON.stringify(b), sig: "test", by: this.device }; }
  state() {
    this.say({ type: "second", me: { device: this.device, name: this.name, model: "MacBook Air", pub: this.pub, role: this.role, chip: this.chip, chosen: true, app: this.streams ? "1.28" : "1.27" },
      trusted: this.trusted, seeks: [], ...(this.streams ? { caps: ["outbox", "stream", "pack", "drop"] } : {}) });
  }
  sayOutbox() { this.say({ type: "second:outbox", list: [...this.outbox.values()].map((x) => x.m) }); }
  /** What SecondOutbox.stage writes for a dropped file. */
  stage(name: string, data: Uint8Array, target: Record<string, unknown> = { kind: "files" }, extra: Record<string, unknown> = {}) {
    const id = randomUUID();
    this.outbox.set(id, { m: { id, name, size: data.length, sha256: sha(data), mime: "application/octet-stream", target, at: Date.now(), ...(target.kind === "msg" ? { hold: true } : {}), ...extra }, data });
    this.sayOutbox();
    return id;
  }
  handle(m: Record<string, any>) {
    this.got.push(m);
    switch (m.type) {
      case "second:hello": this.state(); if (this.streams) this.sayOutbox(); break;
      case "second:sign": {
        const b = { ...m.body } as Record<string, any>;
        b.v = 1; b.from = this.device; b.at ??= Date.now();
        if (b.t === "dev") { b.pub = this.pub; b.role = this.role; b.to = "all"; b.chip = this.chip; b.app = this.streams ? "1.28" : "1.27"; if (this.streams) b.ncaps = ["stream", "pack"]; }
        this.say({ type: "second:signed", req: m.req, env: this.env(b) });
        break;
      }
      case "second:outbox": this.sayOutbox(); break;
      case "second:read": {
        const o = this.outbox.get(m.id);
        this.say(o ? { type: "second:readOk", req: m.req, b64: b64(o.data.subarray(m.i * CHUNK, (m.i + 1) * CHUNK)) } : { type: "second:readOk", req: m.req, error: "Gone" });
        break;
      }
      case "second:outboxDone": case "second:outboxDrop": this.outbox.delete(m.id); this.sayOutbox(); break;
      case "second:outboxRelease": for (const id of m.ids) { const o = this.outbox.get(id); if (o) delete o.m.hold; } this.sayOutbox(); break;
      case "second:landAt": {
        const b = JSON.parse(m.env.body);
        this.say({ type: "second:landAt", req: m.req, have: this.disk.get(b.id)?.parts.length ?? 0 });
        break;
      }
      case "second:chunk": {
        const b = JSON.parse(m.env.body);
        this.chunksIn.push({ id: b.id, i: m.i });
        const p = this.disk.get(b.id) ?? { body: b, parts: [] };
        if (m.i !== p.parts.length) { if (m.req) this.say({ type: "second:chunkOk", req: m.req, error: "A chunk came out of order" }); break; }
        p.parts.push(new Uint8Array(Buffer.from(m.b64, "base64")));
        this.disk.set(b.id, p);
        if (m.i < m.n - 1) { if (m.req) this.say({ type: "second:chunkOk", req: m.req, i: m.i }); break; }
        const all = new Uint8Array(Buffer.concat(p.parts));
        this.disk.delete(b.id);
        const ok = all.length === b.size && sha(all) === b.sha256;
        if (ok) this.landed.set(b.id, { name: b.name, bytes: all, body: b });
        else if (m.req) this.say({ type: "second:chunkOk", req: m.req, error: "The file did not arrive whole" });
        this.say({ type: "second:signed", req: "ack:" + b.id, env: this.env({ v: 1, t: "ack", id: randomUUID(), from: this.device, to: b.from, at: Date.now(), ref: b.id, ok, ...(ok ? {} : { reason: "The file did not arrive whole" }) }) });
        break;
      }
    }
  }
}

let fresh = 0;
async function mac(n: Native): Promise<Mac> {
  const mod = await import(pathToFileURL(out).href + "?mac=" + (++fresh)) as { store: Store; render: (t?: string) => string; inst: number };
  n.page = (m) => { if (!V.killed.has(mod.inst)) mod.store.secondMessage(m as { type?: string }); };
  mod.store.startSecond((m) => { if (!V.killed.has(mod.inst)) n.handle(JSON.parse(JSON.stringify(m)) as Record<string, unknown>); });
  return { name: n.name, store: mod.store, render: mod.render, native: n, inst: mod.inst };
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, f: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error("gave up waiting for " + what); await settle(25); }
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
let count = 0;
const ok = async (name: string, fn: () => void | Promise<void>) => { await fn(); count++; console.log("ok -", name); };
const reset = () => { V.docs = []; V.subs.clear(); V.pokes.clear(); V.blobs.clear(); V.bytes = 0; V.maxBytes = 0; };
/** Two Macs already paired: trust on both sides, the pair answer, and the other Mac's hello (as it would be in the vault). */
function paired(p: Native, s: Native) {
  p.trusted = [{ device: s.device, name: s.name, pub: s.pub, role: "secondary", at: Date.now() }];
  s.trusted = [{ device: p.device, name: p.name, pub: p.pub, role: "primary", at: Date.now() }];
  V.docs.push({ id: "pairok", ws: null, kind: "spair", author: "test", updatedAt: "", data: { env: s.env({ v: 1, t: "pairok", id: "ok1", from: s.device, to: p.device, at: Date.now(), primary: p.device, primaryPub: p.pub, secondary: s.device, secondaryPub: s.pub }) } });
  const hello = (n: Native) => ({ id: "dev-" + n.device, ws: null, kind: "sdev", author: "test", updatedAt: "",
    data: { device: n.device, env: n.env({ v: 1, t: "dev", id: "h-" + n.device, from: n.device, to: "all", at: Date.now(), name: n.name, role: n.role, pub: n.pub, chip: n.chip, app: n.streams ? "1.28" : "1.27",
      ...(n.streams ? { ncaps: ["stream", "pack"], wcaps: ["stream", "pack"] } : {}) }) } });
  V.docs.push(hello(p), hello(s));
}
const sfile = (id: string) => V.docs.find((d) => d.kind === "sfile" && d.id === id)?.data as { env: { body: string }; chunks: string[] } | undefined;
const fileBody = (id: string) => { const f = sfile(id); return f ? JSON.parse(f.env.body) as Record<string, any> : null; };

try {
  // ---------- the rules ----------
  await ok("rules: drop places, the limits in plain words, sizes in GB", () => {
    assert.ok(dropTargetOk({ kind: "files" }) && dropTargetOk({ kind: "msg" }) && dropTargetOk({ kind: "files", root: "ps-shared", dir: "Photos/2026" }));
    assert.ok(!dropTargetOk({ kind: "files", dir: "../etc" }) && !dropTargetOk({ kind: "files", root: "Bad Root" }) && !dropTargetOk({ kind: "msg", x: 1 }) && !dropTargetOk({ kind: "run" }));
    assert.equal(sendRefusal(700 * MB, { stream: true, pack: true, folder: false, month: 0, peer: "Home M1" }), null);
    assert.match(sendRefusal(1100 * MB, { stream: true, pack: true, folder: false, month: 0, peer: "Home M1" })!, /Too big: 1\.1 GB\. The limit is 1 GB a file or folder\./);
    assert.match(sendRefusal(60 * MB, { stream: false, pack: false, folder: false, month: 0, peer: "Home M1" })!, /Too big for Home M1 as it is: 60 MB\. It takes 50 MB a file until PS app is updated there \(then up to 1 GB\)\./);
    assert.match(sendRefusal(5 * MB, { stream: true, pack: true, folder: false, month: 2046 * MB, peer: "Home M1" })!, /this month's 2 GB of Second Computer transfers \(2\.0 GB used\)/);
    assert.equal(fmtSize(1024 * MB), "1 GB");
    for (const t of ["Too big", "month"]) assert.ok(!/[–—]/.test(String(sendRefusal(t === "month" ? 5 * MB : 2000 * MB, { stream: true, pack: true, folder: false, month: t === "month" ? 2046 * MB : 0, peer: "M1" }))), "no dashes");
  });

  // ---------- a 130 MB file through a vault that holds 100 MB, the other Mac away at first ----------
  reset();
  const n4 = new Native("dev-m4", "MacBook Air M4", "Apple M4", "primary"), n1 = new Native("dev-m1", "Home M1", "Apple M1", "secondary");
  paired(n4, n1);
  const m4 = await mac(n4);
  await until("the M4 page knows its PS streams", () => !!m4.store.secondLocal().caps?.includes("stream") && !!m4.store.currentView().peer?.stream);
  const big = new Uint8Array(randomBytes(130 * MB + 12345));
  const bigId = n4.stage("Film cut 3 (final) ✓ é.mov", big, { kind: "files" }, { m: Date.UTC(2026, 9, 30, 12) });
  await until("the vault is full while the M1 is away", () => (sfile(bigId)?.chunks.length ?? 0) >= 24 && m4.store.currentView().files.some((f) => f.id === bigId && f.stalled));
  await settle(400);
  await ok("away: the M4 puts up only what fits (100 MB), signs the real size and says it is waiting", () => {
    assert.ok(V.bytes <= 100 * MB, `the vault holds ${V.bytes}`);
    const b = fileBody(bigId)!;
    assert.equal(b.size, big.length); assert.equal(b.n, Math.ceil(big.length / CHUNK)); assert.equal(b.sha256, sha(big)); assert.equal(b.m, Date.UTC(2026, 9, 30, 12));
    assert.ok(sfile(bigId)!.chunks.length < b.n, "not all of it went up");
    const f = m4.store.currentView().files.find((x) => x.id === bigId)!;
    assert.equal(f.state, "sending"); assert.ok(f.stalled);
    assert.match(text(m4.render("files")), /Waiting for Home M1/);
  });
  const m1 = await mac(n1);
  // Halfway through landing, the M1's page restarts (a new build, sign in): it must carry on from its disk.
  await until("the M1 has some of it on disk", () => (n1.disk.get(bigId)?.parts.length ?? 0) >= 6);
  V.killed.add(m1.inst);
  const atRestart = n1.disk.get(bigId)!.parts.length;
  const m1b = await mac(n1);
  await until("the whole file landed on the M1", () => n1.landed.has(bigId), 60_000);
  await until("the M4 dropped its copy", () => !n4.outbox.has(bigId));
  await settle(300);
  await ok("back: the M1 lands it chunk by chunk, whole and unchanged, with its name and date", () => {
    const l = n1.landed.get(bigId)!;
    assert.equal(l.bytes.length, big.length); assert.equal(sha(l.bytes), sha(big));
    assert.equal(l.name, "Film cut 3 (final) ✓ é.mov"); assert.equal(l.body.m, Date.UTC(2026, 9, 30, 12));
  });
  await ok("restart: the new page asked where the disk left off and never started again from the first chunk", () => {
    assert.ok(n1.got.filter((g) => g.type === "second:landAt").length >= 2, "both pages asked second:landAt");
    const idx = n1.chunksIn.filter((c) => c.id === bigId).map((c) => c.i);
    for (let i = 1; i < idx.length; i++) assert.ok(idx[i] >= idx[i - 1], `chunk ${idx[i]} after ${idx[i - 1]}: it started over`);
    assert.ok(atRestart >= 6 && idx.some((i) => i > atRestart), "the new page carried on past the restart");
  });
  await ok("the vault never held more than 100 MB of it, and nothing is left behind", () => {
    assert.ok(V.maxBytes <= 100 * MB + CHUNK, `peak ${V.maxBytes}`);
    assert.equal(V.blobs.size, 0, "chunks left in the vault");
    const v4 = m4.store.currentView();
    assert.equal(v4.files.find((f) => f.id === bigId)?.state, "landed");
    assert.equal(v4.month, big.length, "the month's count");
    assert.ok(V.docs.some((d) => d.kind === "sgot" && (d.data as { ref?: string }).ref === bigId), "the M1 said how far it got");
  });

  // ---------- a note's attachments wait for the note ----------
  const pic = new Uint8Array(randomBytes(300_000));
  const picId = n4.stage("Screenshot 2026-11-02 at 09.14.png", pic, { kind: "msg" });
  await until("held for the note", () => m4.store.currentView().held.some((h) => h.id === picId));
  await settle(300);
  await ok("Messages: a file dropped on the note waits there (shown on the note, nothing sent yet)", () => {
    assert.ok(!sfile(picId), "it went before the note");
    assert.match(text(m4.render("messages")), /Screenshot 2026-11-02 at 09\.14\.png/);
  });
  m4.store.runSecondOp({ op: "msg", text: "the error from this morning", files: [picId] });
  await until("the note and its picture landed", () => n1.landed.has(picId));
  await ok("Messages: the note names its picture and the picture lands", () => {
    const msg = V.docs.filter((d) => d.kind === "smsg").map((d) => JSON.parse((d.data as { env: { body: string } }).env.body)).find((b) => b.text === "the error from this morning");
    assert.deepEqual(msg?.files, [picId]);
    assert.ok(n4.got.some((g) => g.type === "second:outboxRelease" && g.ids.includes(picId)));
    assert.equal(sha(n1.landed.get(picId)!.bytes), sha(pic));
  });

  // ---------- a folder (packed by PS) and a drop into a shared folder ----------
  const zip = new Uint8Array(randomBytes(2 * MB));
  const folderId = n4.stage("Client photos", zip, { kind: "files", root: "ps-shared", dir: "Inbox" }, { pack: "zip", mime: "application/zip" });
  await until("the folder landed", () => n1.landed.has(folderId));
  await ok("a folder goes packed (pack zip, its own name) into the shared folder it was dropped on", () => {
    const b = n1.landed.get(folderId)!.body;
    assert.equal(b.pack, "zip"); assert.equal(b.name, "Client photos"); assert.equal(b.purpose, "share"); assert.equal(b.root, "ps-shared"); assert.equal(b.dir, "Inbox");
  });

  // ---------- Finder's drag out ----------
  n4.page({ type: "second:fetchTo", req: "fetch-" + randomUUID(), device: "dev-m1", root: "ps-shared", path: "Reports/Q4 summary.pdf" });
  await until("the request went", () => n4.got.some((g) => g.type === "second:fetching"));
  await ok("drag out: Finder's request becomes a signed request to the other Mac, and PS learns its id", () => {
    const f = n4.got.find((g) => g.type === "second:fetching")!;
    const get = V.docs.filter((d) => d.kind === "sget").map((d) => JSON.parse((d.data as { env: { body: string } }).env.body)).find((b) => b.id === f.get);
    assert.ok(get, "no request in the vault");
    assert.equal(get.path, "Reports/Q4 summary.pdf"); assert.equal(get.root, "ps-shared"); assert.equal(get.as, "download"); assert.equal(get.to, "dev-m1");
  });

  // ---------- the window ----------
  await ok("the window: the Files pane and Messages are drop places PS can ask about, with Send files", () => {
    const h = m4.render("files");
    assert.match(h, /data-sdrop="files"/); assert.match(h, /data-sdrop-target="\{&quot;kind&quot;:&quot;files&quot;\}"/);
    assert.match(text(h), /Send files/);
    assert.match(m4.render("messages"), /data-sdrop="msg"/);
  });

  // ---------- the month's budget ----------
  V.docs.push({ id: "budget-m1", ws: null, kind: "sbudget", author: "test", updatedAt: "", data: { device: "dev-m1", month: monthKey(), bytes: 2040 * MB } });
  const late = n4.stage("Backup.dmg", new Uint8Array(randomBytes(9 * MB)));
  await until("refused", () => !n4.outbox.has(late));
  await ok("the month: over 2 GB for both Macs it says so and nothing goes up", () => {
    assert.ok(!sfile(late));
    assert.match(m4.store.secondLocal().note ?? "", /Backup\.dmg: That would pass this month's 2 GB of Second Computer transfers/);
    assert.ok(n4.got.some((g) => g.type === "second:outboxDrop" && g.id === late && /this month/.test(g.why)));
  });
  V.killed.add(m4.inst); V.killed.add(m1b.inst);

  // ---------- an older other Mac (V1.27: whole files, 50 MB, no folders) ----------
  reset();
  const o4 = new Native("dev-o4", "MacBook Air M4", "Apple M4", "primary"), o1 = new Native("dev-o1", "Home M1", "Apple M1", "secondary", false);
  paired(o4, o1);
  const p4 = await mac(o4), p1 = await mac(o1);
  await until("the M4 knows the M1 does not stream", () => !!p4.store.currentView().peer && p4.store.currentView().peer!.stream === false && !!p4.store.secondLocal().caps?.length);
  const tooBig = o4.stage("Long call.m4a", new Uint8Array(randomBytes(60 * MB)));
  await until("refused", () => !o4.outbox.has(tooBig));
  await ok("older Mac: over 50 MB it says why in plain words, and nothing goes up", () => {
    assert.ok(!sfile(tooBig));
    assert.match(p4.store.secondLocal().note ?? "", /Too big for Home M1 as it is: 60 MB\. It takes 50 MB a file until PS app is updated there/);
  });
  const small = new Uint8Array(randomBytes(9 * MB)), smallId = o4.stage("Invoice.pdf", small);
  const fold = new Uint8Array(randomBytes(MB)), foldId = o4.stage("Mockups", fold, { kind: "files" }, { pack: "zip", mime: "application/zip" });
  await until("both landed whole", () => o1.landed.has(smallId) && o1.landed.has(foldId), 30_000);
  await ok("older Mac: a file under 50 MB goes whole as before, a folder arrives as a zip it can open", () => {
    assert.equal(sha(o1.landed.get(smallId)!.bytes), sha(small));
    const b = o1.landed.get(foldId)!.body;
    assert.equal(b.name, "Mockups.zip"); assert.equal(b.pack, undefined);
    assert.ok(!o1.got.some((g) => g.type === "second:landAt"), "an older page never asks second:landAt");
  });
  V.killed.add(p4.inst); V.killed.add(p1.inst);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${count} passed`);
process.exit(0);
