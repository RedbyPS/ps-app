// PS 1.74 check: the service worker's cache bump keeps the app files an offline start needs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { applySubOp, type Subtask } from "../src/core/subtasks.ts";

const P = process.env.PATCHED;
const read = (rel: string, alt: string) => readFileSync(P ? `${P}/${alt}` : new URL(`../${rel}`, import.meta.url), "utf8");
const mini = read("src/views/MiniTasks.tsx", "MiniTasks.tsx");
let n = 0, bad = 0;
const ok = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); n++; console.log("ok -", name); } catch (e) { bad++; console.log("FAIL -", name, "\n   ", (e as Error).message.split("\n")[0]); }
};
const AT = "2026-11-22T10:00:00.000Z";
const t = (id: string): Subtask => ({ id, title: id, done: false });

await ok("d-2 sw.js: after the v2 to v3 update the page's hashed app files are still cached for an offline start", async () => {
  const stores = new Map<string, Map<string, unknown>>();
  const open = async (k: string) => {
    if (!stores.has(k)) stores.set(k, new Map());
    const m = stores.get(k)!;
    const key = (r: unknown) => new URL(typeof r === "string" ? r : (r as { url: string }).url, "https://x.example.com").href;
    return {
      addAll: async (l: string[]) => { for (const u of l) m.set(key(u), { body: u }); },
      put: async (r: unknown, v: unknown) => { m.set(key(r), v); },
      match: async (r: unknown) => m.get(key(r)),
      keys: async () => [...m.keys()].map((url) => ({ url })),
    };
  };
  const caches = { open, keys: async () => [...stores.keys()], delete: async (k: string) => stores.delete(k), match: async () => undefined };
  // what the old v2 worker cached while the new page loaded
  const v2 = await open("cincee-vault-shell-v2");
  await v2.put("https://x.example.com/client/", { body: "new index" });
  await v2.put("https://x.example.com/client/assets/index-NEW.js", { body: "app" });
  const on: Record<string, (e: unknown) => void> = {};
  const self = { addEventListener: (k: string, f: (e: unknown) => void) => { on[k] = f; }, skipWaiting: async () => {}, clients: { claim: async () => {} } };
  vm.runInNewContext(read("public/sw.js", "sw.js"), { self, caches, URL, location: { origin: "https://x.example.com" }, fetch: async () => { throw new Error("offline"); }, Promise, console });
  const run = async (k: string) => { let w: Promise<unknown> = Promise.resolve(); on[k]({ waitUntil: (p: Promise<unknown>) => { w = p; } }); await w; };
  await run("install");
  await run("activate");
  assert.ok(!stores.has("cincee-vault-shell-v2"), "the old cache is gone");
  const v3 = stores.get("cincee-vault-shell-v3")!;
  assert.ok(v3.has("https://x.example.com/client/assets/index-NEW.js"), "the app file the cached shell needs is still there");
});

console.log(`${n} passed, ${bad} failed`);
if (bad) process.exit(1);
