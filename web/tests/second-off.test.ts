// Run: node --experimental-strip-types tests/second-off.test.ts
// 4 Nov 2026, the developer on the M4: "I click 'This is my main Mac' and nothing actually happens." After an update PS could
// not read its Second Computer key without his OK, so Second Computer was off; the panel still showed the two role
// buttons and PS dropped every click without a word (the window would not open either). Now the panel and the
// window say why it is off and offer Allow, a click while off is answered, and a click PS never answers says so.
// The real page code (src/second/store.ts, Second.tsx, SecondWindow.tsx) with a stand in PS that answers as
// ps-mac Second.swift does (V1.31). FICTIONAL data only. No network, no browser.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "ps-second-off-"));
const entry = join(dir, "entry.tsx"), out = join(dir, "page.mjs"), vaultShim = join(dir, "vault-shim.ts");
(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { __vputs: unknown[] }).__vputs = [];
writeFileSync(vaultShim, `
export const vaultStore = { get: () => ({ status: "unlocked", docs: new Map() }), subscribe: () => () => {} };
export function docs() { return []; }
const puts = globalThis.__vputs;
export async function put(kind, data, opts = {}) { puts.push({ kind, data }); return opts.id ?? "r" + puts.length; }
export async function remove() {}
export function setSecondChannel() {}
export function onSecondPoke() { return () => {}; }
export async function pokeSecond() {}
export async function putBlob() { return "b"; }
export async function getBlob() { return new Uint8Array(); }
export async function deleteBlob() {}
export type Snapshot = any;
`);
writeFileSync(entry, `
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SecondPanel, secondActions } from ${JSON.stringify(root + "src/views/Second.tsx")};
import { SecondWindow } from ${JSON.stringify(root + "src/views/SecondWindow.tsx")};
import * as st from ${JSON.stringify(root + "src/second/store.ts")};
export const store = st;
export const vaultPuts = globalThis.__vputs;
secondActions.run = st.runSecondOp;
const snap = () => ({ docs: new Map(), status: "unlocked" });
export function panel() { return renderToStaticMarkup(createElement(SecondPanel, { v: st.currentView() })); }
export function win() { return renderToStaticMarkup(createElement(SecondWindow, { s: snap() })); }
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
type Page = { store: Store; panel: () => string; win: () => string; vaultPuts: { kind: string; data: Record<string, unknown> }[] };

const WHY = "its Second Computer key needs your OK in PS app there";
/** Stands in for ps-mac Second.swift V1.31 while the key is blocked (or, `old`, for V1.30, which drops everything). */
class Native {
  got: Record<string, unknown>[] = [];
  windows = 0;
  allowFails = 1;
  ready = false; retried = false; allowing = false;
  page: (m: Record<string, unknown>) => void = () => {};
  old: boolean;
  constructor(old = false) { this.old = old; }
  say(m: Record<string, unknown>) { setTimeout(() => this.page(m), 2); }
  here() { return this.retried ? "Not allowed yet: the Keychain question was closed with Deny or Cancel. Click Allow again. When macOS asks, type your Mac login password and click Always Allow (not Allow or Deny)."
    : "After an update macOS wants your OK once before PS app can use its Second Computer key. Click Allow. macOS then asks for your Mac login password: type it and click Always Allow, so it does not ask again. Your Macs stay paired; nothing is lost."; }
  state() {
    if (this.ready) { this.say({ type: "second", me: { device: "dev-m4", name: "Fictional M4", pub: "PUB", role: "primary", chip: "Apple M4", chosen: true, app: "1.31" }, trusted: [], seeks: [], caps: [] }); return; }
    const off: Record<string, unknown> = { why: WHY, name: "Fictional M4", model: "Mac16,1", chip: "Apple M4", app: "1.31" };
    if (!this.old) Object.assign(off, { here: this.here(), retried: this.retried, allowing: this.allowing });
    this.say({ type: "second", me: null, trusted: [], off });
  }
  handle(m: Record<string, unknown>) {
    this.got.push(m);
    const t = String(m.type);
    if (t === "second:hello") { this.state(); return; }
    if (this.old || this.ready) return;
    if (t === "second:window") { this.windows++; this.state(); }
    else if (t === "second:role") { this.say({ type: "second:off", op: "role", why: this.here() }); this.state(); }
    else if (t === "second:allow") {
      this.allowing = true; this.state();
      setTimeout(() => { this.allowing = false; if (this.allowFails-- > 0) this.retried = true; else this.ready = true; this.state(); }, 20);
    }
  }
}
let fresh = 0;
async function page(n: Native): Promise<Page> {
  const mod = await import(pathToFileURL(out).href + "?p=" + (++fresh)) as Page;
  n.page = (m) => { mod.store.secondMessage(m as { type?: string }); };
  mod.store.startSecond((m) => n.handle(JSON.parse(JSON.stringify(m)) as Record<string, unknown>));
  return mod;
}
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, f: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error("gave up waiting for " + what); await settle(10); }
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

let n = 0;
const ok = async (name: string, fn: () => Promise<void> | void) => { await fn(); n++; console.log("ok -", name); };

try {
  const ps = new Native();
  const p = await page(ps);
  await until("the off state", () => !!p.store.secondLocal().off?.here);

  await ok("off: the Tab list panel says why and offers Allow, not the role buttons that PS cannot act on", () => {
    const t = text(p.panel());
    assert.ok(!t.includes("This is my main Mac") && !t.includes("This is my second Mac"), "the dead role buttons are back");
    assert.ok(t.includes("Second Computer is off") && t.includes("PS app needs your Mac password once"));
    assert.ok(t.includes("Your Macs stay paired"));
    assert.match(p.panel(), /<button type="button" class="sc-wide">Allow<\/button>/);
    assert.ok(t.includes("Open Second Computer"));
  });
  await ok("off: the window's Set up page says the same, with the same Allow", () => {
    const h = p.win(), t = text(h);
    assert.ok(t.includes("PS app needs your Mac password once") && t.includes("Click Allow") && t.includes("Mac login password"));
    assert.match(h, /<button type="button" class="sw-primary">Allow<\/button>/);
    assert.ok(!/Pair with my other Mac</.test(h), "Pair is offered while PS cannot pair");
  });
  await ok("off: the vault record the other Mac reads carries only the reason (never this Mac's own wording)", async () => {
    await until("the off record", () => p.vaultPuts.some((x) => x.kind === "sdev"));
    const rec = p.vaultPuts.find((x) => x.kind === "sdev")?.data;
    assert.ok(rec && rec.off === true && rec.why === WHY);
    assert.ok(!("here" in rec) && !("allowing" in rec) && !("retried" in rec));
  });
  await ok("off: Open Second Computer reaches PS (it opens the window even while off)", async () => {
    p.store.runSecondOp({ op: "window" });
    await until("the window", () => ps.windows === 1);
  });
  await ok("off: a role click is answered in words, never silence", async () => {
    p.store.runSecondOp({ op: "role", role: "primary" });
    await until("the answer", () => !!p.store.secondLocal().note);
    assert.ok(ps.got.some((m) => m.type === "second:role" && m.role === "primary"));
    assert.match(p.store.secondLocal().note ?? "", /Click Allow/);
  });
  await ok("Allow, and the developer closes the Keychain question: the panel says not yet and offers Allow again", async () => {
    p.store.runSecondOp({ op: "allow" });
    assert.ok(ps.got.some((m) => m.type === "second:allow"));
    assert.match(p.store.secondLocal().note ?? "", /Always Allow/);
    await until("waiting shown", () => p.store.secondLocal().off?.allowing === true);
    assert.match(p.panel(), /disabled="">Waiting for macOS\.\.\.</);
    await until("the refusal", () => p.store.secondLocal().off?.retried === true && p.store.secondLocal().off?.allowing === false);
    const t = text(p.panel());
    assert.ok(t.includes("Not allowed yet") && t.includes("Allow again"));
  });
  await ok("Allow again works: Second Computer is on, the role is primary, the panel is the normal one", async () => {
    p.store.runSecondOp({ op: "allow" });
    await until("ready", () => p.store.secondLocal().me?.role === "primary" && !p.store.secondLocal().off);
    const t = text(p.panel());
    assert.ok(!t.includes("Second Computer is off") && t.includes("Open Second Computer") && t.includes("Pair with my other Mac"));
  });

  // An older PS (V1.30) drops the click: after 8 s the page says so instead of doing nothing.
  const oldPs = new Native(true);
  const q = await page(oldPs);
  await until("the old off state", () => !!q.store.secondLocal().off);
  await ok("older PS: the panel still says why it is off (no own wording from PS) and offers Allow", () => {
    const t = text(q.panel());
    assert.ok(t.includes(`Second Computer is off on this Mac: ${WHY}.`) && !t.includes("This is my main Mac"));
  });
  await ok("a role click PS never answers says so after 8 seconds", async () => {
    q.store.setRole("primary");
    assert.equal(q.store.secondLocal().note, null);
    await settle(8_300);
    assert.match(q.store.secondLocal().note ?? "", /Second Computer is off on this Mac/);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${n} passed`);
process.exit(0);
