// Run: node --experimental-strip-types tests/second-pairing.test.ts
// One click pairing, end to end through the real page code (src/second/store.ts, view.ts, views/SecondWindow.tsx).
// 1 Nov 2026, the developer: "I just click pair, it scans to see if my M1 is online and connects for me."
// Two Macs in one process, each its own copy of the page code, one shared made up vault, and a stand-in for each
// Mac's PS that answers the bridge the way ps-mac Second.swift does (seek, autotrust, autopair; any question it
// would ask is recorded, and there must be none). FICTIONAL names and keys. No network.
// Cases: the other Mac on a stale saved main Mac role pairs by itself after one click; the other Mac starting
// AFTER the click; Looking for your other Mac, then the exact reason (nobody said hello, an older PS, Second
// Computer off there); the second Mac waiting; no code and no Trust step anywhere; a day old request ignored.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "ps-second-pairing-"));
const entry = join(dir, "entry.tsx"), out = join(dir, "mac.mjs"), vaultShim = join(dir, "vault-shim.ts");

// The shared vault: every Mac's copy of the page reads and writes the same records; a change wakes every Mac.
type Doc = { id: string; ws: null; kind: string; data: unknown; author: string; updatedAt: string };
const V = { docs: [] as Doc[], subs: new Set<() => void>(), pokes: new Set<(k: string) => void>(), n: 0, failPuts: 0 };
(globalThis as unknown as { __fv: typeof V }).__fv = V;
(globalThis as unknown as { window: unknown }).window = globalThis;
writeFileSync(vaultShim, `
const V = globalThis.__fv;
const wake = () => setTimeout(() => { V.subs.forEach((l) => l()); }, 0);
export const vaultStore = { get: () => ({ status: "unlocked", docs: new Map(V.docs.map((d) => [d.id, d])) }), subscribe: (l) => { V.subs.add(l); return () => V.subs.delete(l); } };
export function docs(kind) { return V.docs.filter((d) => d.kind === kind); }
export async function put(kind, data, opts = {}) {
  if (kind === "sdev" && V.failPuts > 0) { V.failPuts--; throw new Error("offline"); }   // the VPN still reconnecting after a wake
  const id = opts.id ?? "r" + (++V.n);
  V.docs = V.docs.filter((d) => d.id !== id).concat([{ id, ws: null, kind, data, author: "test", updatedAt: new Date().toISOString() }]);
  wake(); return id;
}
export async function remove(id) { V.docs = V.docs.filter((d) => d.id !== id); wake(); }
export function setSecondChannel() {}
export function onSecondPoke(f) { V.pokes.add(f); return () => V.pokes.delete(f); }
export async function pokeSecond(k) { setTimeout(() => V.pokes.forEach((f) => f(k)), 0); }
export async function putBlob() { return "blob"; }
export async function getBlob() { return new Uint8Array(); }
export async function deleteBlob() {}
export type Snapshot = any;
`);
writeFileSync(entry, `
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SecondWindow } from ${JSON.stringify(root + "src/views/SecondWindow.tsx")};
import * as st from ${JSON.stringify(root + "src/second/store.ts")};
export const store = st;
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
    // Only the Second Computer runtime gets the shared made up vault; the rest of the page keeps the real one, unused.
    b.onResolve({ filter: /core\/vault(\.ts)?$/ }, (a) => a.importer.endsWith(join("src", "second", "store.ts")) ? { path: vaultShim } : undefined);
  } }],
  entryPoints: [entry], outfile: out, bundle: true, format: "esm", platform: "node", jsx: "automatic", logLevel: "silent",
  loader: { ".css": "empty", ".svg": "empty", ".png": "empty", ".woff2": "empty" },
  nodePaths: [join(root, "node_modules")],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  define: { "import.meta.env": JSON.stringify({ MODE: "test", DEV: false, PROD: true, BASE_URL: "/client/", VITE_SUPABASE_URL: "https://example.invalid", VITE_SUPABASE_KEY: "test" }) },
});

type Store = typeof import("../src/second/store.ts");
type Mac = { name: string; store: Store; render: (t?: string) => string; native: Native };

/** A stand-in for one Mac's PS: what Second.swift answers on the bridge (V1.26). */
class Native {
  role: string; chosen: boolean; trusted: { device: string; name: string; pub: string; role: string; at: number }[] = [];
  questions: string[] = []; notices: string[] = []; dropped: string[] = []; seeks = new Map<string, number>(); app: string;
  page: (m: Record<string, unknown>) => void = () => {};
  device: string; name: string; chip: string; pub: string;
  constructor(device: string, name: string, chip: string, role: string, chosen: boolean, app = "1.26") {
    this.device = device; this.name = name; this.chip = chip; this.pub = "PUB-" + device; this.role = role; this.chosen = chosen; this.app = app;
  }
  private later(f: () => void) { setTimeout(f, 5); }
  private say(m: Record<string, unknown>) { this.later(() => this.page(m)); }
  state() { this.say({ type: "second", me: { device: this.device, name: this.name, model: "MacBook Air", pub: this.pub, role: this.role, chip: this.chip, chosen: this.chosen, app: this.app }, trusted: this.trusted, seeks: [...this.seeks.keys()] }); }
  private env(b: Record<string, unknown>) { return { body: JSON.stringify(b), sig: "test", by: this.device }; }
  handle(m: Record<string, unknown>) {
    switch (m.type) {
      case "second:hello": this.state(); break;
      case "second:role": {
        const r = String(m.role);
        if (r === "secondary" && this.role !== "secondary") this.questions.push("Let your primary Mac run jobs here?");
        this.role = r; this.chosen = true; this.state(); break;
      }
      case "second:sign": {
        // Second.swift reads the body as an object (msg["body"] as? [String: Any]) and silently drops anything else:
        // until 1 Nov 2026 the page sent it as text, so no hello, note, file or job it signed ever left a real Mac.
        if (!m.body || typeof m.body !== "object" || Array.isArray(m.body)) { this.dropped.push(String(m.req)); break; }
        const b = { ...(m.body as Record<string, unknown>) } as Record<string, any>;
        b.v = 1; b.from = this.device; b.at ??= Date.now();
        if (b.t === "dev") { b.pub = this.pub; b.role = this.role; b.to = "all"; b.chip = this.chip; b.app = this.app; }
        this.say({ type: "second:signed", req: m.req, env: this.env(b) });
        break;
      }
      case "second:seek": {
        if (this.role !== "primary") { this.role = "primary"; this.chosen = true; }
        const id = "seek-" + this.device + "-" + this.seeks.size, at = Date.now();
        this.seeks.set(id, at);
        this.say({ type: "second:signed", req: m.req, env: this.env({ v: 1, t: "seek", id, from: this.device, to: "all", at, primary: this.device, primaryPub: this.pub, names: { p: this.name } }) });
        this.state();
        break;
      }
      case "second:autotrust": {
        const e = m.env as { body: string; by: string }, b = JSON.parse(e.body);
        if (b.t !== "seek" || this.seeks.size || b.primary !== e.by || Date.now() - b.at > 86_400_000) { this.say({ type: "second:cancelled", req: "pairok:auto" }); break; }
        if (this.role !== "secondary") { this.role = "secondary"; this.chosen = true; }
        this.trusted.push({ device: b.primary, name: b.names?.p, pub: b.primaryPub, role: "primary", at: Date.now() });
        this.say({ type: "second:signed", req: "pairok:auto", env: this.env({ v: 1, t: "pairok", id: "ok-" + this.device, from: this.device, to: b.primary, at: Date.now(),
          primary: b.primary, primaryPub: b.primaryPub, secondary: this.device, secondaryPub: this.pub, names: { p: b.names?.p, s: this.name }, seek: b.id, auto: true }) });
        this.notices.push(`Paired with ${b.names?.p}`);
        this.state();
        break;
      }
      case "second:autopair": {
        const e = m.env as { body: string; by: string }, b = JSON.parse(e.body);
        if (this.role !== "primary" || b.primary !== this.device || !this.seeks.has(b.seek)) break;
        this.trusted.push({ device: e.by, name: b.names?.s, pub: b.secondaryPub, role: "secondary", at: Date.now() });
        this.seeks.delete(b.seek);
        this.state();
        break;
      }
      case "second:pair": case "second:trust": this.questions.push(String(m.type)); break;   // the V1.25 way: must never happen now
    }
  }
}

let fresh = 0;
async function mac(n: Native): Promise<Mac> {
  const mod = await import(pathToFileURL(out).href + "?mac=" + (++fresh)) as { store: Store; render: (t?: string) => string };
  n.page = (m) => { mod.store.secondMessage(m as { type?: string }); };
  // The real bridge: psPost sends JSON text and PS parses it (main.swift userContentController).
  mod.store.startSecond((m) => n.handle(JSON.parse(JSON.stringify(m)) as Record<string, unknown>));
  return { name: n.name, store: mod.store, render: mod.render, native: n };
}
const settle = (ms = 900) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, f: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error("gave up waiting for " + what); await settle(50); }
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const step = (m: Mac) => m.store.currentView().link.step;
const button = (html: string, label: string) => new RegExp(`<button[^>]*>${label}</button>`).test(html) || html.includes(`>${label}<`);

let n = 0;
const ok = async (name: string, fn: () => void | Promise<void>) => { await fn(); n++; console.log("ok -", name); };
const at = (ms: number, f: () => string) => { const real = Date.now; Date.now = () => real() + ms; try { return f(); } finally { Date.now = real; } };
const reset = () => { V.docs = []; V.subs.clear(); V.pokes.clear(); };
const noStepper = (h: string) => !/>(Seen|Trust)</.test(h) && !/Code on both Macs|six digit/.test(h);

try {
  // ---------- one click, the other Mac on a stale saved main Mac role ----------
  reset();
  const m4 = await mac(new Native("dev-m4", "MacBook Air M4", "Apple M4", "primary", false));
  const m1 = await mac(new Native("dev-m1", "Home M1", "Apple M1", "primary", true));
  await until("both Macs said hello", () => V.docs.filter((d) => d.kind === "sdev").length === 2);
  await settle();
  await ok("before: the page is This Mac, Your other Mac and one Pair button; no code, no Seen, Pair, Trust steps", () => {
    const h = m4.render(), t = text(h);
    assert.ok(t.includes("This Mac") && t.includes("MacBook Air M4") && t.includes("Your other Mac") && t.includes("Home M1"));
    assert.equal((h.match(/class="sw-primary"/g) ?? []).length, 1, "one big button");
    assert.ok(button(h, "Pair with my other Mac"));
    assert.ok(noStepper(h), "a stepper or a code is still there");
    assert.ok(t.includes("PS app V1.26") && t.includes("M1"), "the other Mac's chip and PS version");
  });
  m4.store.runSecondOp({ op: "pair" });
  await until("paired on both", () => step(m4) === "paired" && step(m1) === "paired");
  await settle();
  await ok("one click: both Macs paired, nothing asked on either, the M1 shows one notice", () => {
    assert.deepEqual(m4.native.questions, []); assert.deepEqual(m1.native.questions, []);
    assert.deepEqual(m1.native.notices, ["Paired with MacBook Air M4"]);
    assert.equal(m4.store.currentView().peer?.name, "Home M1");
    assert.equal(m1.store.currentView().peer?.name, "MacBook Air M4");
  });
  await ok("one click: the M1 left its stale main Mac role by itself and said hello again as the second Mac", () => {
    assert.equal(m1.native.role, "secondary");
    const d = V.docs.find((x) => x.kind === "sdev" && (x.data as { device?: string }).device === "dev-m1");
    assert.equal(JSON.parse((d?.data as { env: { body: string } }).env.body).role, "secondary");
  });
  await ok("one click: both windows show paired, the tabs fill in", () => {
    for (const m of [m4, m1]) { const h = m.render(); assert.ok(!/<span>Set up<\/span>/.test(h), `${m.name} still shows Set up`); }
    assert.ok(text(m4.render("files")).includes("Files") );
  });

  // ---------- the other Mac starts AFTER the click ----------
  reset();
  const a4 = await mac(new Native("dev-a4", "Office M4", "Apple M4", "primary", false));
  await until("said hello", () => V.docs.some((d) => d.kind === "sdev"));
  a4.store.runSecondOp({ op: "pair" });
  await until("looking", () => step(a4) === "looking");
  await ok("looking: Looking for your other Mac... with a live wait, no button to press again", () => {
    const h = a4.render(), t = text(h);
    assert.ok(t.includes("Looking for your other Mac...") && /\d+ s/.test(t));
    assert.ok(!button(h, "Pair with my other Mac"));
    assert.ok(t.includes("Looking for your other Mac") && t.includes("Pairs by itself"), "the sidebar says it too");
  });
  await ok("looking, nobody after 30 s: no more spinning, it says plainly that the other Mac has not answered", () => {
    const early = at(29_000, () => a4.render());
    assert.ok(early.includes("sw-seek") && text(early).includes("Looking for your other Mac..."));
    const h = at(31_000, () => a4.render()), t = text(h);
    assert.ok(t.includes("Your other Mac has not answered") && t.includes("Is PS app V1.26 or newer open and signed in on it? It pairs by itself once it is."), t);
    assert.ok(t.includes("keeps looking in the background"));
    assert.ok(!h.includes("sw-seek"), "still spinning after 30 s");
    assert.ok(button(h, "Try again"));
  });
  const a1 = await mac(new Native("dev-a1", "Spare M1", "Apple M1", "none", false));   // started later, no role yet
  await until("paired after the late start", () => step(a4) === "paired" && step(a1) === "paired");
  await ok("late start: the M1 that started after the click paired by itself, as the second Mac", () => {
    assert.equal(a1.native.role, "secondary");
    assert.deepEqual(a1.native.questions, []);
    assert.deepEqual(a1.native.notices, ["Paired with Office M4"]);
  });
  await ok("hello: everything the page asks PS to sign goes as PS reads it (1 Nov 2026: every hello was dropped)", () => {
    assert.deepEqual([...a4.native.dropped, ...a1.native.dropped], []);
    const hellos = V.docs.filter((d) => d.kind === "sdev").map((d) => JSON.parse((d.data as { env: { body: string } }).env.body).from).sort();
    assert.deepEqual(hellos, ["dev-a1", "dev-a4"]);
  });

  // ---------- the M4 on 1 Nov: PS paired, but no hello from the other Mac has arrived ----------
  reset();
  const n4 = new Native("dev-c4", "second-mac", "Apple M4", "primary", true);
  n4.trusted.push({ device: "dev-c1", name: "The developer's M1", pub: "PUB-dev-c1", role: "secondary", at: Date.now() - 30_000 });
  V.docs.push({ id: "ok-c", ws: null, kind: "spair", author: "t", updatedAt: "", data: { env: { sig: "t", by: "dev-c1", body: JSON.stringify({ v: 1, t: "pairok", id: "ok-c", from: "dev-c1", to: "dev-c4", at: Date.now() - 30_000,
    primary: "dev-c4", primaryPub: "PUB-dev-c4", secondary: "dev-c1", secondaryPub: "PUB-dev-c1", names: { p: "second-mac", s: "The developer's M1" }, seek: "seek-c", auto: true }) } } });
  const c4 = await mac(n4);
  await until("PS answered the page", () => c4.store.secondLocal().native && V.docs.some((d) => d.kind === "sdev"));
  await ok("paired before any hello: the Mac PS trusts shows as paired, not Nothing yet", () => {
    V.docs = V.docs.filter((d) => !(d.kind === "sdev" && JSON.parse((d.data as { env: { body: string } }).env.body).from === "dev-c1"));
    const h = c4.render(), t = text(h);
    assert.equal(step(c4), "paired");
    assert.ok(t.includes("The developer's M1") && !t.includes("Nothing yet"), t);
    assert.ok(t.includes("The developer's M1 has not said hello since it was paired, so nothing can go to it yet. If the gear in its Tab list shows Update available, click it, then Update."), t);
    assert.ok(!t.includes("are ready"), "says ready while the other Mac cannot hear anything");
  });

  // ---------- the M4 on 1 Nov: its hello failed at each wake (VPN reconnecting) and was never tried again ----------
  const helloAt = () => { const d = V.docs.find((x) => x.kind === "sdev" && (x.data as { device?: string }).device === "dev-c4"); return d ? JSON.parse((d.data as { env: { body: string } }).env.body).at as number : 0; };
  const realNow = Date.now, realTimeout = globalThis.setTimeout;
  try {
    // Ten minutes later; the 30 s retry runs at once here.
    let shift = 10 * 60_000;
    Date.now = () => realNow() + shift;
    (globalThis as { setTimeout: unknown }).setTimeout = ((f: () => void, ms?: number) => realTimeout(f, (ms ?? 0) >= 30_000 ? 30 : ms)) as typeof setTimeout;
    const first = helloAt();
    V.failPuts = 1;
    c4.store.secondMessage({ type: "second", me: { device: "dev-c4", name: n4.name, model: "MacBook Air", pub: n4.pub, role: "primary", chip: n4.chip, chosen: true, app: n4.app }, trusted: n4.trusted, seeks: [], wake: true } as never);
    await until("the hello said again after the failed save", () => helloAt() > first);
    await ok("wake: a hello the vault refused (VPN still reconnecting) is tried again, not dropped until the next wake", () => {
      assert.equal(V.failPuts, 0, "the first save did fail");
      assert.ok(helloAt() > first);
    });
    // Seven hours on, no wake, no change: the next pass says hello again, so the other Mac sees this one is on.
    const second = helloAt();
    shift = 7 * 3_600_000 + 20 * 60_000;
    V.subs.forEach((l) => l());
    await until("the 6 hour hello", () => helloAt() > second);
    await ok("6 hours: the hello is said again without a wake (it never was: a hello already said returned at once)", () => {
      assert.ok(helloAt() - second >= 6 * 3_600_000);
    });
  } finally { Date.now = realNow; (globalThis as { setTimeout: unknown }).setTimeout = realTimeout; }

  // ---------- an older PS, and Second Computer off, on the other Mac ----------
  reset();
  const b4 = await mac(new Native("dev-b4", "Solo M4", "Apple M4", "primary", false));
  // The M1 on V1.24 said hello once (no app in V1.24's hello; its heartbeat says V1.24) and never answers a seek.
  V.docs.push({ id: "old-m1", ws: null, kind: "sdev", author: "t", updatedAt: "", data: { device: "dev-old", env: { sig: "t", by: "dev-old", body: JSON.stringify({ v: 1, t: "dev", id: "d-old", from: "dev-old", to: "all", at: Date.now() - 3 * 3_600_000, name: "Home M1", role: "none", pub: "PUB-old" }) } } });
  V.docs.push({ id: "old-st", ws: null, kind: "sstat", author: "t", updatedAt: "", data: { device: "dev-old", env: { sig: "t", by: "dev-old", body: JSON.stringify({ v: 1, t: "stat", id: "s-old", from: "dev-old", to: "all", at: Date.now() - 2 * 3_600_000, app: "1.24", cpu: 1, busy: null, queue: 0, have: {} }) } } });
  V.subs.forEach((l) => l());
  await settle();
  await ok("older PS: before the click it already says the M1 is on V1.24 and to update it", () => {
    const t = text(b4.render());
    assert.ok(t.includes("Home M1 is on V1.24. Update PS app there first: it pairs by itself after."), t);
    assert.ok(t.includes("PS app V1.24"));
  });
  b4.store.runSecondOp({ op: "pair" });
  await until("looking", () => step(b4) === "looking");
  await ok("older PS: after 30 s of looking, the same reason", () => {
    assert.ok(text(at(50_000, () => b4.render())).includes("Home M1 is on V1.24. Update PS app there first"));
  });
  V.docs = V.docs.filter((d) => !d.id.startsWith("old-"));
  V.docs.push({ id: "off-m1", ws: null, kind: "sdev", author: "t", updatedAt: "", data: { off: true, why: "its Second Computer key could not be saved in the Keychain", name: "Home M1", chip: "Apple M1", app: "1.26", at: Date.now() - 60_000 } });
  V.subs.forEach((l) => l());
  await settle();
  await ok("off there: the M1 runs PS but its Second Computer could not start, said in so many words", () => {
    assert.ok(text(at(50_000, () => b4.render())).includes("Home M1 runs PS, but Second Computer is off there: its Second Computer key could not be saved in the Keychain."));
  });
  await ok("off here: a Mac whose Second Computer could not start says so for the other Mac (unsigned, display only)", async () => {
    reset();
    const nat = new Native("dev-x", "Broken M1", "Apple M1", "secondary", false);
    const x = await mac(nat);
    x.store.secondMessage({ type: "second", me: null, trusted: [], off: { why: "its Second Computer key could not be saved in the Keychain", name: "Broken M1", chip: "Apple M1", app: "1.26" } } as never);
    await until("the off record", () => V.docs.some((d) => (d.data as { off?: boolean }).off));
    assert.ok(text(x.render()).includes("Second Computer is off here"));
  });

  // ---------- the second Mac waits; a day old request is ignored ----------
  reset();
  const c1 = await mac(new Native("dev-c1", "Late M1", "Apple M1", "secondary", false));
  await until("said hello", () => V.docs.some((d) => d.kind === "sdev"));
  await settle();
  await ok("waiting: the second Mac says to click Pair on the main Mac, nothing to press here", () => {
    const h = c1.render(), t = text(h);
    assert.ok(t.includes("Waiting for your main Mac") && t.includes("Click Pair on your main Mac: this Mac connects by itself."));
    assert.ok(!button(h, "Pair with my other Mac") && noStepper(h));
  });
  V.docs.push({ id: "old-seek", ws: null, kind: "spair", author: "t", updatedAt: "", data: { env: { sig: "t", by: "dev-c4", body: JSON.stringify({
    v: 1, t: "seek", id: "s-old", from: "dev-c4", to: "all", at: Date.now() - 25 * 3_600_000, primary: "dev-c4", primaryPub: "PUB-dev-c4", names: { p: "Gone M4" } }) } } });
  V.subs.forEach((l) => l());
  await settle(1200);
  await ok("a Pair from 25 hours ago is not answered", () => {
    assert.equal(c1.native.trusted.length, 0);
    assert.equal(step(c1), "waiting");
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${n} passed`);
process.exit(0);
