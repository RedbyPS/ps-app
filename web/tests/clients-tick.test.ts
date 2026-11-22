// Run: node --experimental-strip-types tests/clients-tick.test.ts
// PS 1.74 check: a tick on a client task or a checklist step in the Tab list went to the main window as a TOGGLE. The Tab
// list shows nothing new until the main window's copy comes back (a debounce plus the trip), so a second tap in that time, or
// a tap on a copy that is already out of date (ticked on the phone a moment ago), flipped it back. The op now says which way.
// FICTIONAL data only.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const dir = realpathSync(mkdtempSync(join(tmpdir(), "ps-zzb-tick-")));
const vaultShim = join(dir, "vault.ts"), actShim = join(dir, "actions.ts"), entry = join(dir, "entry.ts"), out = join(dir, "out.mjs");
writeFileSync(vaultShim, `
export const DB = new Map();
export const STATE = { local: null };
export const NEEDS_SYNC = "This needs sync.";
export const vaultStore = { get: () => STATE };
export function doc(id) { return DB.get(id); }
export function docs(kind) { return [...DB.values()].filter((d) => d.kind === kind); }
export async function put(kind, data, o = {}) { const id = o.id ?? "x" + DB.size; DB.set(id, { id, kind, data, ws: null }); return id; }
export async function remove(id) { DB.delete(id); }
`);
writeFileSync(actShim, `
import { DB } from ${JSON.stringify(vaultShim)};
const later = () => new Promise((r) => setTimeout(r, 1));
export const privOf = (pid) => [...DB.values()].find((d) => d.kind === "pprivate" && d.data.projectId === pid);
export async function updatePrivate(pid, patch) { await later(); const d = privOf(pid); d.data = { ...d.data, ...patch }; }
export async function toggleTodo(id) { await later(); const d = DB.get(id); d.data = { ...d.data, done: !d.data.done }; }
export async function setTodoDone(id, done) { const d = DB.get(id); if (!d || !!d.data.done === done) return; await toggleTodo(id); }
export async function updateTodo() {} export async function deleteTodo() {} export async function addTodo() { return "t"; }
export async function addClient() { return "c"; } export async function addProject() { return "p"; }
export async function updateClient() {} export async function updateProject() {}
`);
writeFileSync(entry, `export * from ${JSON.stringify(root + "src/core/clientsact.ts")}; export { DB, STATE } from ${JSON.stringify(vaultShim)};`);
await build({
  plugins: [{ name: "shims", setup(b) {
    b.onResolve({ filter: /^\.\/vault$/ }, (a) => a.importer.endsWith("clientsact.ts") ? { path: vaultShim } : undefined);
    b.onResolve({ filter: /^\.\/actions$/ }, (a) => a.importer.endsWith("clientsact.ts") ? { path: actShim } : undefined);
  } }],
  entryPoints: [entry], outfile: out, bundle: true, format: "esm", platform: "node", logLevel: "silent",
});
const M = await import(pathToFileURL(out).href);
const { cleanClientsOp } = await import("../src/core/clientsop.ts");

const T = "0b9f3c1e-1111-4222-8333-944455556666", P = "1c8e2d0f-aaaa-4bbb-8ccc-9dddeeeeffff";
const reset = (taskDone: boolean, stepDone: boolean) => {
  M.DB.clear();
  M.DB.set(T, { id: T, kind: "todo", data: { title: "Send the draft", type: "once", done: taskDone } });
  M.DB.set(P, { id: P, kind: "project", data: { title: "Website", stages: [] } });
  M.DB.set("pp1", { id: "pp1", kind: "pprivate", data: { projectId: P, checklist: [{ id: "abcd1234ef56", text: "Logo", done: stepDone, at: null }] } });
};
/** What the Tab list sends, through psPost and the main window's check, then run there. */
async function tabList(fn: () => unknown) {
  const sent: unknown[] = [];
  M.setClientsRelay((op: unknown) => sent.push(JSON.parse(JSON.stringify(op))));
  await fn();
  M.setClientsRelay(null);
  for (const o of sent) { const c = cleanClientsOp(o); assert.ok(c, "the main window takes the op"); await M.runClientsOp(c); }
}
const stepDone = () => M.DB.get("pp1").data.checklist[0].done;

let n = 0;
const ok = async (name: string, fn: () => unknown) => { await fn(); n++; console.log("ok", name); };

await ok("a double tap on a client task's tick in the Tab list leaves it ticked (it used to flip back)", async () => {
  reset(false, false);
  await tabList(() => { void M.tickClientTodo(T, true); void M.tickClientTodo(T, true); });
  assert.equal(M.DB.get(T).data.done, true);
});
await ok("a tick on an out of date copy (already ticked on the phone) does not untick it", async () => {
  reset(true, false);
  await tabList(() => M.tickClientTodo(T, true));
  assert.equal(M.DB.get(T).data.done, true);
});
await ok("a double tap on a checklist step leaves it ticked, and an out of date tick does not untick it", async () => {
  reset(false, false);
  await tabList(() => { void M.checkTick(P, "abcd1234ef56", true); void M.checkTick(P, "abcd1234ef56", true); });
  assert.equal(stepDone(), true);
  reset(false, true);
  await tabList(() => M.checkTick(P, "abcd1234ef56", true));
  assert.equal(stepDone(), true);
});
await ok("an untick still unticks", async () => {
  reset(true, true);
  await tabList(() => { void M.tickClientTodo(T, false); void M.checkTick(P, "abcd1234ef56", false); });
  assert.equal(M.DB.get(T).data.done, false);
  assert.equal(stepDone(), false);
});
// Last check before the 1.74 release: the Tab list's + said nothing when a new client cannot be made.
await ok("the Tab list's +: no sync or no internet says why and sends nothing, otherwise the op goes with its id", async () => {
  const sent: { op: string; id: string }[] = [];
  M.setClientsRelay((op: { op: string; id: string }) => sent.push(op));
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const online = (v: boolean | undefined) => Object.defineProperty(globalThis, "navigator", { value: { onLine: v }, configurable: true });
  try {
    M.STATE.local = { since: "2026-11-01" };
    await assert.rejects(M.newClient("New client", 0, "2026-11-22"), /This needs sync\./);
    M.STATE.local = null;
    online(false);
    await assert.rejects(M.newClient("New client", 0, "2026-11-22"), /Connect to the internet to add a new client\./);
    assert.equal(sent.length, 0, "nothing was sent to the main window");
    online(true);
    const id = await M.newClient("New client", 0, "2026-11-22");
    assert.deepEqual(sent.map((o) => [o.op, o.id]), [["newClient", id]]);
    online(undefined);   // no answer at all counts as online
    await M.newClient("New client", 1, "2026-11-22");
    assert.equal(sent.length, 2);
  } finally {
    M.STATE.local = null; M.setClientsRelay(null);
    if (nav) Object.defineProperty(globalThis, "navigator", nav); else delete (globalThis as { navigator?: unknown }).navigator;
  }
});
await ok("the Clients screen's ticks say which way", async () => {
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(new URL("../src/clients/Tasks.tsx", import.meta.url), "utf8"), /tickClientTodo\(d\.id, !t\.done\)/);
  assert.match(readFileSync(new URL("../src/clients/ClientsScreen.tsx", import.meta.url), "utf8"), /checkTick\(id, x\.id, !x\.done\)/);
});
console.log(`${n} passed`);
