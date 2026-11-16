// Run: node --experimental-strip-types tests/second-outsource-page.test.ts
// Outsourcing (protocol v1.3), the page's part only: it carries sealed records between the Macs and never opens
// them. Two Macs' real page code (src/second/store.ts) over one made up vault, each with a stand-in PS that answers
// the bridge as ps-mac Second.swift does (hello with okeys, ojobOut, oresOut, oack, ojobs). FICTIONAL data.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "ps-second-opage-"));
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


class Native {
  device: string; name: string; role: string; pub: string; okid = "kid-1";
  trusted: { device: string; name: string; pub: string; role: string; at: number }[] = [];
  got: Record<string, any>[] = [];
  page: (m: Record<string, unknown>) => void = () => {};
  constructor(device: string, name: string, role: string) { this.device = device; this.name = name; this.role = role; this.pub = "PUB-" + device; }
  say(m: Record<string, unknown>) { setTimeout(() => this.page(m), 2); }
  env(b: Record<string, unknown>) { return { body: JSON.stringify(b), sig: "sig-" + randomUUID(), by: this.device }; }
  state() { this.say({ type: "second", me: { device: this.device, name: this.name, pub: this.pub, role: this.role, chip: "Apple M4", chosen: true, app: "1.29", okid: this.okid },
    trusted: this.trusted, seeks: [], caps: ["outbox", "stream", "pack", "drop", "outsource"] }); }
  handle(m: Record<string, any>) {
    this.got.push(m);
    if (m.type === "second:hello") this.state();
    if (m.type === "second:sign") {
      const b = { ...m.body, v: 1, from: this.device, at: m.body.at ?? Date.now() } as Record<string, any>;
      if (b.t === "dev") { b.pub = this.pub; b.role = this.role; b.to = "all"; b.ncaps = ["stream", "pack"]; b.okeys = { kid: this.okid, p256: "P", sign: "S", xwing: "X", store: "secure enclave" }; }
      this.say({ type: "second:signed", req: m.req, env: this.env(b) });
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
const kinds = (k: string) => V.docs.filter((d) => d.kind === k);

try {
  reset();
  const n4 = new Native("dev-m4", "MacBook Air M4", "primary"), n1 = new Native("dev-m1", "Home M1", "secondary");
  n4.trusted = [{ device: "dev-m1", name: "Home M1", pub: n1.pub, role: "secondary", at: 0 }];
  n1.trusted = [{ device: "dev-m4", name: "MacBook Air M4", pub: n4.pub, role: "primary", at: 0 }];
  V.docs.push({ id: "pairok", ws: null, kind: "spair", author: "t", updatedAt: "", data: { env: n1.env({ v: 1, t: "pairok", id: "ok1", from: "dev-m1", to: "dev-m4", at: Date.now(), primary: "dev-m4", secondary: "dev-m1" }) } });
  const m4 = await mac(n4 as never), m1 = await mac(n1 as never);
  await until("both hellos carry the keys", () => kinds("sdev").length === 2 && kinds("sdev").every((d) => JSON.parse((d.data as any).env.body).okeys?.kid === "kid-1"));
  await until("each PS got the other's hello", () => n4.got.some((g) => g.type === "second:peerHello" && g.env.by === "dev-m1") && n1.got.some((g) => g.type === "second:peerHello" && g.env.by === "dev-m4"));
  await ok("hellos: each Mac's hello (with its PS's keys) goes to the other Mac's PS, once per change", () => {
    assert.equal(n4.got.filter((g) => g.type === "second:peerHello").length, 1);
    assert.ok(m4.store.currentView().peer?.outsource && m4.store.currentView().peer?.xwing);
  });
  // The M4's PS sealed a job (a chat's `second.ts outsource`).
  const job = randomUUID(), jenv = n4.env({ v: 1, t: "ojob", id: job, from: "dev-m4", to: "dev-m1", at: Date.now(), exp: Date.now() + 600_000, nonce: "n", sealed: { suite: "xwing", kid: "kid-1", enc: "E", ct: "C" } });
  n4.page({ type: "second:ojobOut", env: jenv, job });
  await until("the M1's PS got the sealed job", () => n1.got.some((g) => g.type === "second:ojob"));
  await ok("a sealed job: stored as it is, handed to the second Mac's PS once, never opened by a page", () => {
    assert.equal(kinds("sojob").length, 1); assert.equal(kinds("sojob")[0].id, job);
    assert.deepEqual(n1.got.find((g) => g.type === "second:ojob")!.env, jenv);
    assert.ok(!n4.got.some((g) => g.type === "second:ojob"), "the main Mac never runs its own job");
  });
  // The M1's PS sealed two statuses, then the result.
  for (const st of ["running", "done"]) n1.page({ type: "second:oresOut", job, env: n1.env({ v: 1, t: "ores", id: randomUUID(), job, from: "dev-m1", to: "dev-m4", at: Date.now(), nonce: st, sealed: {} }) });
  await until("the M4's PS got the result", () => n4.got.filter((g) => g.type === "second:ores").length >= 1 && JSON.parse(n4.got.filter((g) => g.type === "second:ores").pop()!.env.body).nonce === "done");
  await ok("results: one record per job, replaced as it goes, each version to the main Mac's PS", () => {
    assert.equal(kinds("sores").length, 1);
    assert.ok(!n1.got.some((g) => g.type === "second:ores"), "a Mac never takes its own result");
  });
  n4.page({ type: "second:oack", job, to: "dev-m1" });
  await until("the M1's PS got the ack", () => n1.got.some((g) => g.type === "second:oacked"));
  await ok("the ack: signed by the main Mac's page, then handed to the second Mac's PS so it deletes the folder", () => {
    const a = kinds("sack").find((d) => (d.data as any).ref === job)!;
    assert.equal(JSON.parse((a.data as any).env.body).t, "ack");
    assert.equal(n1.got.find((g) => g.type === "second:oacked")!.env.sig, (a.data as any).env.sig);
  });
  n4.page({ type: "second:ojobs", list: [{ job, title: "Fictional grinders", state: "done", suite: "xwing", at: Date.now(), mine: true, report: "# R" }] });
  await settle(100);
  await ok("the window: PS's list of sealed jobs shows in the Outsource tab", () => {
    const j = m4.store.currentView().jobs.find((x) => x.id === job)!;
    assert.equal(j.args.title, "Fictional grinders"); assert.equal(j.sealed?.suite, "xwing");
    assert.match(m4.render("outsource"), /Fictional grinders/);
  });
  n4.okid = "kid-2"; n4.state();
  await until("a new hello after the weekly key change", () => kinds("sdev").some((d) => JSON.parse((d.data as any).env.body).okeys?.kid === "kid-2"));
  await ok("new keys (weekly, or after pairing again): the Mac says hello again at once", () => {});
  m4.store.runSecondOp({ op: "outsource", title: "Fictional coffee", prompt: "Compare three fictional grinders" });
  await settle(100);
  await ok("the window's Research form asks PS to seal it (the page never builds a job itself)", () => {
    assert.deepEqual(n4.got.filter((g) => g.type === "second:outsource").map((g) => [g.title, g.prompt]), [["Fictional coffee", "Compare three fictional grinders"]]);
  });
  V.killed.add(m4.inst); V.killed.add(m1.inst);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${count} passed`);
process.exit(0);
