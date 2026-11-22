// Run: node --experimental-strip-types tests/stage-key.test.ts
// PS 1.74 check: a stage edit, move or remove from the Mac's Tab list went to the main page by place (stage 2), and
// ran there on the newest copy. When the Tab list's copy is out of date (a stage moved or removed on the phone or the website,
// or a save of its own still on its way while the main page reloads) the place points at another stage: the wrong stage is
// removed or renamed. Stages have a key; the op now carries it and the main page finds the stage again by it. The real
// core/clientsact.ts runs here, with a fake vault. FICTIONAL data only.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const dir = realpathSync(mkdtempSync(join(tmpdir(), "ps-zzc-stage-")));
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
export const privOf = () => undefined;
export async function updateProject(id, patch) { const d = DB.get(id); if (!d) return; d.data = typeof patch === "function" ? patch(structuredClone(d.data)) : { ...d.data, ...patch }; }
export async function updatePrivate() {} export async function toggleTodo() {} export async function setTodoDone() {}
export async function updateTodo() {} export async function deleteTodo() {} export async function addTodo() { return "t"; }
export async function addClient() { return "c"; } export async function addProject() { return "p"; } export async function updateClient() {}
`);
writeFileSync(entry, `export * from ${JSON.stringify(root + "src/core/clientsact.ts")}; export { DB } from ${JSON.stringify(vaultShim)};`);
await build({
  plugins: [{ name: "shims", setup(b) {
    b.onResolve({ filter: /^\.\/vault$/ }, (a) => a.importer.endsWith("clientsact.ts") ? { path: vaultShim } : undefined);
    b.onResolve({ filter: /^\.\/actions$/ }, (a) => a.importer.endsWith("clientsact.ts") ? { path: actShim } : undefined);
  } }],
  entryPoints: [entry], outfile: out, bundle: true, format: "esm", platform: "node", logLevel: "silent",
});
const M = await import(pathToFileURL(out).href);
const { cleanClientsOp } = await import("../src/core/clientsop.ts");

const P = "1c8e2d0f-aaaa-4bbb-8ccc-9dddeeeeffff";
const st = (key: string, name: string) => ({ key, name, start: null, due: null, doneAt: null, previews: [] });
const A = st("aaaa1111aaaa", "Plan"), B = st("bbbb2222bbbb", "Build"), C = st("cccc3333cccc", "Launch");
const project = (stages: unknown[]) => M.DB.set(P, { id: P, kind: "project", data: { title: "Website", stages: structuredClone(stages), current: 0 } });
const names = () => M.DB.get(P).data.stages.map((s: { name: string }) => s.name);
/** The Tab list makes the op on its copy (tabCopy), the main page runs it on the newest copy (newest). */
async function stale(tabCopy: unknown[], newest: unknown[], fn: () => unknown) {
  const sent: unknown[] = [];
  project(tabCopy);
  M.setClientsRelay((op: unknown) => sent.push(JSON.parse(JSON.stringify(op))));
  await fn();
  M.setClientsRelay(null);
  project(newest);
  for (const o of sent) { const c = cleanClientsOp(o); assert.ok(c, "the main window takes the op"); await M.runClientsOp(c); }
}
let n = 0;
const ok = async (name: string, fn: () => unknown) => { await fn(); n++; console.log("ok", name); };

await ok("Remove on Plan, from a Tab list that has not seen Plan moved to second place: Plan goes, Build stays", async () => {
  await stale([A, B, C], [B, A, C], () => M.stageRemove(P, 0));
  assert.deepEqual(names(), ["Build", "Launch"]);
});
await ok("Renaming Build, from a Tab list that has not seen Plan removed: Build is renamed, never Launch", async () => {
  await stale([A, B, C], [B, C], () => M.stageEdit(P, 1, { name: "Build v2" }));
  assert.deepEqual(names(), ["Build v2", "Launch"]);
});
await ok("Later on Plan, from an out of date copy: Plan moves one place later from where it is now", async () => {
  await stale([A, B, C], [B, A, C], () => M.stageMove(P, 0, 1));
  assert.deepEqual(names(), ["Build", "Launch", "Plan"]);
});
await ok("a stage removed meanwhile is left alone: nothing else is removed or renamed", async () => {
  await stale([A, B, C], [B, C], () => M.stageRemove(P, 0));
  assert.deepEqual(names(), ["Build", "Launch"]);
  await stale([A, B, C], [B, C], () => M.stageEdit(P, 0, { name: "Gone" }));
  assert.deepEqual(names(), ["Build", "Launch"]);
});
await ok("an op without a key (an older Tab list) still works by place, and the main window and website work as before", async () => {
  project([A, B, C]);
  await M.runClientsOp(cleanClientsOp({ op: "stageRemove", id: P, i: 1 }));
  assert.deepEqual(names(), ["Plan", "Launch"]);
  project([A, B, C]);
  await M.stageEdit(P, 2, { name: "Go live" });
  assert.deepEqual(names(), ["Plan", "Build", "Go live"]);
  assert.equal(cleanClientsOp({ op: "stageRemove", id: P, i: 1, key: "../bad key" })?.key, undefined, "a key that is not a key is dropped");
});
console.log(`${n} passed`);
